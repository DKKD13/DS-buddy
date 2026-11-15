/**
 * v4: reading the owner's computer. The reader (mac-reader.mjs) runs on that computer and alone decides what may be
 * read; the broker (mac-files.js) on the Mira machine only carries a request there and the answer back.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, rmSync, realpathSync, readFileSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { MacReader, MacReaderClient, maskSecrets } from '../lib/mac-reader.mjs'
import { MacFiles, macFilesMode } from '../lib/mac-files.js'
import { DeviceGateway } from '../lib/device-gateway.js'
import { createHubTools } from '../lib/hub-tools.js'
import { restrictPersonalAgent } from '../lib/personal.js'

const HOUR = 3600_000, T0 = Math.floor(Date.now() / 1000) * 1000, CHUNK = 1024 * 1024
const SECRET = 'abcd1234efgh5678', KEY = 'sk-abcdefghijklmnopqrstuvwx', MARK = '[已打码]'
/** 64 base64 characters, the same every run. */
const base64Line = i => createHash('sha384').update('line ' + i).digest('base64')
const PEM_LINES = Array.from({ length: 26 }, (_, i) => base64Line(i)), PEM_LAST = base64Line(99).slice(0, 22) + '=='
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_LINES.join('\n')}\n${PEM_LAST}\n-----END RSA PRIVATE KEY-----`
const BLOB = Array.from({ length: 79 }, (_, i) => base64Line(1000 + i)).join('').slice(0, 5000)
const filler = (n, tag) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'assistant', text: `${tag}第 ${i} 条普通内容，没有什么特别的` }))
const SESSION = [
  ...filler(12, '前'),
  JSON.stringify({ type: 'user', text: '帮我看看昨天的会议纪要' }),
  JSON.stringify({ type: 'assistant', text: 'Hello World，这是回复' }),
  JSON.stringify({ type: 'tool', text: `config loaded "api_key": "${SECRET}" and ${KEY} done` }),
  ...filler(12, '后'),
  JSON.stringify({ type: 'user', text: '最后收尾一下' }),
].join('\n') + '\n'
const CHINESE = '中文句子。'.repeat(400)
/** Every stretch of `length` characters of `text`: none of them may ever be shown. */
const windows = (text, length) => Array.from({ length: text.length - length + 1 }, (_, i) => text.slice(i, i + length))
const SECRET_PARTS = [...windows(SECRET, 5), ...windows(KEY.slice(3), 5)]
const PEM_PARTS = [...PEM_LINES.flatMap(line => [line.slice(0, 16), line.slice(-16)]), PEM_LAST.slice(0, 16)]
/** The files a reader may show, newest first. */
const VISIBLE = ['a/session-1.jsonl', 'b/big.jsonl', 'b/image.bin', 'b/chinese.txt', 'b/empty.txt', 'b/pem.txt', 'a/old.jsonl']
const HIDDEN = ['.env', 'kth.env', 'keys/id_rsa', '.ssh/config', 'auth.json', 'sub/secrets.yaml', 'notes.pem']

function folder(t, prefix = 'mira-reader-') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const put = (rel, content, hoursAgo = 1) => {
    const file = join(base, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
    const at = new Date(T0 - hoursAgo * HOUR)
    utimesSync(file, at, at)
    return file
  }
  return { base, put }
}

function fixture(t, options = {}) {
  const { base, put } = folder(t)
  const root = join(base, 'records')
  put('records/a/session-1.jsonl', SESSION, 1)
  put('records/b/big.jsonl', JSON.stringify({ note: 'MARKER-ONE', image: BLOB, after: 'MARKER-TWO' }) + '\n', 2)
  put('records/b/image.bin', Buffer.concat([Buffer.from([0x89, 0x50, 0, 0, 1, 2]), Buffer.from('hello world inside a binary file')]), 3)
  put('records/b/chinese.txt', CHINESE, 4)
  put('records/b/empty.txt', '', 5)
  put('records/b/pem.txt', `这里是一段说明文字，下面是密钥。\n${PEM}\n后面还有一段说明文字。\n`, 6)
  put('records/a/old.jsonl', JSON.stringify({ type: 'user', text: 'an older hello world line' }) + '\n', 720)
  for (const rel of HIDDEN) put('records/' + rel, 'TOPSECRET=hunter2-value-xyz\n')
  put('outside/secret.txt', 'TOPSECRET outside the folder\n')
  symlinkSync(join(base, 'outside', 'secret.txt'), join(root, 'link-out'))
  symlinkSync(join(base, 'outside'), join(root, 'link-dir'))
  const log = join(base, 'reader.log')
  const reader = new MacReader({ roots: [{ name: 'records', label: '对话记录', path: root }], logFile: log, maxRequests: 100_000, ...options })
  return { base, root, log, reader, put }
}

/** The reader said no in words the asker may see. */
const refused = (promise, pattern) => assert.rejects(promise, error => {
  assert.equal(error.expected, true, error.message)
  assert.match(error.message, pattern)
  return true
})

const until = async (check, ms = 5000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('the reader lists only real files and folders of an allowed folder, and never tells where the folder is', async t => {
  const f = fixture(t)
  assert.deepEqual(f.reader.describe(), [{ name: 'records', label: '对话记录' }])
  assert.deepEqual(await f.reader.handle('roots', {}), { roots: [{ name: 'records', label: '对话记录' }] })
  const top = await f.reader.handle('list', { root: 'records' })
  // Key files, the key folder and both links are simply not there.
  assert.deepEqual(top.entries.map(e => e.name).sort(), ['a', 'b', 'keys', 'sub'])
  assert.deepEqual([top.path, top.total, top.truncated], ['', 4, false])
  assert.ok(top.entries.every(e => e.dir === true && e.size === undefined))
  assert.deepEqual((await f.reader.handle('list', { root: 'records', path: 'keys' })).entries, [])
  const a = await f.reader.handle('list', { root: 'records', path: 'a' })
  assert.deepEqual(a.entries, [
    { name: 'session-1.jsonl', dir: false, size: Buffer.byteLength(SESSION), mtime: new Date(T0 - HOUR).toISOString() },
    { name: 'old.jsonl', dir: false, size: statSync(join(f.root, 'a/old.jsonl')).size, mtime: new Date(T0 - 720 * HOUR).toISOString() },
  ], 'newest first')
  const one = await f.reader.handle('list', { root: 'records', path: 'a', limit: 1 })
  assert.deepEqual([one.entries.length, one.total, one.truncated], [1, 2, true])
  await refused(f.reader.handle('list', { root: 'records', path: 'a/old.jsonl' }), /这是文件/)
  for (const answer of [top, a, await f.reader.handle('search', { root: 'records' })]) assert.ok(!JSON.stringify(answer).includes(f.base), 'no local path in an answer')
})

test('the reader refuses whatever leads out of the folder or to a place that holds keys', async t => {
  const f = fixture(t)
  for (const path of ['../outside/secret.txt', join(f.base, 'outside/secret.txt'), '/etc/hosts', 'link-out', 'link-dir/secret.txt', 'a/../../outside'])
    for (const op of ['read', 'list', 'search']) await refused(f.reader.handle(op, { root: 'records', path, query: 'TOPSECRET' }), /必须在这个文件夹里面/)
  // A path outside the folder gets the same answer whether or not it exists, so nothing outside can be probed.
  await refused(f.reader.handle('read', { root: 'records', path: '../outside/no-such-file.txt' }), /必须在这个文件夹里面/)
  await refused(f.reader.handle('list', { root: 'records', path: '../../no-such-folder' }), /必须在这个文件夹里面/)
  for (const path of HIDDEN) for (const op of ['read', 'search']) await refused(f.reader.handle(op, { root: 'records', path, query: 'TOPSECRET' }), /密钥/)
  await refused(f.reader.handle('list', { root: 'records', path: '.ssh' }), /密钥/)
  await refused(f.reader.handle('read', { root: 'nope', path: 'a' }), /没有名为「nope」/)
  await refused(f.reader.handle('read', { path: 'a/old.jsonl' }), /要先用 root 说明/)
  await refused(f.reader.handle('read', { root: { name: 'records' }, path: 'a/old.jsonl' }), /要先用 root 说明/)
  await refused(f.reader.handle('read', { root: 'records', path: 'a/missing.jsonl' }), /没有这个文件或目录/)
  await refused(f.reader.handle('read', { root: 'records', path: 'a\0b' }), /path 无效/)
  await refused(f.reader.handle('list', { root: 'records', path: 5 }), /path 无效/)
  await refused(f.reader.handle('write', { root: 'records', path: 'a/new.txt' }), /op 只能是/)
  await refused(f.reader.handle('constructor', {}), /op 只能是/)
  await refused(f.reader.handle('read', null), /参数无效/)
  // What is hidden is hidden from a search too: by content and by name.
  const byContent = await f.reader.handle('search', { root: 'records', query: 'TOPSECRET' })
  assert.deepEqual([byContent.files, byContent.complete, byContent.totalFiles], [[], true, VISIBLE.length])
  assert.equal((await f.reader.handle('search', { root: 'records', name: 'env' })).total, 0)
  assert.deepEqual((await f.reader.handle('search', { root: 'records', name: 'pem' })).files.map(file => file.path), ['b/pem.txt'])
  // Every request is noted on this machine, in a private file, without what was read.
  const log = readFileSync(f.log, 'utf8')
  assert.match(log, / read "records \.env q=TOPSECRET" refused: 这个位置存的是密钥/)
  assert.match(log, / read "records a\/missing\.jsonl" refused: 没有这个文件或目录\n/)
  assert.match(log, / search "records q=TOPSECRET" ok\n/)
  assert.ok(!log.includes('hunter2-value-xyz'))
  assert.equal(statSync(f.log).mode & 0o077, 0)
})

test('a search finds files by content, by name and by time, newest first, and shows a masked snippet', async t => {
  const f = fixture(t), search = args => f.reader.handle('search', { root: 'records', ...args })
  const found = await search({ query: 'hello world' })
  assert.deepEqual(found.files.map(file => file.path), ['a/session-1.jsonl', 'a/old.jsonl'], 'either case; the binary file is not text')
  assert.deepEqual([found.complete, found.scannedFiles, found.totalFiles, found.continueWith, found.unfinished], [true, VISIBLE.length, VISIBLE.length, undefined, undefined])
  const [hit] = found.files[0].hits
  assert.match(hit.snippet, /Hello World，这是回复/)
  assert.ok(hit.snippet.includes(MARK) && !SECRET_PARTS.some(part => hit.snippet.includes(part)), hit.snippet)
  // The place of a hit is where a read can start.
  const from = await f.reader.handle('read', { root: 'records', path: 'a/session-1.jsonl', offset: hit.offset, max_bytes: 500 })
  assert.ok(from.text.startsWith('Hello World，这是回复'))
  assert.deepEqual((await search({ query: '收尾' })).files.map(file => file.path), ['a/session-1.jsonl'])
  // A key's name can be searched; the key itself, embedded data and a key file's body cannot be guessed by searching.
  const named = await search({ query: 'api_key' })
  assert.ok(named.files[0].hits[0].snippet.includes('api_key') && named.files[0].hits[0].snippet.includes(MARK))
  for (const query of [SECRET, SECRET.slice(4, 12), KEY, 'abcdefghijklmnop', BLOB.slice(1000, 1020), PEM_LINES[5].slice(10, 30), PEM_LAST.slice(0, 12)])
    assert.deepEqual((await search({ query })).files, [], query)
  assert.deepEqual((await search({ name: 'OLD' })).files, [{ path: 'a/old.jsonl', size: statSync(join(f.root, 'a/old.jsonl')).size, mtime: new Date(T0 - 720 * HOUR).toISOString() }])
  const all = await search({ path: '', query: '', name: '', since: '', until: '' })
  assert.deepEqual([all.files.map(file => file.path), all.total, all.complete, all.truncated], [VISIBLE, VISIBLE.length, true, false], 'a parameter left empty is a parameter left out')
  assert.deepEqual((await search({ limit: 2 })).files.map(file => file.path), VISIBLE.slice(0, 2))
  assert.equal((await search({ limit: 2 })).truncated, true)
  assert.deepEqual((await search({ since: new Date(T0 - 48 * HOUR).toISOString() })).files.map(file => file.path), VISIBLE.slice(0, 6))
  assert.deepEqual((await search({ until: new Date(T0 - 240 * HOUR).toISOString() })).files.map(file => file.path), ['a/old.jsonl'])
  assert.deepEqual((await search({ query: 'hello world', since: new Date(T0 - 48 * HOUR).toISOString() })).files.map(file => file.path), ['a/session-1.jsonl'])
  await refused(search({ since: 'yesterday' }), /ISO 8601/)
  await refused(search({ query: 'x' }), /2 到 200/)
  await refused(search({ query: 'x'.repeat(201) }), /2 到 200/)
  const single = await search({ path: 'a/old.jsonl', query: 'HELLO' })
  assert.deepEqual([single.totalFiles, single.files.length, single.complete], [1, 1, true])
  assert.deepEqual((await search({ path: 'b/image.bin', query: 'hello world' })).files, [])
  assert.deepEqual((await search({ path: 'b', query: 'hello world' })).files, [])
})

test('a read gives a stretch of text and where to carry on; keys and embedded data never come out, wherever it starts', async t => {
  const f = fixture(t), read = args => f.reader.read({ root: 'records', ...args })
  const size = Buffer.byteLength(SESSION)
  const whole = await f.reader.handle('read', { root: 'records', path: 'a/session-1.jsonl' })
  assert.deepEqual([whole.path, whole.size, whole.offset, whole.nextOffset, whole.eof, whole.mtime], ['a/session-1.jsonl', size, 0, size, true, new Date(T0 - HOUR).toISOString()])
  assert.equal(whole.text, SESSION.replace(SECRET, MARK).replace(KEY, 'sk' + MARK), 'the key is masked, its name stays')
  // Starting or stopping in the middle of a key shows none of it.
  for (let offset = 0; offset <= size; offset++) {
    const { text } = await read({ path: 'a/session-1.jsonl', offset, max_bytes: 500 })
    const leaked = SECRET_PARTS.find(part => text.includes(part))
    assert.equal(leaked, undefined, `offset ${offset} shows ${leaked}`)
  }
  const pemSize = statSync(join(f.root, 'b/pem.txt')).size
  for (let offset = 0; offset <= pemSize; offset += 7) {
    const { text } = await read({ path: 'b/pem.txt', offset, max_bytes: 500 })
    const leaked = PEM_PARTS.find(part => text.includes(part))
    assert.equal(leaked, undefined, `offset ${offset} shows ${leaked}`)
  }
  const pem = await read({ path: 'b/pem.txt' })
  assert.equal(pem.text, `这里是一段说明文字，下面是密钥。\n${MARK}\n后面还有一段说明文字。\n`)
  const big = await read({ path: 'b/big.jsonl' })
  assert.equal(big.text, '{"note":"MARKER-ONE","image":"[略过 5000 字节的编码数据]","after":"MARKER-TWO"}\n')
  assert.equal(big.eof, true)
  // Reading on from nextOffset loses nothing and never cuts a character in half.
  let text = '', offset = 0, rounds = 0
  for (;;) {
    const part = await read({ path: 'b/chinese.txt', offset, max_bytes: 500 })
    assert.ok(part.eof || part.nextOffset > offset)
    assert.ok(!part.text.includes('�'))
    text += part.text;offset = part.nextOffset;rounds++
    if (part.eof) break
  }
  assert.equal(text, CHINESE)
  assert.ok(rounds >= 12, String(rounds))
  assert.ok((await read({ path: 'b/chinese.txt', offset: 1, max_bytes: 500 })).text.startsWith('文句子。'), 'an offset inside a character starts at the next one')
  assert.equal((await read({ path: 'b/chinese.txt', max_bytes: 1 })).nextOffset, 498, 'at least 500 bytes a time')
  assert.deepEqual([await read({ path: 'a/session-1.jsonl', offset: size })].map(r => [r.text, r.eof, r.nextOffset]), [['', true, size]])
  assert.deepEqual([await read({ path: 'b/empty.txt' })].map(r => [r.text, r.eof, r.size]), [['', true, 0]])
  await refused(read({ path: 'b/image.bin' }), /不是文本文件/)
  for (const bad of [size + 1, -1, 1.5, '3']) await refused(read({ path: 'a/session-1.jsonl', offset: bad }), /offset 要在 0 到/)
  await refused(read({}), /read 需要 path/)
  await refused(read({ path: '' }), /read 需要 path/)
  await refused(read({ path: 'a' }), /这不是文件/)
})

test('a folder that is too wide, holds keys or is not a folder cannot be allowed at all', t => {
  const f = fixture(t)
  const allow = (...roots) => () => new MacReader({ roots })
  const ok = { name: 'records', label: '对话记录', path: f.root }
  symlinkSync(homedir(), join(f.base, 'home-link'))
  for (const path of [homedir(), dirname(homedir()), '/', join(f.base, 'home-link')]) assert.throws(allow({ ...ok, path }), /太宽/)
  assert.throws(allow({ ...ok, path: join(f.root, '.ssh') }), /存密钥/)
  assert.throws(allow(ok, ok), /无效或重复/)
  for (const name of ['Records', '1st', 'a b', '', undefined, 'x'.repeat(33)]) assert.throws(allow({ ...ok, name }), /无效或重复/)
  for (const label of [undefined, '', '   ', 'x'.repeat(61)]) assert.throws(allow({ ...ok, label }), /说明/)
  assert.throws(allow({ ...ok, path: join(f.root, 'a/old.jsonl') }), /不是文件夹/)
  assert.throws(allow({ ...ok, path: join(f.base, 'nope') }), /ENOENT/)
  assert.throws(allow(), /1 到 20/)
  assert.throws(() => new MacReader({ roots: Array.from({ length: 21 }, (_, i) => ({ ...ok, name: 'r' + i })) }), /1 到 20/)
  assert.throws(() => new MacReader({}), /1 到 20/)
  // A link to a folder is allowed as the folder it leads to.
  symlinkSync(f.root, join(f.base, 'records-link'))
  assert.deepEqual(allow({ ...ok, path: join(f.base, 'records-link') })().describe(), [{ name: 'records', label: '对话记录' }])
})

test('the reader answers only so many requests in a while', async t => {
  let clock = 1_000_000
  const f = fixture(t, { now: () => clock, maxRequests: 3, windowMs: 60_000 })
  for (let i = 0; i < 3; i++) await f.reader.handle('roots', {})
  await refused(f.reader.handle('roots', {}), /太频繁/)
  await refused(f.reader.handle('read', { root: 'records', path: 'a/old.jsonl' }), /太频繁/)
  clock += 61_000
  assert.equal((await f.reader.handle('read', { root: 'records', path: 'a/old.jsonl' })).eof, true)
  assert.match(readFileSync(f.log, 'utf8'), /refused: 读得太频繁了/)
})

test('a search that runs out of time says where to carry on; carrying on repeats nothing and skips nothing', async t => {
  const { base, put } = folder(t, 'mira-reader-many-')
  // Newest first: f1, then f2 and f3 changed in the same second, then f4, f5, f6.
  for (const [name, hours] of Object.entries({ f1: 1, f2: 2, f3: 2, f4: 3, f5: 4, f6: 5 })) put(name + '.txt', `in ${name}: needle-word here\n`, hours)
  const roots = [{ name: 'many', label: '很多文件', path: base }], names = [1, 2, 3, 4, 5, 6].map(i => `f${i}.txt`)
  const chain = async (reader, args) => {
    const answers = []
    for (let until; answers.length < 10;) {
      const answer = await reader.search({ root: 'many', query: 'needle-word', until, ...args })
      answers.push(answer)
      if (!answer.continueWith) break
      until = answer.continueWith.until
    }
    return answers
  }
  // A clock that moves a second each time it is read: the 1.5 s allowance is gone after two files.
  let tick = 0
  const slow = await chain(new MacReader({ roots, now: () => (tick += 1000), budgetMs: 1500 }))
  assert.deepEqual(slow.map(a => [a.scannedFiles, a.totalFiles, a.complete]), [[3, 6, false], [2, 3, false], [1, 1, true]], 'files of the same time stay together')
  assert.deepEqual(slow.flatMap(a => a.files.map(file => file.path)), names)
  assert.equal(slow[0].continueWith.until, new Date(T0 - 2 * HOUR - 1).toISOString())
  // With no time at all, each call still searches one file (or one group of the same time), so it always gets on.
  const stuck = await chain(new MacReader({ roots, now: () => (tick += 1e6), budgetMs: 10 }))
  assert.deepEqual(stuck.map(a => a.scannedFiles), [1, 2, 1, 1, 1])
  assert.deepEqual(stuck.flatMap(a => a.files.map(file => file.path)), names)
  // Enough found is the other reason to stop.
  const pages = await chain(new MacReader({ roots }), { limit: 1 })
  assert.deepEqual(pages.map(a => a.files.map(file => file.path)), [['f1.txt'], ['f2.txt', 'f3.txt'], ['f4.txt'], ['f5.txt'], ['f6.txt']])
  assert.deepEqual(pages.map(a => a.complete), [false, false, false, false, true])
  const once = await new MacReader({ roots }).search({ root: 'many', query: 'NEEDLE-word' })
  assert.deepEqual([once.files.map(file => file.path), once.complete, once.continueWith], [names, true, undefined])
})

test('a file too large to search in time is reported as unfinished, not as searched', async t => {
  const { base, put } = folder(t, 'mira-reader-huge-')
  const line = 'lorem ipsum dolor sit amet, consectetur adipiscing elit\n'
  const plain = 'needle-first is here\n' + line.repeat(Math.ceil(2.5 * CHUNK / line.length))
  // One needle lies across the first 1 MiB boundary of the file, one at its very end.
  const at = CHUNK - 5, text = plain.slice(0, at) + 'BOUNDARY-NEEDLE' + plain.slice(at + 15) + 'needle-last is here\n'
  put('huge.txt', text)
  const roots = [{ name: 'big', label: '大文件', path: base }]
  const reader = new MacReader({ roots })
  const last = await reader.search({ root: 'big', query: 'needle-last' })
  assert.deepEqual([last.complete, last.unfinished, last.files[0].hits.map(hit => hit.offset)], [true, undefined, [text.indexOf('needle-last')]])
  const across = await reader.search({ root: 'big', query: 'boundary-needle' })
  assert.deepEqual(across.files[0].hits.map(hit => hit.offset), [at])
  assert.match(across.files[0].hits[0].snippet, /BOUNDARY-NEEDLE/)
  // Time runs out after the second 1 MiB.
  let reads = 0
  const hurried = new MacReader({ roots, now: () => ++reads > 2 ? 1e9 : 1000, budgetMs: 100 })
  const missed = await hurried.search({ root: 'big', query: 'needle-last' })
  assert.deepEqual([missed.files, missed.unfinished, missed.complete, missed.scannedFiles, missed.continueWith], [[], ['huge.txt'], false, 1, undefined])
  reads = 0
  const partly = await hurried.search({ root: 'big', query: 'needle-first' })
  assert.deepEqual([partly.files.map(file => [file.path, file.partial, file.hits[0].offset]), partly.complete, partly.unfinished], [[['huge.txt', true, 0]], false, undefined])
})

test('what looks like a key is masked and ordinary prose is left alone', () => {
  for (const [text, masked] of [
    [`key ${KEY} end`, `key sk${MARK} end`],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456_-xyz.', `jwt ${MARK}.`],
    ['Authorization: Bearer abcdefghijklmnop1234', `Authorization: Bearer${MARK}`],
    ['{"app_secret": "Zx9Yw8Vu7Ts6Rq5P"}', `{"app_secret": "${MARK}"}`],
    ['{\\"app_secret\\":\\"Zx9Yw8Vu7Ts6Rq5P\\"}', `{\\"app_secret\\":\\"${MARK}\\"}`],
    ['open https://x.test/cb?code=abc123def456&state=1 now', `open https://x.test/cb?code=${MARK}&state=1 now`],
    ['aws AKIAABCDEFGHIJKLMNOP.', `aws ${MARK}.`],
    ['git ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok', `git ghp${MARK} ok`],
    ['password=hunter2hunter2', `password=${MARK}`],
    ['export LLM_API_KEY=abcdef1234567890', `export LLM_API_KEY=${MARK}`],
    [`before\n${PEM}\nafter`, `before\n${MARK}\nafter`],
    // A key body without its first line (a file read from the middle), also as it looks inside a JSON string.
    [`${PEM_LINES.join('\n')}\n${PEM_LAST}\n-----END RSA PRIVATE KEY-----`, `${MARK}\n-----END RSA PRIVATE KEY-----`],
    [JSON.stringify(PEM_LINES.join('\n') + '\n' + PEM_LAST), `"${MARK}"`],
  ]) assert.equal(maskSecrets(text), masked)
  for (const prose of ['今天把 token 的用法讲清楚了，max_tokens: 4096，没有密钥。', '{"input_tokens":1234,"output_tokens":56}', 'The secret of good design is restraint; the key: keep it simple.', 'sk-short and a path /Users/someone/project/file.txt'])
    assert.equal(maskSecrets(prose), prose)
})

const sha = value => createHash('sha256').update(value).digest('hex')
const TOKEN = 'device-token-for-tests-0123456789', TOKEN2 = 'second-device-token-9876543210'
const ROOTS = [{ name: 'records', label: '对话记录' }]

/** The device entrance with the broker behind it, as index.js wires them. */
async function entrance(t, options = {}) {
  const hub = { events: [] }
  const hubStore = { get: () => hub, append: (_id, event) => { hub.events.push(event) } }
  const files = options === null ? undefined : new MacFiles({ hubStore, ...options })
  const gateway = new DeviceGateway({ observations: { hello: deviceId => ({ ok: true, deviceId }) }, files, logger: { warn() {} },
    devices: [{ deviceId: 'mac-1', name: '我的 Mac', tokenSha256: sha(TOKEN) }, { deviceId: 'mac-2', name: '另一台', tokenSha256: sha(TOKEN2) }] })
  const port = await gateway.listen(0)
  t.after(async () => { const closed = gateway.close();gateway.server.closeAllConnections();await closed })
  const post = (path, body, token = TOKEN) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })
  /** One wait for work by a reader that is not the real one. */
  const poll = async (token = TOKEN) => (await post('/api/desktop/files/poll', { roots: ROOTS }, token)).json()
  const answer = async (body, token = TOKEN) => (await post('/api/desktop/files/result', body, token)).json()
  return { hub, hubStore, files, gateway, port, post, poll, answer, url: `http://127.0.0.1:${port}/` }
}

test('the whole way: the assistant side asks, the reader on the computer answers through the device entrance', async t => {
  const f = fixture(t), clock = { skew: 0 }
  const e = await entrance(t, { holdMs: 300, timeoutMs: 5000, now: () => Date.now() + clock.skew })
  assert.deepEqual(await e.files.request('roots'), { ok: false, error: 'offline', hint: (await e.files.request('roots')).hint }, 'no reader yet')
  const client = new MacReaderClient({ reader: f.reader, serverUrl: e.url, token: () => TOKEN, holdMs: 3000 })
  const running = client.run()
  t.after(() => client.stop())
  await until(() => e.files.status().connected)
  const status = e.files.status()
  assert.deepEqual([status.mode, status.connected, status.device, status.roots], ['on', true, '我的 Mac', ROOTS])
  // What comes back is marked as text that is not the owner speaking.
  assert.deepEqual(await e.files.request('roots'), { ok: true, trust: 'untrusted', device: '我的 Mac', data: { roots: ROOTS } })
  const read = await e.files.request('read', { root: 'records', path: 'a/old.jsonl' })
  assert.deepEqual([read.ok, read.data.eof], [true, true])
  assert.match(read.data.text, /an older hello world line/)
  const found = await e.files.request('search', { root: 'records', query: 'hello world', limit: 5 })
  assert.deepEqual(found.data.files.map(file => file.path), ['a/session-1.jsonl', 'a/old.jsonl'])
  // A model fills what it does not use with "" or null.
  const listed = await e.files.request('list', { root: 'records', path: '', query: null, name: '', limit: undefined })
  assert.deepEqual(listed.data.entries.map(entry => entry.name).sort(), ['a', 'b', 'keys', 'sub'])
  // The shape of a request is checked here; anything else is not a request at all.
  await assert.rejects(e.files.request('write', { root: 'records' }), /op 只能是/)
  await assert.rejects(e.files.request('read', { root: 5 }), /root 要是 1000 字以内的文字/)
  await assert.rejects(e.files.request('read', { root: 'records', path: 'x'.repeat(1001) }), /path 要是 1000 字以内的文字/)
  for (const offset of [-1, 1.5, '0']) await assert.rejects(e.files.request('read', { root: 'records', path: 'a/old.jsonl', offset }), /offset 要是不小于 0 的整数/)
  await assert.rejects(e.files.request('read', { root: 'records', cmd: 'ls' }), /不接受参数 cmd/)
  // What the reader refuses comes back as its reason, not as content.
  const no = await e.files.request('read', { root: 'records', path: '.env' })
  assert.deepEqual([no.ok, no.error, no.data], [false, 'refused', undefined])
  assert.match(no.hint, /密钥/)
  assert.match((await e.files.request('read', { root: 'records', path: '../outside/secret.txt' })).hint, /必须在这个文件夹里面/)
  // Two requests at once are answered one after the other.
  const [first, second] = await Promise.all([e.files.request('roots'), e.files.request('list', { root: 'records', path: 'a' })])
  assert.deepEqual([first.ok, second.data.total], [true, 2])
  // The owner's pause switch stops a request before it reaches the computer.
  const served = client.served
  assert.equal(e.files.setMode('off').mode, 'off')
  assert.equal(macFilesMode(e.hub), 'off')
  const paused = await e.files.request('read', { root: 'records', path: 'a/old.jsonl' })
  assert.deepEqual([paused.ok, paused.error], [false, 'paused'])
  assert.match(paused.hint, /暂停/)
  assert.equal(client.served, served)
  assert.equal(e.files.setMode('on').mode, 'on')
  assert.throws(() => e.files.setMode('maybe'), /on、all 或 off/)
  assert.deepEqual(e.hub.events, [{ type: 'macfiles.mode', mode: 'off', by: 'owner' }, { type: 'macfiles.mode', mode: 'on', by: 'owner' }])
  assert.equal((await e.files.request('roots')).ok, true)
  // An answer too long for one turn is cut and says so.
  e.files.maxChars = 200
  const long = await e.files.request('read', { root: 'records', path: 'b/chinese.txt' })
  assert.deepEqual([long.ok, long.truncated, typeof long.data, long.data.length], [true, true, 'string', 200])
  assert.match(long.hint, /max_bytes/)
  e.files.maxChars = 40_000
  // The page sees what was asked and how it went, never what was read.
  const { recent } = e.files.status()
  assert.deepEqual(recent[0], { at: recent[0].at, op: 'read', root: 'records', path: 'b/chinese.txt', query: undefined, ok: true, ms: recent[0].ms })
  assert.ok(recent.length <= 20 && recent.some(item => item.error === 'paused') && recent.some(item => item.error === 'refused' && item.path === '.env'))
  assert.ok(recent.every(item => Object.keys(item).every(key => ['at', 'op', 'root', 'path', 'query', 'ok', 'error', 'ms'].includes(key))))
  assert.ok(!JSON.stringify(recent).includes('an older hello world line'))
  // The entrance itself: a known device only, these two routes only.
  assert.equal((await e.post('/api/desktop/files/poll', { roots: ROOTS }, 'wrong-token-wrong-token-wrong')).status, 401)
  assert.equal((await e.post('/api/desktop/files/poll', { roots: ROOTS }, null)).status, 401)
  assert.equal((await e.post('/api/desktop/files/read', { root: 'records' })).status, 404)
  assert.equal((await fetch(e.url + 'api/desktop/files/poll', { headers: { Authorization: 'Bearer ' + TOKEN } })).status, 404)
  assert.deepEqual(await (await e.post('/api/desktop/observation/hello', {})).json(), { ok: true, deviceId: 'mac-1' }, 'the sensor routes are as before')
  for (const roots of ['nope', [{ name: 'Bad Name', label: 'x' }], [{ name: 'ok' }], Array.from({ length: 21 }, (_, i) => ({ name: 'r' + i, label: 'x' }))])
    assert.equal((await e.post('/api/desktop/files/poll', { roots })).status, 400)
  assert.deepEqual(await e.answer({ id: 'never-asked', ok: true, data: { text: 'made up' } }), { accepted: false })
  assert.equal(e.files.status().connected, true, 'none of that unseated the reader')
  assert.equal((await e.files.request('roots')).ok, true)
  // The reader stopped (the hard off switch): the assistant is told plainly, at once.
  client.stop()
  await running
  await until(() => e.files.waiter === null)
  clock.skew += 60_000
  const gone = await e.files.request('roots')
  assert.deepEqual([gone.ok, gone.error, e.files.status().connected], [false, 'offline', false])
  assert.match(gone.hint, /连不上/)
})

test('a reader that is refused at the entrance keeps its reason and can still be stopped', async t => {
  const f = fixture(t), e = await entrance(t, { holdMs: 300 })
  const client = new MacReaderClient({ reader: f.reader, serverUrl: e.url, token: () => 'wrong-token-wrong-token-wrong' })
  const running = client.run()
  t.after(() => client.stop())
  await until(() => client.lastError)
  assert.match(client.lastError, /401/)
  assert.equal(e.files.status().connected, false)
  client.stop()
  await running
})

test('a failure inside the reader is reported by its code only, so no local path gets out', async t => {
  const e = await entrance(t, { holdMs: 300 })
  const reader = { describe: () => ROOTS, handle: async () => { throw Object.assign(new Error('EACCES: permission denied, open /Users/someone/private.txt'), { code: 'EACCES' }) } }
  const client = new MacReaderClient({ reader, serverUrl: e.url, token: () => TOKEN, holdMs: 3000 })
  const running = client.run()
  t.after(() => client.stop())
  await until(() => e.files.status().connected)
  assert.deepEqual(await e.files.request('read', { root: 'records', path: 'x' }), { ok: false, error: 'refused', hint: '读取失败（EACCES）' })
  client.stop()
  await running
})

test('the broker: no answer in time, an answer from the wrong device, a second reader, a request waiting for the next poll', async t => {
  const e = await entrance(t, { holdMs: 150, timeoutMs: 300 })
  // A request waits for the reader's next poll when none is open.
  assert.deepEqual(await e.poll(), { request: null }, 'nothing to do: the wait ends by itself')
  const queued = e.files.request('list', { root: 'records', limit: 3 })
  const handed = await e.poll()
  assert.deepEqual([handed.request.op, handed.request.args], ['list', { root: 'records', limit: 3 }])
  // Another device cannot answer it, a made-up answer shape is not content, and the right device is taken once.
  assert.deepEqual(await e.answer({ id: handed.request.id, ok: true, data: { entries: ['forged'] } }, TOKEN2), { accepted: false })
  assert.deepEqual(await e.answer({ id: handed.request.id, ok: true, data: { entries: [] } }), { accepted: true })
  assert.deepEqual(await e.answer({ id: handed.request.id, ok: true, data: { entries: ['again'] } }), { accepted: false })
  assert.deepEqual(await queued, { ok: true, trust: 'untrusted', device: '我的 Mac', data: { entries: [] } })
  // No answer in time.
  const waiting = e.poll()
  await until(() => e.files.waiter)
  const asked = e.files.request('roots')
  const { request } = await waiting
  const late = await asked
  assert.deepEqual([late.ok, late.error], [false, 'timeout'])
  assert.deepEqual(await e.answer({ id: request.id, ok: true, data: {} }), { accepted: false }, 'a late answer is dropped')
  // A reader's refusal without words, and one with too many.
  for (const [error, hint] of [[undefined, '读取失败'], ['不'.repeat(500), '不'.repeat(300)]]) {
    const open = e.poll()
    await until(() => e.files.waiter)
    const asking = e.files.request('roots')
    await e.answer({ id: (await open).request.id, ok: false, error })
    assert.deepEqual(await asking, { ok: false, error: 'refused', hint })
  }
  // One reader at a time: a newer wait lets the older one go, and the newer one gets the work.
  const older = e.poll()
  await until(() => e.files.waiter)
  const olderWaiter = e.files.waiter
  const newer = e.poll(TOKEN2)
  await until(() => e.files.waiter && e.files.waiter !== olderWaiter)
  assert.deepEqual(await older, { request: null })
  assert.equal(e.files.status().device, '另一台')
  const forNewer = e.files.request('roots')
  const work = (await newer).request
  assert.deepEqual(await e.answer({ id: work.id, ok: true, data: { roots: [] } }), { accepted: false }, 'the first device was not handed this one')
  assert.deepEqual(await e.answer({ id: work.id, ok: true, data: { roots: [] } }, TOKEN2), { accepted: true })
  assert.equal((await forNewer).device, '另一台')
  // Shutting down lets an open wait go and fails what is still asked.
  const open = e.poll()
  await until(() => e.files.waiter)
  e.files.timeoutMs = 60_000
  const closing = e.gateway.close()
  assert.deepEqual(await open, { request: null })
  e.gateway.server.closeAllConnections()
  await closing
})

test('without the broker the entrance has no file routes', async t => {
  const e = await entrance(t, null)
  assert.equal((await e.post('/api/desktop/files/poll', { roots: ROOTS })).status, 404)
  assert.equal((await e.post('/api/desktop/files/result', { id: 'x' })).status, 404)
  assert.equal((await e.post('/api/desktop/observation/hello', {})).status, 200)
})

test('reading the computer is a tool of the personal assistant only, and exists only where the entrance is on', async () => {
  const hub = { events: [] }
  const hubStore = { bySession: id => id === 'mira-session' ? { projectId: 'hub', key: 'mira' } : undefined, get: () => hub, append: (_id, event) => { hub.events.push(event) } }
  const deps = { defineTool: definition => definition, hubStore, hubDriver: {}, hubActions: {}, projects: {}, personal: {} }
  const named = tools => tools.find(tool => tool.definition.name === 'hub_mac_files')?.definition
  assert.equal(named(createHubTools(deps)), undefined)
  const macFiles = new MacFiles({ hubStore })
  const tool = named(createHubTools({ ...deps, macFiles }))
  assert.deepEqual(tool.parameters.op.enum, ['roots', 'list', 'search', 'read'])
  await assert.rejects(tool.execute({ op: 'roots' }, { agent: { id: 'some-project-session' } }), /个人助理/)
  // Not being able to read is an answer the assistant can pass on, not an error.
  const offline = JSON.parse(await tool.execute({ op: 'roots', root: '', path: '' }, { agent: { id: 'mira-session' } }))
  assert.deepEqual([offline.ok, offline.error], [false, 'offline'])
  assert.match(offline.hint, /如实告诉用户/)
  await assert.rejects(tool.execute({ op: 'run', root: 'records' }, { agent: { id: 'mira-session' } }), /op 只能是/)
  await assert.rejects(tool.execute({ op: 'read', command: 'cat ~/.ssh/id_rsa' }, { agent: { id: 'mira-session' } }), /不接受参数 command/)
  assert.deepEqual(hub.events.filter(event => event.type === 'tool.called').map(event => [event.tool, event.ok]), [['hub_mac_files', false], ['hub_mac_files', true], ['hub_mac_files', false], ['hub_mac_files', false]])
  assert.equal(macFiles.status().recent.length, 1, 'only a real request is listed on the page')
})

test('when the assistant tries her own read on a file of the computer, she is pointed to the tool that can', t => {
  const { base, put } = folder(t, 'mira-attachments-')
  const attachments = join(base, 'attachments'), mine = put('attachments/v1/files/note.md', '# 附件'), other = put('elsewhere.txt', 'x')
  let guard
  const tools = { schemas: () => [{ name: 'hub_search' }, { name: 'hub_mac_files' }, { name: 'read' }, { name: 'bash' }], presentAs: () => {}, restrict: () => {}, guard: fn => { guard = fn } }
  restrictPersonalAgent({ ctx: { tools } }, new Set(['hub_search', 'hub_mac_files']), attachments)
  assert.equal(guard({ name: 'read', arguments: { file_path: mine } }), undefined)
  assert.equal(guard({ name: 'hub_mac_files', arguments: { op: 'roots' } }), undefined)
  for (const file_path of [other, '/Users/someone/.claude/projects/x/session.jsonl']) {
    const message = guard({ name: 'read', arguments: { file_path } })
    assert.match(message, /只能读用户发给她的附件/)
    assert.match(message, /用户自己电脑上的文件用 hub_mac_files 读/)
  }
  assert.match(guard({ name: 'bash', arguments: { command: 'ssh mac cat x' } }), /hub_task_open/)
  restrictPersonalAgent({ ctx: { tools } }, new Set(['hub_search']), attachments)
  assert.doesNotMatch(guard({ name: 'read', arguments: { file_path: other } }), /hub_mac_files/)
})

test('全部文件: the home folder is a root only when marked whole, and even then never shows Library, hidden folders or keys', async t => {
  const { base, put } = folder(t, 'mira-home-')
  put('Documents/plan.md', '发布计划：周四下午\n', 1)
  put('Downloads/report.txt', 'hello report from downloads\n', 2)
  put('proj/main.js', 'console.log("hello report")\n', 3)
  put('proj/node_modules/pkg/index.js', 'hello report inside a dependency\n', 4)
  put('Library/Messages/chat.txt', 'hello report, private messages\n', 5)
  put('.ssh/config', 'Host hello-report\n', 6)
  put('.config/app.json', '{"hello":"report"}\n', 7)
  put('Documents/.env', 'TOPSECRET=hello-report\n', 8)
  // Without the mark the home folder is still too wide; the mark fits only the home folder itself.
  assert.throws(() => new MacReader({ roots: [{ name: 'home', label: '个人目录', path: base }], home: base }), /太宽/)
  assert.throws(() => new MacReader({ roots: [{ name: 'docs', label: '文稿', path: join(base, 'Documents'), whole: true }], home: base }), /正好是个人目录/)
  const reader = new MacReader({ roots: [{ name: 'home', label: '全部文件', path: base, whole: true }], home: base, logFile: join(base, 'proj', 'reader.log'), maxRequests: 1000 })
  assert.deepEqual(await reader.handle('roots', {}), { roots: [{ name: 'home', label: '全部文件', whole: true }] }, 'the other side is told it is the whole home folder')
  const top = (await reader.handle('list', { root: 'home' })).entries.map(e => e.name).sort()
  assert.deepEqual(top, ['Documents', 'Downloads', 'proj'], 'Library and hidden folders are not listed')
  assert.match((await reader.handle('read', { root: 'home', path: 'Documents/plan.md' })).text, /周四下午/)
  await refused(reader.handle('read', { root: 'home', path: 'Library/Messages/chat.txt' }), /资源库/)
  await refused(reader.handle('list', { root: 'home', path: '.config' }), /隐藏文件夹/)
  await refused(reader.handle('read', { root: 'home', path: '.ssh/config' }), /密钥/)
  await refused(reader.handle('read', { root: 'home', path: 'Documents/.env' }), /密钥/)
  const found = (await reader.handle('search', { root: 'home', query: 'hello report' })).files.map(f => f.path).sort()
  assert.deepEqual(found, ['Downloads/report.txt', 'proj/main.js'], 'a search skips Library, hidden folders, keys and installed dependencies')
})

test('the three modes: 指定文件夹 keeps the whole home folder out on this side, 全部文件 lets it through, 暂停 stops everything', async t => {
  const e = await entrance(t, { holdMs: 300, timeoutMs: 3000 })
  const roots = [{ name: 'records', label: '对话记录' }, { name: 'home', label: '全部文件', whole: true }]
  const serve = async data => {
    const { request } = await (await e.post('/api/desktop/files/poll', { roots })).json()
    await e.answer({ id: request.id, ok: true, data: data(request) })
    return request
  }
  // The reader's first poll registers it, so the broker knows which root is the whole home folder.
  assert.deepEqual(await (await e.post('/api/desktop/files/poll', { roots })).json(), { request: null })
  assert.equal(e.files.status().whole, true)
  assert.equal(e.files.status().mode, 'on')
  // 指定文件夹 (the default): the whole root is refused here, without asking the computer, and left out of roots.
  const refusedHere = await e.files.request('list', { root: 'home' })
  assert.deepEqual([refusedHere.ok, refusedHere.error], [false, 'folders_only'])
  assert.match(refusedHere.hint, /全部文件/)
  const listed = e.files.request('roots'); await serve(() => ({ roots }))
  assert.deepEqual((await listed).data.roots.map(r => r.name), ['records'])
  // 全部文件: the same request goes through.
  e.files.setMode('all')
  const through = e.files.request('list', { root: 'home' }); const asked = await serve(() => ({ entries: [] }))
  assert.deepEqual([asked.args.root, (await through).ok], ['home', true])
  const all = e.files.request('roots'); await serve(() => ({ roots }))
  assert.deepEqual((await all).data.roots.map(r => r.name), ['records', 'home'])
  // 暂停: nothing goes out.
  e.files.setMode('off')
  assert.deepEqual((await e.files.request('roots')).error, 'paused')
  assert.throws(() => e.files.setMode('everything'), /on、all 或 off/)
  assert.deepEqual(e.hub.events.filter(x => x.type === 'macfiles.mode').map(x => x.mode), ['all', 'off'])
})
