import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ProjectStore } from '../lib/store.js'
import { ensureHub } from '../lib/hub.js'
import { Observations } from '../lib/observations.js'
import { ObservationClient, ScreenpipeObservationSource } from '../lib/observation-client.js'
import { createRequire } from 'node:module'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
import { DeviceGateway } from '../lib/device-gateway.js'
import { LarkMessageSource, larkTime } from '../lib/lark-source.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const TOKEN = 'device-token-for-tests-0123456789'

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-device-'));t.after(() => rmSync(root, { recursive: true, force: true }))
  const hub = new ProjectStore(join(root, 'hub-store'), { warn() {} });hub.load();ensureHub(hub)
  const projects = new ProjectStore(join(root, 'projects'), { warn() {} });projects.load()
  const observations = new Observations(hub, projects, { root: join(root, 'images') })
  t.after(() => observations.close())
  const gateway = new DeviceGateway({ observations, devices: [{ deviceId: 'mac-1', name: '我的 Mac', tokenSha256: sha(TOKEN) }], logger: { warn() {} } })
  const port = await gateway.listen(0)
  t.after(() => gateway.close())
  const post = (path, body, token = TOKEN) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })
  return { root, hub, observations, port, post }
}

test('the device entrance on the Mira machine accepts only a known device token and maps it to that device', async t => {
  const f = await setup(t)
  assert.equal((await f.post('/api/desktop/observation/hello', { report: {} }, 'wrong-token-wrong-token-wrong')).status, 401)
  assert.equal((await f.post('/api/desktop/observation/hello', { report: {} }, null)).status, 401)
  assert.equal((await f.post('/api/desktop/observation/other', {})).status, 404)
  const hello = await (await f.post('/api/desktop/observation/hello', { report: {} })).json()
  assert.deepEqual([hello.ok, hello.deviceId, hello.policy.enabled], [true, 'mac-1', false], 'collection stays off until the owner enables it')
  // Nothing is stored while off; once enabled, a Feishu message becomes external evidence in Mira's hub.
  const event = { eventId: 'lark:om_1:202611071000', localSeq: 1, source: 'lark', occurredAt: Date.now() - 1000, app: '飞书', title: '达标讨论群', text: '张三：标签先定 10 个' }
  const off = await (await f.post('/api/desktop/observation/ingest', { revision: 0, events: [event] })).json()
  assert.equal(off.receipts[0].code, 'OBSERVATION_PAUSED')
  const { revision } = await f.observations.configure({ deviceId: 'mac-1', policy: { enabled: true }, expectedRevision: 0, requestId: 'enable-mac-1' })
  const on = await (await f.post('/api/desktop/observation/ingest', { revision, events: [event] })).json()
  assert.equal(on.receipts[0].status, 'accepted')
  const stored = f.hub.get('hub').events.find(e => e.type === 'observation.accepted' && e.eventId === event.eventId)
  assert.deepEqual([stored.source, stored.trust, stored.deviceId, stored.title], ['lark', 'external', 'mac-1', '达标讨论群'])
  // Oversized bodies are refused before parsing.
  const huge = await fetch(`http://127.0.0.1:${f.port}/api/desktop/observation/ingest`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: 'x'.repeat(5 * 1024 * 1024) })
  assert.equal(huge.status, 413)
})

// A fake lark-cli: answers +messages-search with the given pages and records each call.
function fakeLark(pages) {
  const calls = []
  const run = async args => { calls.push(args);const page = pages.shift();if (page instanceof Error) throw page;return page }
  return { run, calls }
}
const message = (id, time, extra = {}) => ({ message_id: id, create_time: time, update_time: time, chat_id: 'oc_1', chat_name: '达标讨论群', chat_type: 'group', msg_type: 'text', content: '内容' + id, deleted: false, sender: { name: '张三', sender_type: 'user' }, ...extra })
const page = (messages, more = false) => ({ ok: true, data: { messages, has_more: more } })
function fakeClient() {
  const queued = [], checkpoints = new Map()
  return {
    queued, checkpoints,
    policy: () => ({ enabled: true, uploadImages: false, excludeApps: [] }),
    get: () => null,
    checkpoint: stream => checkpoints.get(stream) ?? null,
    commitCheckpoint: (stream, cursor) => { checkpoints.set(stream, cursor) },
    enqueue: (input, image, { stream, cursor } = {}) => { queued.push(input);if (stream !== undefined) checkpoints.set(stream, cursor);return { queued: true } },
  }
}

test('Feishu messages are read with the owner\'s own lark-cli login, in time order, as plain observations', async t => {
  const now = Date.parse('2026-11-07T10:30:00+08:00')
  const lark = fakeLark([page([
    message('om_b', '2026-11-07 10:20', { sender: { name: '李四', sender_type: 'user' } }),
    message('om_a', '2026-11-07 10:05'),
    message('om_img', '2026-11-07 10:21', { msg_type: 'image', content: '{"image_key":"img_x"}' }),
    message('om_del', '2026-11-07 10:22', { deleted: true }),
  ])])
  const source = new LarkMessageSource({ run: lark.run, now: () => now, firstSince: Date.parse('2026-11-07T00:00:00+08:00') })
  const client = fakeClient()
  await source.collect(client)
  // One search over the window, as the user, all pages.
  const args = lark.calls[0]
  assert.deepEqual(args.slice(0, 3), ['im', '+messages-search', '--as'])
  assert.ok(args.includes('user') && args.includes('--page-all') && args.includes('json'))
  assert.equal(args[args.indexOf('--start') + 1], '2026-11-07T00:00:00+08:00')
  assert.equal(args[args.indexOf('--end') + 1], '2026-11-07T10:30:00+08:00')
  // Time order; deleted messages skipped; an image is named, not dumped.
  assert.deepEqual(client.queued.map(e => e.eventId), ['lark:om_a:202611071005', 'lark:om_b:202611071020', 'lark:om_img:202611071021'])
  assert.deepEqual(client.queued.map(e => e.text), ['张三：内容om_a', '李四：内容om_b', '张三：[图片]'])
  assert.deepEqual([client.queued[0].source, client.queued[0].app, client.queued[0].title], ['lark', '飞书', '达标讨论群'])
  assert.equal(client.queued[0].occurredAt, Date.parse('2026-11-07T10:05:00+08:00'))
  assert.deepEqual(client.checkpoints.get('lark-messages'), { since: now })
})

test('the next Feishu read reaches back 15 minutes, waits its interval, and a failed read keeps its place', async t => {
  let now = Date.parse('2026-11-07T10:30:00+08:00')
  const lark = fakeLark([page([]), new Error('lark-cli: need refresh'), page([message('om_c', '2026-11-07 10:40')])])
  const source = new LarkMessageSource({ run: lark.run, now: () => now, firstSince: now - 3600_000, intervalMs: 120_000, overlapMs: 15 * 60_000 })
  const client = fakeClient()
  await source.collect(client)
  assert.deepEqual(client.checkpoints.get('lark-messages'), { since: now }, 'an empty window still moves the place forward')
  now += 60_000
  await source.collect(client)
  assert.equal(lark.calls.length, 1, 'too soon: no second read')
  now += 120_000
  await assert.rejects(source.collect(client), /飞书/)
  assert.deepEqual(client.checkpoints.get('lark-messages'), { since: Date.parse('2026-11-07T10:30:00+08:00') }, 'a failed read keeps its place')
  now += 120_000
  await source.collect(client)
  const args = lark.calls.at(-1)
  assert.equal(args[args.indexOf('--start') + 1], '2026-11-07T10:15:00+08:00', '15 minutes back for index lag and minute precision')
  assert.equal(client.queued.at(-1).eventId, 'lark:om_c:202611071040')
  assert.equal(larkTime('2026-11-07 10:05'), Date.parse('2026-11-07T10:05:00+08:00'))
  assert.throws(() => larkTime('yesterday'), /飞书/)
})

test('a real device outbox sends Feishu observations through the entrance into Mira\'s hub', async t => {
  const f = await setup(t)
  const directory = mkdtempSync(join(tmpdir(), 'mira-outbox-'));t.after(() => rmSync(directory, { recursive: true, force: true }))
  const client = new ObservationClient({ directory, serverUrl: `http://127.0.0.1:${f.port}/`, deviceId: 'mac-1', token: () => TOKEN })
  t.after(() => client.close())
  await client.tick()
  await f.observations.configure({ deviceId: 'mac-1', policy: { enabled: true }, expectedRevision: 0, requestId: 'enable' })
  await client.tick()
  const lark = fakeLark([page([message('om_z', '2026-11-07 10:05')])])
  await new LarkMessageSource({ run: lark.run, now: () => Date.parse('2026-11-07T10:30:00+08:00'), firstSince: Date.parse('2026-11-07T00:00:00+08:00') }).collect(client)
  await client.tick()
  assert.equal(client.status().queueEvents, 0)
  const stored = f.hub.get('hub').events.filter(e => e.type === 'observation.accepted')
  assert.deepEqual(stored.map(e => [e.eventId, e.source, e.text]), [['lark:om_z:202611071005', 'lark', '张三：内容om_z']])
})

test('a first Feishu read reaches back three days, and a window too busy for one read is split until nothing is cut off', async t => {
  const now = Date.parse('2026-11-07T10:00:00+08:00')
  // The whole window and its first half overflow the read limit; the quarters fit.
  const answer = args => {
    const start = Date.parse(args[args.indexOf('--start') + 1]), end = Date.parse(args[args.indexOf('--end') + 1])
    if (end - start > 18 * 3600_000) return page([], true)
    return page([message('om_' + start, new Date(start + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' '))])
  }
  const calls = []
  const source = new LarkMessageSource({ run: async args => { calls.push(args);return answer(args) }, now: () => now })
  const client = fakeClient()
  await source.collect(client)
  const starts = calls.map(args => args[args.indexOf('--start') + 1])
  assert.equal(starts[0], '2026-11-04T10:00:00+08:00', 'three days back on first connect')
  // 72h overflows → 36h halves overflow → 18h quarters are read: four reads that fit, covering the whole window.
  const read = calls.filter(args => Date.parse(args[args.indexOf('--end') + 1]) - Date.parse(args[args.indexOf('--start') + 1]) <= 18 * 3600_000)
  assert.equal(read.length, 4)
  assert.equal(client.queued.length, 4)
  assert.deepEqual(client.checkpoints.get('lark-messages'), { since: now })
})

test('what a Feishu backfill already read stays queued when a later window fails, and the place moves only once all is read', async t => {
  const now = Date.parse('2026-11-07T10:00:00+08:00')
  let fail = true
  const run = async args => {
    const start = Date.parse(args[args.indexOf('--start') + 1]), end = Date.parse(args[args.indexOf('--end') + 1])
    if (end - start > 36 * 3600_000) return page([], true)
    if (start >= now - 36 * 3600_000 && fail) throw Error('timeout')
    return page([message('om_' + start, new Date(start + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' '))])
  }
  const source = new LarkMessageSource({ run, now: () => now, intervalMs: 0 })
  const client = fakeClient()
  await assert.rejects(source.collect(client), /飞书/)
  assert.equal(client.queued.length, 1, 'the earlier half was kept')
  assert.equal(client.checkpoints.get('lark-messages'), undefined, 'the place did not move')
  fail = false
  await source.collect(client)
  assert.equal(client.queued.length, 3, 'the retry reads both halves again; the real outbox drops the repeat')
  assert.deepEqual(client.checkpoints.get('lark-messages'), { since: now })
})

test('the owner\'s own Feishu messages are marked as theirs, from the login lark-cli reads with, not guessed', async t => {
  const now = Date.parse('2026-11-07T10:30:00+08:00')
  const lark = fakeLark([page([
    message('om_me', '2026-11-07 10:05', { sender: { id: 'ou_self', name: '林一', sender_type: 'user' } }),
    message('om_other', '2026-11-07 10:06', { sender: { id: 'ou_x', name: '王海龙', sender_type: 'user' } }),
  ])])
  const source = new LarkMessageSource({ run: lark.run, now: () => now, firstSince: now - 3600_000, self: { openId: 'ou_self', name: '林一' } })
  const client = fakeClient()
  await source.collect(client)
  assert.deepEqual(client.queued.map(e => e.text), ['林一（我）：内容om_me', '王海龙：内容om_other'])
  // A new identity for the marked version, so a message sent earlier without the mark never conflicts with it.
  assert.equal(client.queued[0].eventId, 'lark:om_me:202611071005:me')
  assert.equal(client.queued[1].eventId, 'lark:om_other:202611071006')
})

test('a Feishu message that reaches the owner directly (a person\'s direct chat, or an @ of them) is marked, with its conversation', async t => {
  const now = Date.parse('2026-11-07T10:30:00+08:00'), self = { openId: 'ou_self', name: '林一' }
  const lark = fakeLark([page([
    message('om_dm', '2026-11-07 10:01', { chat_id: 'oc_dm', chat_name: '', chat_type: 'p2p', sender: { id: 'ou_a', name: '张三', sender_type: 'user' } }),
    message('om_bot', '2026-11-07 10:02', { chat_id: 'oc_bot', chat_name: '', chat_type: 'p2p', sender: { id: 'cli_x', name: '告警机器人', sender_type: 'app' } }),
    message('om_at', '2026-11-07 10:03', { mentions: [{ id: 'ou_self', key: '@_user_1', name: '林一' }], sender: { id: 'ou_b', name: '李四', sender_type: 'user' } }),
    message('om_other_at', '2026-11-07 10:04', { mentions: [{ id: 'ou_c', key: '@_user_1', name: '王五' }], sender: { id: 'ou_b', name: '李四', sender_type: 'user' } }),
    message('om_mine', '2026-11-07 10:05', { chat_id: 'oc_dm', chat_name: '', chat_type: 'p2p', sender: { id: 'ou_self', name: '林一', sender_type: 'user' } }),
    message('om_odd', '2026-11-07 10:06', { chat_id: 'oc odd/1', chat_type: 'p2p', sender: { id: 'ou_a', name: '张三', sender_type: 'user' } }),
  ])])
  const client = fakeClient()
  await new LarkMessageSource({ run: lark.run, now: () => now, firstSince: now - 3600_000, self }).collect(client)
  const marks = Object.fromEntries(client.queued.map(e => [e.eventId.split(':')[1], [e.correlationId ?? null, e.important === true]]))
  assert.deepEqual(marks, {
    om_dm: ['lark-chat.oc_dm', true], // a person wrote to the owner directly
    om_bot: ['lark-chat.oc_bot', false], // a bot never waits for an answer
    om_at: ['lark-chat.oc_1', true], // the owner was @-ed in a group
    om_other_at: ['lark-chat.oc_1', false], // someone else was
    om_mine: ['lark-chat.oc_dm', false], // the owner's own words, in the same conversation
    om_odd: [null, true], // a conversation id Feishu never gives is left out, not guessed
  })
})

test('a direct chat is titled with who it is with, learned from the other side\'s own messages', async t => {
  const now = Date.parse('2026-11-07T10:30:00+08:00'), self = { openId: 'ou_self', name: '林一' }
  const me = { id: 'ou_self', name: '林一', sender_type: 'user' }, zhang = { id: 'ou_a', name: '张三', sender_type: 'user' }
  const dm = (id, time, chat, sender) => message(id, time, { chat_id: chat, chat_name: '', chat_type: 'p2p', sender })
  const calls = []
  const run = async args => {
    calls.push(args)
    if (args[1] === '+messages-search') return page([
      dm('om_1', '2026-11-07 10:01', 'oc_a', me), // the owner speaks first; the other side answers later in the same read
      dm('om_2', '2026-11-07 10:02', 'oc_a', zhang),
      dm('om_3', '2026-11-07 10:03', 'oc_b', me), // the other side is not in this read: one look at the chat
      dm('om_4', '2026-11-07 10:04', 'oc_b', me),
      dm('om_5', '2026-11-07 10:05', 'oc_c', me), // nobody else ever spoke there
      dm('om_6', '2026-11-07 10:06', 'oc_d', me), // the look fails
      message('om_7', '2026-11-07 10:07'), // a group keeps its own name
    ])
    const chat = args[args.indexOf('--chat-id') + 1]
    if (chat === 'oc_b') return page([dm('om_x', '2026-11-06 09:00', 'oc_b', me), dm('om_y', '2026-11-06 08:00', 'oc_b', { id: 'ou_b', name: '李四', sender_type: 'user' })])
    if (chat === 'oc_c') return page([dm('om_z', '2026-11-06 09:00', 'oc_c', me)])
    throw new Error('飞书读取失败')
  }
  const source = new LarkMessageSource({ run, now: () => now, firstSince: now - 3600_000, intervalMs: 0, self })
  const client = fakeClient()
  await source.collect(client)
  assert.deepEqual(client.queued.map(e => e.title), ['与张三的单聊', '与张三的单聊', '与李四的单聊', '与李四的单聊', '单聊', '单聊', '达标讨论群'])
  // Who a message belongs to and what it says are untouched: only the title changed.
  assert.deepEqual(client.queued.slice(0, 2).map(e => [e.eventId, e.text, e.correlationId]),
    [['lark:om_1:202611071001:me', '林一（我）：内容om_1', 'lark-chat.oc_a'], ['lark:om_2:202611071002', '张三：内容om_2', 'lark-chat.oc_a']])
  // One read-only look per chat, as the user; found or not, it is remembered for the next read.
  const looks = () => calls.filter(a => a[1] === '+chat-messages-list')
  assert.deepEqual(looks().map(a => a[a.indexOf('--chat-id') + 1]), ['oc_b', 'oc_c', 'oc_d'])
  assert.ok(looks().every(a => a[0] === 'im' && a[a.indexOf('--as') + 1] === 'user'))
  await source.collect(fakeClient())
  assert.equal(looks().length, 3)
  // Without the owner's identity nobody can be told apart, so nobody is named (and nothing more is read).
  const blind = fakeClient()
  await new LarkMessageSource({ run, now: () => now, firstSince: now - 3600_000 }).collect(blind)
  assert.deepEqual(blind.queued.slice(0, 3).map(e => e.title), ['单聊', '单聊', '单聊'])
  assert.equal(looks().length, 3)
})

test('a Feishu message first sent before these marks is not sent again and does not stall the read', async t => {
  const f = await setup(t)
  const directory = mkdtempSync(join(tmpdir(), 'mira-outbox-'));t.after(() => rmSync(directory, { recursive: true, force: true }))
  const client = new ObservationClient({ directory, serverUrl: `http://127.0.0.1:${f.port}/`, deviceId: 'mac-1', token: () => TOKEN })
  t.after(() => client.close())
  await client.tick()
  await f.observations.configure({ deviceId: 'mac-1', policy: { enabled: true }, expectedRevision: 0, requestId: 'enable' })
  await client.tick()
  // What the sensor sent for this message before it knew conversations: same identity, older content.
  client.enqueue({ eventId: 'lark:om_old:202611071005', source: 'lark', occurredAt: Date.parse('2026-11-07T10:05:00+08:00'), app: '飞书', title: '达标讨论群', text: '张三：内容om_old' })
  const now = Date.parse('2026-11-07T10:30:00+08:00')
  const lark = fakeLark([page([message('om_old', '2026-11-07 10:05'), message('om_new', '2026-11-07 10:20')])])
  await new LarkMessageSource({ run: lark.run, now: () => now, firstSince: now - 3600_000 }).collect(client)
  assert.deepEqual(client.checkpoint('lark-messages'), { since: now }, 'the read moved on')
  await client.tick()
  const stored = f.hub.get('hub').events.filter(e => e.type === 'observation.accepted')
  assert.deepEqual(stored.map(e => [e.eventId, e.correlationId]), [['lark:om_old:202611071005', null], ['lark:om_new:202611071020', 'lark-chat.oc_1']])
})

test('the always-on screen source reads once a minute, keeps the latest frame of every window it saw, skips unchanged ones and clips the text', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mira-screen-'));t.after(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'db.sqlite'), db = new DatabaseSync(dbPath);t.after(() => db.close())
  db.exec(`CREATE TABLE frames (id INTEGER PRIMARY KEY,timestamp TEXT,app_name TEXT,device_name TEXT,window_name TEXT,window_name_redacted_at TEXT,
    snapshot_path TEXT,image_redacted_at TEXT,accessibility_text TEXT,accessibility_redacted_at TEXT,content_hash INTEGER)`)
  const insert = db.prepare('INSERT INTO frames VALUES (?,?,?,?,?,NULL,NULL,NULL,?,NULL,?)')
  const at = id => new Date(Date.parse('2026-11-07T10:00:00+08:00') + id * 1000).toISOString()
  insert.run(1, at(1), 'Code', 'monitor_1', 'old.js', '旧的不补传', 'h0')
  let now = 1_000_000
  const source = new ScreenpipeObservationSource({ dbPath, imageRoot: root, intervalMs: 60_000, perWindow: true, maxText: 2000, now: () => now })
  const client = fakeClient()
  await source.collect(client)
  assert.equal(client.queued.length, 0, 'starts from now')
  insert.run(2, at(2), 'Code', 'monitor_1', 'a.js', 'x'.repeat(5000), 'h1')
  insert.run(3, at(3), '飞书', 'monitor_1', '达标讨论群', '群里在聊标签', 'h2')
  insert.run(4, at(4), 'Code', 'monitor_1', 'a.js', 'start' + 'y'.repeat(5000) + 'end', 'h3')
  now += 30_000;await source.collect(client)
  assert.equal(client.queued.length, 0, 'not read again within the minute')
  now += 31_000;await source.collect(client)
  assert.deepEqual(client.queued.map(e => [e.app, e.title, e.text.length]), [['飞书', '达标讨论群', 6], ['Code', 'a.js', 2000]], 'one per window, the latest, clipped')
  assert.ok(client.queued[1].text.startsWith('starty') && client.queued[1].text.endsWith('yend'), 'keeps the start (which window) and the end (what was shown last)')
  insert.run(5, at(5), 'Code', 'monitor_1', 'a.js', 'start' + 'y'.repeat(5000) + 'end', 'h3')
  now += 61_000;await source.collect(client)
  assert.equal(client.queued.length, 2, 'an unchanged window is not sent again')
  assert.equal(client.checkpoints.get('screenpipe-frames').id, 5)
  insert.run(6, at(6), 'Code', 'monitor_1', 'a.js', '改了', 'h4')
  now += 61_000;await source.collect(client)
  assert.deepEqual(client.queued.slice(2).map(e => e.text), ['改了'])
  // Screenpipe 0.4 keeps the hash as a 64-bit integer, larger than a JavaScript number can hold.
  insert.run(7, at(7), 'Code', 'monitor_1', 'b.js', '新文件', -332940014306696045n)
  insert.run(8, at(8), 'Code', 'monitor_1', 'b.js', '新文件', -332940014306696045n)
  now += 61_000;await source.collect(client)
  assert.deepEqual(client.queued.slice(3).map(e => [e.title, e.text]), [['b.js', '新文件']])
  insert.run(9, at(9), 'Code', 'monitor_1', 'b.js', '新文件', -332940014306696045n)
  now += 61_000;await source.collect(client)
  assert.equal(client.queued.length, 4, 'the same large hash counts as unchanged')
  // Clipping never cuts an emoji in half: the entrance refuses malformed text, which would stall the cursor on that frame.
  insert.run(10, at(10), 'Code😀'.padStart(160, 'x'), 'monitor_1', 'c.js'.padStart(399, 'y') + '😀', 'a'.repeat(1999) + '😀b', 'h9')
  now += 61_000;await source.collect(client)
  const last = client.queued.at(-1)
  assert.ok(last.text.isWellFormed() && last.title.isWellFormed() && last.app.isWellFormed())
})
