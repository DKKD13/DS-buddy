import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../lib/store.js'
import { ensureHub } from '../lib/hub.js'
import { Observations } from '../lib/observations.js'
import { ObservationClient, ObservationRunner, ScreenpipeObservationSource, MiraJournalObservationSource, chooseObservationFrames, latestChangedFrames, electronObservationEncoder } from '../lib/observation-client.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=', 'base64')
async function setup(t, policy = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mira-device-outbox-'));t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new ProjectStore(join(root, 'hub'), { warn() {} });store.load();ensureHub(store)
  const projects = new ProjectStore(join(root, 'projects'), { warn() {} });projects.load()
  const service = new Observations(store, projects, { root: join(root, 'images') });t.after(() => service.close())
  service.hello('device-a', '设备甲')
  await service.configure({ deviceId: 'device-a', expectedRevision: 0, requestId: 'configure-initial', policy: { enabled: true, uploadImages: true, ...policy } })
  const calls = [], credential = 'fixture-secret-never-persist', clients = []
  let intercept = null
  const fetcher = async (url, request) => {
    const operation = new URL(url).pathname.split('/').at(-1), body = JSON.parse(request.body)
    assert.equal(request.headers.Authorization, 'Bearer ' + credential)
    calls.push({ operation, body })
    const run = async () => operation === 'hello' ? service.hello('device-a', '设备甲', body.report) : operation === 'chunk' ? service.chunk('device-a', body) : service.ingest('device-a', body)
    const result = intercept ? await intercept(operation, body, run) : await run()
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = (options = {}) => {
    const c = new ObservationClient({ directory: join(root, 'device'), serverUrl: 'http://127.0.0.1/', deviceId: 'device-a', token: () => credential, fetch: fetcher, ...options })
    clients.push(c);return c
  }
  t.after(() => { for (const c of clients) if (!c.closed) c.close() })
  const item = (eventId, extra = {}) => ({ eventId, source: 'screen', occurredAt: Date.now() - 1000, app: '编辑器', title: '结果界面', text: '观察内容仅作资料', ...extra })
  const first = client();await first.tick()
  return { root, store, service, first, client, calls, item, intercept: fn => { intercept = fn } }
}

test('outbox durably couples original bytes, event identity and upstream cursor before sending', async t => {
  const f = await setup(t), item = f.item('frame-durable')
  f.first.enqueue(item, png, { stream: 'screenpipe', cursor: { frameId: 12 } })
  assert.equal(f.first.status().queueEvents, 1)
  f.first.close()
  const resumed = f.client()
  assert.deepEqual(resumed.checkpoint('screenpipe'), { frameId: 12 })
  assert.equal(resumed.status().queueEvents, 1)
  await resumed.tick()
  assert.equal(resumed.status().queueEvents, 0)
  const record = f.service.snapshot().items[0]
  assert.ok((await f.service.image(record.ref)).bytes.equals(png))
  assert.ok(resumed.status().networkBytes > png.length)
})

test('response lost after server commit keeps the event, replays once after restart, and does not reupload the image', async t => {
  const f = await setup(t)
  f.first.enqueue(f.item('lost-response'), png)
  let lost = false
  f.intercept(async (operation, body, run) => {
    const result = await run()
    if (operation === 'ingest' && !lost && result.receipts.some(r => r.status === 'accepted')) {
      lost = true;throw Error('fixture-secret-never-persist token=DO_NOT_SAVE')
    }
    return result
  })
  await f.first.tick()
  assert.equal(f.first.status().queueEvents, 1)
  assert.equal(f.service.snapshot().items.length, 1)
  const chunks = f.calls.filter(c => c.operation === 'chunk').length
  f.first.close();const resumed = f.client();await resumed.tick()
  assert.equal(resumed.status().queueEvents, 0)
  assert.equal(f.calls.filter(c => c.operation === 'chunk').length, chunks)
  assert.equal(f.service.snapshot().items.length, 1)
  assert.doesNotMatch(readFileSync(join(f.root, 'device/observations.sqlite')).toString(), /fixture-secret-never-persist|DO_NOT_SAVE/)
})

test('partial receipts delete only successful rows and retain rejected input', async t => {
  const f = await setup(t)
  f.first.enqueue(f.item('good'))
  f.first.enqueue(f.item('bad-project', { projectId: 'p_not_found' }))
  await f.first.tick()
  assert.equal(f.first.status().queueEvents, 1)
  assert.equal(f.service.snapshot().items.length, 1)
  assert.match(f.first.status().lastError, /部分观察/)
  assert.equal(JSON.parse(f.first.db.prepare('SELECT body FROM pending').get().body).eventId, 'bad-project')
})

test('a full batch of rejected records remains durable without starving newer valid observations', async t => {
  const f = await setup(t)
  for (let index = 0; index < 25; index++) f.first.enqueue(f.item('bad-' + index, { projectId: 'p_not_found' }))
  await f.first.tick();assert.equal(f.first.status().retryEvents, 25)
  f.first.enqueue(f.item('new-good'))
  await f.first.tick()
  assert.equal(f.service.snapshot().items.length, 1)
  assert.equal(f.first.status().queueEvents, 25)
  assert.match(f.first.status().lastError, /25条资料等待重试/)
  f.first.close();const resumed = f.client()
  assert.equal(resumed.status().retryEvents, 25)
  resumed.enqueue(f.item('later-good'));await resumed.tick()
  assert.equal(f.service.snapshot().items.length, 2);assert.equal(resumed.status().queueEvents, 25)
})

test('queue pressure refuses new input without advancing its cursor or dropping old records', async t => {
  const f = await setup(t, { maxQueueBytes: 4 * 1024 * 1024 })
  let rejected = false, lastCursor = -1
  for (let index = 0; index < 400; index++) {
    try { f.first.enqueue(f.item('pressure-' + index, { text: '字'.repeat(15000) }), null, { stream: 'raw', cursor: index });lastCursor = index }
    catch (error) { assert.equal(error.code, 'QUEUE_FULL');rejected = true;break }
  }
  assert.equal(rejected, true)
  assert.equal(f.first.checkpoint('raw'), lastCursor)
  assert.equal(f.first.status().queueEvents, lastCursor + 1)
  assert.ok(f.first.status().queueBytes <= f.first.policy().maxQueueBytes)
})

test('application exclusion occurs before reading image bytes; newly excluded pending rows never go over the network', async t => {
  const f = await setup(t), current = f.service.policy('device-a')
  f.first.enqueue(f.item('pending-private', { app: '私密应用', text: 'PRIVATE_LOCAL_ONLY' }), png)
  await f.service.configure({ deviceId: 'device-a', policy: { ...Object.fromEntries(Object.entries(current).filter(([k]) => k !== 'revision')), excludeApps: ['私密应用'] }, expectedRevision: current.revision, requestId: 'exclude-app' })
  await f.first.tick()
  assert.equal(f.first.status().queueEvents, 0)
  assert.equal(f.service.snapshot().items.length, 0)
  assert.ok(!f.calls.some(c => JSON.stringify(c.body).includes('PRIVATE_LOCAL_ONLY')))
  let imageRead = false
  await f.first.enqueueWindow({ stream: 'window', cursor: 4, events: [{ id: 'excluded', app: '私密应用', text: 'HIDDEN', occurredAt: new Date().toISOString(), sourceRefs: ['raw-1'] }],
    items: [{ rawRef: 'raw-1', source: 'screen', occurredAt: new Date().toISOString(), context: { screenshotPath: '/not-read.png' } }] }, async () => { imageRead = true;return png })
  assert.equal(imageRead, false)
  assert.equal(f.first.checkpoint('window'), 4)
})

test('disabling images before delivery sends metadata/text only and records the missing picture honestly', async t => {
  const f = await setup(t), current = f.service.policy('device-a')
  f.first.enqueue(f.item('stop-image'), png)
  await f.service.configure({ deviceId: 'device-a', expectedRevision: current.revision, requestId: 'disable-image', policy: { enabled: true, uploadImages: false } })
  await f.first.tick()
  assert.equal(f.calls.filter(c => c.operation === 'chunk').length, 0)
  assert.equal(f.service.snapshot().items[0].mediaState, 'images_disabled')
  assert.equal(f.first.status().queueEvents, 0)
})

test('invalid or incomplete ACK never deletes the durable pending input', async t => {
  const f = await setup(t)
  f.first.enqueue(f.item('unsafe-ack'))
  f.intercept(async (operation, body, run) => operation === 'ingest' ? { ok: true, receipts: [{ eventId: 'unsafe-ack', status: 'accepted' }] } : run())
  await f.first.tick()
  assert.equal(f.first.status().queueEvents, 1)
  assert.match(f.first.status().lastError, /回执/)
  f.intercept(null);await f.first.tick()
  assert.equal(f.first.status().queueEvents, 0)
})

test('two instances share a durable monotonic lease without relying on a wall clock', async t => {
  let mono = 100
  const f = await setup(t), second = f.client({ now: () => Date.now() - 86400000, monotonic: () => mono })
  f.first.enqueue(f.item('shared-queue'))
  f.first.options.monotonic = () => mono
  assert.equal(f.first.claim(), true)
  const before = f.calls.length;await second.tick()
  assert.equal(f.calls.length, before)
  mono += 61
  await second.tick()
  assert.equal(second.status().queueEvents, 0)
  assert.equal(f.service.snapshot().items.length, 1)
})

test('old Mira frame priorities and hash/display selection keep bounded representative pictures', () => {
  const items = [
    { rawRef: 'timer', source: 'screen', occurredAt: '2026-01-01T00:02:00Z', context: { deviceName: 'display-a', trigger: 'timer', screenshotPath: '/timer.png' } },
    { rawRef: 'manual', source: 'screen', occurredAt: '2026-01-01T00:01:00Z', context: { deviceName: 'display-a', trigger: 'manual', screenshotPath: '/manual.png' } },
    { rawRef: 'other', source: 'accessibility', occurredAt: '2026-01-01T00:00:00Z', context: { deviceName: 'display-b', captureTrigger: 'app_switch', screenshotPath: '/other.png' } },
  ]
  assert.deepEqual(chooseObservationFrames(items, 2).map(i => i.rawRef), ['manual', 'other'])
  const rows = [{ id: 2, device_name: 'a', content_hash: 'same', timestamp: '2026-01-01T00:00:00Z', snapshot_path: '/a' },
    { id: 4, device_name: 'b', content_hash: 'new', timestamp: '2026-01-01T00:00:00Z', snapshot_path: '/b' }]
  assert.deepEqual(latestChangedFrames(rows, { a: 'same' }).map(r => r.id), [4])
})

test('ambiguous old multi-event windows remain text-only instead of borrowing another event image', async t => {
  const f = await setup(t), at = new Date().toISOString()
  let reads = 0
  await f.first.enqueueWindow({ stream: 'merged-window', cursor: 'window-done', events: [
    { id: 'event-1', text: '事项一', occurredAt: at, sourceRefs: ['raw-a', 'raw-b'] },
    { id: 'event-2', text: '事项二', occurredAt: at, sourceRefs: ['raw-a', 'raw-b'] },
  ], items: ['raw-a', 'raw-b'].map(rawRef => ({ rawRef, source: 'screen', occurredAt: at, context: { screenshotPath: '/unused.png' } })) }, async () => { reads++;return png })
  assert.equal(reads, 0)
  await f.first.tick()
  assert.ok(f.service.snapshot().items.every(item => item.media === null))
  assert.equal(f.first.checkpoint('merged-window'), 'window-done')
})

test('runner separates sampling and upload deadlines, and does not read while the device is unavailable', async t => {
  const f = await setup(t)
  let mono = 0, reads = 0, available = true
  const runner = new ObservationRunner({ client: f.first, monotonic: () => mono, available: () => available,
    sources: [{ collect: async client => { reads++;client.enqueue(f.item('runner-' + reads)) } }] })
  await runner.runOnce();assert.equal(reads, 1)
  mono = 9;await runner.runOnce();assert.equal(reads, 1)
  mono = 10;await runner.runOnce();assert.equal(reads, 2)
  assert.equal(f.service.snapshot().items.length, 0)
  mono = 29;await runner.runOnce();assert.equal(reads, 3)
  mono = 30;await runner.runOnce();assert.equal(f.service.snapshot().items.length, 3)
  available = false;mono = 60;await runner.runOnce();assert.equal(reads, 3)
})

test('Screenpipe adapter starts from now, stages selected bytes before cursor advance, and survives source-file removal', async t => {
  const f = await setup(t), dbPath = join(f.root, 'screenpipe.sqlite'), imageRoot = join(f.root, 'capture')
  mkdirSync(imageRoot);const file = join(imageRoot, 'frame.png');writeFileSync(file, png)
  const db = new DatabaseSync(dbPath);t.after(() => db.close())
  db.exec(`CREATE TABLE frames (id INTEGER PRIMARY KEY,timestamp TEXT,app_name TEXT,device_name TEXT,window_name TEXT,window_name_redacted_at TEXT,
    snapshot_path TEXT,image_redacted_at TEXT,accessibility_text TEXT,accessibility_redacted_at TEXT,content_hash TEXT)`)
  const insert = db.prepare('INSERT INTO frames VALUES (?,?,?,?,?,NULL,?,NULL,?,NULL,?)')
  insert.run(1, new Date().toISOString(), '编辑器', '主显示器', '旧页面', file, '不要补传旧历史', 'old')
  const source = new ScreenpipeObservationSource({ dbPath, imageRoot })
  await source.collect(f.first, async path => readFileSync(path));assert.equal(f.first.status().queueEvents, 0)
  insert.run(2, new Date().toISOString(), '编辑器', '主显示器', '新页面', file, '新的页面文字', 'new')
  await source.collect(f.first, async path => readFileSync(path));assert.equal(f.first.status().queueEvents, 1)
  assert.equal(f.first.checkpoint('screenpipe-frames').id, 2)
  unlinkSync(file);f.first.close();const resumed = f.client();await resumed.tick()
  assert.equal(resumed.status().queueEvents, 0)
  assert.equal(f.service.snapshot().items[0].text, '新的页面文字')
  assert.ok((await f.service.image(f.service.snapshot().items[0].ref)).bytes.equals(png))
  insert.run(3, new Date().toISOString(), '编辑器', '主显示器', '同图页面', file, '同图', 'new')
  await source.collect(resumed, async () => { throw Error('unchanged frame must not be read') })
  assert.equal(resumed.checkpoint('screenpipe-frames').id, 3)
})

test('completed-window source handles blank lines and journal rotation without resending or skipping new windows', async t => {
  const f = await setup(t), journal = join(f.root, 'windows.jsonl')
  const row = id => JSON.stringify({ windowId: id, flushReason: 'time_fallback', start: new Date(Date.now() - 1000000).toISOString(), end: new Date().toISOString(), eventTitles: ['活动 ' + id] }) + '\n'
  writeFileSync(journal, row('old'))
  const source = new MiraJournalObservationSource({ journal })
  await source.collect(f.first);assert.equal(f.first.status().queueEvents, 0)
  appendFileSync(journal, '\n' + row('new'))
  await source.collect(f.first);assert.equal(f.first.status().queueEvents, 1)
  assert.equal(f.first.checkpoint('mira-completed-windows').offset, readFileSync(journal).length)
  renameSync(journal, journal + '.old');writeFileSync(journal, row('rotated'))
  await source.collect(f.first);assert.equal(f.first.status().queueEvents, 2)
  await f.first.tick();assert.equal(f.service.snapshot().items.length, 2)
})

test('enabling during an unfinished journal line skips that historical remainder and reads the next complete record', async t => {
  const f = await setup(t), journal = join(f.root, 'partial.jsonl')
  const line = id => JSON.stringify({ windowId: id, flushReason: 'time_fallback', start: new Date(Date.now() - 10000).toISOString(), end: new Date().toISOString(), eventTitles: ['活动 ' + id] }) + '\n'
  const old = line('old'), split = Math.floor(old.length / 2)
  writeFileSync(journal, old.slice(0, split))
  const source = new MiraJournalObservationSource({ journal })
  await source.collect(f.first)
  appendFileSync(journal, old.slice(split) + line('new'))
  await source.collect(f.first);await f.first.tick()
  assert.equal(f.service.snapshot().items.length, 1)
  assert.equal(f.service.snapshot().items[0].text, '活动 new')
  assert.equal(f.first.checkpoint(source.stream).offset, readFileSync(journal).length)
})

test('missing redaction schema and invalid journal bytes fail without advancing source cursors', async t => {
  const f = await setup(t), dbPath = join(f.root, 'unsupported.sqlite'), journal = join(f.root, 'invalid.jsonl')
  const db = new DatabaseSync(dbPath);db.exec('CREATE TABLE frames(id INTEGER)');db.close()
  const source = new ScreenpipeObservationSource({ dbPath, imageRoot: f.root })
  await assert.rejects(source.collect(f.first, async () => png), e => e.code === 'SCREENPIPE_SCHEMA')
  assert.equal(f.first.checkpoint('screenpipe-frames'), null)
  writeFileSync(journal, Buffer.from([0xff, 10]))
  const windows = new MiraJournalObservationSource({ journal, startFromNow: false })
  await assert.rejects(windows.collect(f.first), e => e.code === 'SOURCE_INVALID_UTF8')
  assert.equal(f.first.checkpoint('mira-completed-windows').offset, 0)
})

test('known credential revocation retains pending data and blocks further capture until authentication works again', async t => {
  const f = await setup(t), fetcher = f.first.options.fetcher
  f.first.enqueue(f.item('before-revoke'))
  f.first.options.fetcher = async () => new Response('{}', { status: 401 })
  await f.first.tick()
  assert.equal(f.first.status().queueEvents, 1)
  assert.throws(() => f.first.enqueue(f.item('after-revoke')), e => e.code === 'OBSERVATION_PAUSED')
  let reads = 0
  const runner = new ObservationRunner({ client: f.first, sources: [{ collect: async () => { reads++ } }] })
  await runner.runOnce();assert.equal(reads, 0)
  f.first.options.fetcher = fetcher;await f.first.tick();assert.equal(f.first.status().queueEvents, 0)
})

test('a valid token for the wrong device blocks collection while retaining the original pending queue', async t => {
  const f = await setup(t);f.first.enqueue(f.item('original-pending'))
  f.intercept(async (op, body, run) => op === 'hello' ? { ...(await run()), deviceId: 'other-device' } : run())
  await f.first.tick();assert.equal(f.first.get('transportBlocked'), true);assert.equal(f.first.status().queueEvents, 1)
  let read = false
  const runner = new ObservationRunner({ client: f.first, sources: [{ collect: async () => { read = true } }] })
  await runner.runOnce();assert.equal(read, false)
  f.intercept(null);await f.first.tick();assert.equal(f.first.status().queueEvents, 0)
})

test('Electron encoding validates bounded pixels before invoking the native decoder', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mira-native-raster-'));t.after(() => rmSync(root, { recursive: true, force: true }))
  const invalid = Buffer.from(png);invalid.writeUInt32BE(8192, 16);invalid.writeUInt32BE(8192, 20)
  const file = join(root, 'frame.png');writeFileSync(file, invalid)
  let decoded = false
  const encode = electronObservationEncoder({ createFromBuffer() { decoded = true;throw Error('native decode must not happen') } })
  await assert.rejects(encode(file), /有界PNG\/JPEG/);assert.equal(decoded, false)
})

test('a failing source does not prevent independent source progress and keeps its own cursor', async t => {
  const f = await setup(t)
  const runner = new ObservationRunner({ client: f.first, sources: [
    { collect: async () => { const e = new Error('来源暂时不可用');e.code = 'SOURCE_UNAVAILABLE';throw e } },
    { collect: async client => client.enqueue(f.item('healthy-source'), null, { stream: 'healthy', cursor: 1 }) },
  ] })
  await runner.runOnce()
  assert.equal(f.first.checkpoint('healthy'), 1);assert.equal(f.first.status().queueEvents, 1)
  assert.match(f.first.status().lastError, /来源暂时不可用/)
  await f.first.tick();assert.equal(f.service.snapshot().items.length, 1)
  assert.ok(f.store.get('hub').events.some(event => event.type === 'observation.accepted' && event.eventId === 'healthy-source'))
})
