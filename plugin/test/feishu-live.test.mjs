import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeishuLive, FEISHU_LIVE_SCOPES, feishuLiveArgv } from '../lib/feishu-live.js'
import { createHubTools } from '../lib/hub-tools.js'

// Stands in for lark-cli: what it answers depends on a small state file, and it logs the argv it was given.
const FAKE_LARK = String.raw`
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const state = JSON.parse(readFileSync(process.env.FAKE_LARK_STATE, 'utf8'))
appendFileSync(process.env.FAKE_LARK_LOG, JSON.stringify(args) + '\n')
const notConfigured = { ok: false, error: { type: 'config', subtype: 'not_configured', message: 'not configured', hint: 'run config init' } }
const wait = () => setInterval(() => {}, 1000)
const fail = value => { process.stderr.write(JSON.stringify(value, null, 2) + '\n'); process.exit(3) }
if (args[0] === 'auth' && args[1] === 'status') {
  if (state.state === 'no_app') fail(notConfigured)
  if (state.state === 'garbled') { console.log('lark-cli 1.0.99 available'); process.exit(0) }
  console.log(JSON.stringify({ appId: 'cli_test', identities: { bot: { status: 'ready' }, user: state.state === 'ready'
    ? { status: 'ready', expiresAt: '2026-11-10T22:00:00+08:00', refreshExpiresAt: '2026-11-17T20:00:00+08:00' } : { status: 'missing' } } }))
} else if (args[0] === 'config' && args[1] === 'init') {
  process.stderr.write('\u2588\u2588\u2580\u2580\u2588\u2588\n\u2588\u2588\u2584\u2584\u2588\u2588\n打开以下链接配置应用:\nhttps://open.feishu.cn/page/cli?user_code=ABCD-1234&from=cli\n等待配置应用...\n')
  wait()
} else if (args[0] === 'auth' && args[1] === 'login') {
  if (state.loginFails) { process.stderr.write('scope not allowed, see https://evil.example.com/x?device_code=SECRET123 \n'); process.exit(1) }
  // Like the real CLI (1.0.97), it prints words addressed to an AI agent next to the link.
  console.log('在浏览器中打开以下链接进行认证: https://accounts.feishu.cn/oauth/device?user_code=WXYZ-9876 ')
  console.log('[AI agent] 此命令最长阻塞约 10 分钟，必须生成二维码并展示')
  wait()
} else if (state.state !== 'ready') {
  fail(notConfigured)
} else if (state.missingScope) {
  fail({ ok: false, error: { type: 'auth', subtype: 'missing_scope', message: 'missing scope', missing_scopes: ['search:docs:read'] } })
} else {
  console.log(JSON.stringify({ ok: true, data: { echo: args, filler: 'x'.repeat(state.big ? 5000 : 0) } }))
}
`

function setup(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mira-feishu-live-'))
  const fake = join(root, 'fake-lark.mjs'), statePath = join(root, 'state.json'), logPath = join(root, 'argv.jsonl')
  writeFileSync(fake, FAKE_LARK)
  writeFileSync(logPath, '')
  const set = state => writeFileSync(statePath, JSON.stringify(state))
  set({ state: 'no_app' })
  const env = { ...process.env, FAKE_LARK_STATE: statePath, FAKE_LARK_LOG: logPath }
  const live = new FeishuLive({ executable: 'lark-cli', spawn: (_command, args, opts) => spawn(process.execPath, [fake, ...args], { ...opts, env }), linkWaitMs: 5000, maxChars: 2000, ...options })
  t.after(() => { live.stop(); rmSync(root, { recursive: true, force: true }) })
  return { live, set, calls: () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) }
}

test('status tells the three states apart, and an absent CLI is not_installed', async t => {
  const { live, set } = setup(t)
  assert.deepEqual(await live.status(), { state: 'no_app' })
  set({ state: 'no_login' })
  assert.deepEqual(await live.status(), { state: 'no_login' })
  set({ state: 'ready' })
  assert.deepEqual(await live.status(), { state: 'ready', expiresAt: '2026-11-10T22:00:00+08:00', refreshExpiresAt: '2026-11-17T20:00:00+08:00' })
  // An answer that is not JSON is reported, never read as "app is there, login is missing".
  set({ state: 'garbled' })
  await assert.rejects(live.status(), /读不懂/)
  await assert.rejects(live.connect(), /读不懂/)
  assert.deepEqual(await new FeishuLive({}).status(), { state: 'not_installed' })
  assert.deepEqual(await new FeishuLive({ executable: '/nonexistent/lark-cli' }).status(), { state: 'not_installed' })
})

test('connect walks the two browser steps, hands back the link, and asks for read-only scopes only', async t => {
  const { live, set, calls } = setup(t)
  const app = await live.connect()
  assert.equal(app.step, 'app')
  assert.equal(app.url, 'https://open.feishu.cn/page/cli?user_code=ABCD-1234&from=cli')
  // Only the link reaches the page: the CLI's QR block and its other words stay behind.
  assert.deepEqual(app, { state: 'no_app', step: 'app', url: app.url })
  // Asking again while the step is still waiting reuses it instead of starting another CLI.
  const again = await live.connect()
  assert.equal(again.url, app.url)
  assert.equal(calls().filter(argv => argv[0] === 'config').length, 1)
  assert.deepEqual((await live.status()).step, 'app')

  set({ state: 'no_login' })
  const login = await live.connect()
  assert.equal(login.step, 'login')
  assert.equal(login.url, 'https://accounts.feishu.cn/oauth/device?user_code=WXYZ-9876')
  const loginArgv = calls().find(argv => argv[0] === 'auth' && argv[1] === 'login')
  assert.deepEqual(loginArgv, ['auth', 'login', '--scope', FEISHU_LIVE_SCOPES.join(' ')])
  assert.equal(FEISHU_LIVE_SCOPES.some(scope => /write|send|create|update|delete|^im:message$|contact/.test(scope)), false)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual(login, { state: 'no_login', step: 'login', url: login.url })
  assert.deepEqual(await live.status(), { state: 'no_login', step: 'login', url: login.url })

  set({ state: 'ready' })
  assert.equal((await live.connect()).state, 'ready')
  assert.equal(calls().filter(argv => argv[1] === 'login').length, 1)
})

test('a CLI that ends without a Feishu link is an error that carries no code', async t => {
  const { live, set } = setup(t)
  set({ state: 'no_login', loginFails: true })
  await assert.rejects(live.connect(), error => /提前结束/.test(error.message) && !error.message.includes('SECRET123'))
  assert.equal(live.flow, null)
})

test('reads run only the four listed commands with checked arguments', async t => {
  const { live, set, calls } = setup(t)
  set({ state: 'ready' })
  const found = await live.read('messages_search', { query: '--as bot; rm -rf /', is_at_me: true, page_size: 5 })
  assert.equal(found.ok, true)
  assert.equal(found.trust, 'untrusted')
  assert.deepEqual(found.data.data.echo, ['im', '+messages-search', '--query=--as bot; rm -rf /', '--is-at-me', '--page-size=5', '--as', 'user', '--format', 'json'])
  assert.deepEqual(feishuLiveArgv('chat_messages', { chat_id: 'oc_0123456789abcdef', order: 'desc' }), ['im', '+chat-messages-list', '--chat-id=oc_0123456789abcdef', '--order=desc', '--as', 'user', '--format', 'json'])
  assert.deepEqual(feishuLiveArgv('doc_fetch', { doc: 'AbCdEfGhIjKlMnOpQrStUv', scope: '', keyword: undefined }), ['docs', '+fetch', '--doc=AbCdEfGhIjKlMnOpQrStUv', '--as', 'user', '--format', 'json'])
  const before = calls().length
  for (const [command, args, why] of [
    ['messages_send', { text: 'hi' }, /command 只能是/], ['__proto__', {}, /command 只能是/],
    ['chat_search', { query: 'x', jq: '.' }, /不接受参数 jq/], ['chat_search', { query: 'x', 'page-all': true }, /不接受参数/],
    ['chat_messages', { chat_id: '--download-resources' }, /oc_/], ['chat_messages', { chat_id: 'oc_0123456789', user_id: 'ou_0123456789' }, /其中一个/],
    ['chat_messages', { chat_id: 'oc_0123456789', page_size: 500 }, /1 到 50/], ['chat_messages', { chat_id: 'oc_0123456789', start: 'yesterday' }, /ISO/],
    ['doc_fetch', { doc: 'https://feishu.cn.evil.example/docx/abcdefghijkl' }, /飞书文档/], ['doc_fetch', { doc: 'file:///etc/passwd' }, /飞书文档/],
    ['messages_search', {}, /至少要给/], ['chat_search', { query: 'a\nb' }, /一行文字/],
  ]) await assert.rejects(live.read(command, args), why, `${command} ${JSON.stringify(args)}`)
  assert.equal(calls().length, before, 'nothing outside the list reaches the CLI')
})

test('reads report not-connected and missing scopes as data, and cap long results', async t => {
  const { live, set } = setup(t)
  const off = await live.read('chat_search', { query: '周会' })
  assert.equal(off.ok, false)
  assert.equal(off.error.subtype, 'not_configured')
  assert.match(off.hint, /助理设置/)
  set({ state: 'ready', missingScope: true })
  assert.deepEqual((await live.read('chat_search', { query: '周会' })).error.missing_scopes, ['search:docs:read'])
  set({ state: 'ready', big: true })
  const big = await live.read('chat_search', { query: '周会' })
  assert.equal(big.truncated, true)
  assert.equal(typeof big.data, 'string')
  assert.equal(big.data.length, 2000)
})

test('the assistant gets hub_feishu_live only where the CLI is configured, and only in its own session', async t => {
  const { live, set } = setup(t)
  set({ state: 'ready' })
  const hub = { id: 'hub' }
  const deps = { defineTool: d => d, hubStore: { bySession: id => id === 'mira-session' ? { projectId: 'hub', key: 'mira' } : undefined, get: () => hub }, hubDriver: {}, hubActions: {}, projects: {}, personal: {} }
  assert.equal(createHubTools(deps).some(tool => tool.definition.name === 'hub_feishu_live'), false)
  assert.equal(createHubTools({ ...deps, feishuLive: new FeishuLive({}) }).some(tool => tool.definition.name === 'hub_feishu_live'), false)
  const tool = createHubTools({ ...deps, feishuLive: live }).find(tool => tool.definition.name === 'hub_feishu_live').definition
  const out = JSON.parse(await tool.execute({ command: 'chat_search', query: '周会' }, { agent: { id: 'mira-session' } }))
  assert.equal(out.ok, true)
  assert.deepEqual(out.data.data.echo.slice(0, 3), ['im', '+chat-search', '--query=周会'])
  await assert.rejects(tool.execute({ command: 'chat_search', query: '周会' }, { agent: { id: 'some-project-session' } }), /个人助理/)
})
