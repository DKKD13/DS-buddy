import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ProjectStore } from '../lib/store.js'
import { ensureHub } from '../lib/hub.js'
import { Observations, observationPolicy, observationImage } from '../lib/observations.js'
import { PersonalMira } from '../lib/personal.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=', 'base64')
function setup(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mira-observations-'));t.after(() => rmSync(root, { recursive: true, force: true }))
  const hub = new ProjectStore(join(root, 'hub-store'), { warn() {} });hub.load();ensureHub(hub)
  const projects = new ProjectStore(join(root, 'projects'), { warn() {} });projects.load()
  let clock = Date.now()
  const service = new Observations(hub, projects, { root: join(root, 'images'), now: () => clock, ...options })
  t.after(() => service.close())
  const register = async (id = 'device-a', policy = {}) => {
    service.hello(id, id)
    return service.configure({ deviceId: id, policy: { enabled: true, uploadImages: true, ...policy }, expectedRevision: 0, requestId: 'configure-' + id })
  }
  const event = (id, extra = {}) => ({ eventId: id, localSeq: 1, source: 'screen', occurredAt: clock - 1000, app: '测试应用', title: '发布页面', text: '原始界面观察，不是用户授权', ...extra })
  const media = async (id, revision) => {
    const chunk = await service.chunk(id, { revision, data: png.toString('base64') })
    return { ...observationImage(png), chunks: [chunk.sha256] }
  }
  return { root, hub, projects, service, register, event, media, advance: ms => { clock += ms } }
}

test('observation policies default off, validate each frequency and CAS/replay owner changes', async t => {
  const f = setup(t);f.service.hello('device-a', '设备甲')
  assert.equal(f.service.policy('device-a').enabled, false)
  assert.equal(f.service.policy('device-a').uploadImages, false)
  assert.throws(() => observationPolicy({ lateMinutes: 0 }), /无效/)
  assert.throws(() => observationPolicy({ excludeApps: [''] }), /无效/)
  const request = { deviceId: 'device-a', policy: { enabled: true }, expectedRevision: 0, requestId: 'policy-test' }
  const a = await f.service.configure(request), b = await f.service.configure(request)
  assert.equal(a.revision, b.revision)
  await assert.rejects(f.service.configure({ ...request, requestId: 'policy-stale' }), /已变化/)
  await assert.rejects(f.service.configure({ ...request, policy: { enabled: false } }), /不一致/)
})

test('two device identities preserve different same-ID observations and reject altered retries', async t => {
  const f = setup(t), a = await f.register(), b = await f.register('device-b')
  const item = f.event('same-id')
  const first = await f.service.ingest('device-a', { revision: a.revision, events: [item] })
  const duplicate = await f.service.ingest('device-a', { revision: a.revision, events: [item] })
  const other = await f.service.ingest('device-b', { revision: b.revision, events: [{ ...item, text: '乙设备不同内容' }] })
  assert.equal(first.receipts[0].status, 'accepted');assert.equal(duplicate.receipts[0].status, 'duplicate')
  assert.notEqual(first.receipts[0].ref, other.receipts[0].ref)
  const bad = await f.service.ingest('device-a', { revision: a.revision, events: [{ ...item, text: '伪造重放' }] })
  assert.equal(bad.receipts[0].code, 'EVENT_CONFLICT')
  assert.equal(f.service.snapshot().items.length, 2)
  assert.equal(f.hub.unread(f.service.hub, 'mira').length, 0, 'ordinary observations do not wake the model')
})

test('partial receipts ACK only durable items and survive process-local store reconstruction', async t => {
  const f = setup(t), p = await f.register()
  const good = f.event('durable-1'), bad = f.event('invalid-1', { source: 'principal' })
  const result = await f.service.ingest('device-a', { revision: p.revision, events: [good, bad] })
  assert.deepEqual(result.receipts.map(r => r.status), ['accepted', 'error'])
  const store = new ProjectStore(f.hub.root, { warn() {} });store.load()
  const recovered = new Observations(store, f.projects, { root: join(f.root, 'images') });t.after(() => recovered.close())
  const replay = await recovered.ingest('device-a', { revision: p.revision, events: [good] })
  assert.equal(replay.receipts[0].status, 'duplicate')
  assert.equal(recovered.snapshot().items.length, 1)
})

test('raster images are verified, bound to their source, protected from GC and never enter Library', async t => {
  const f = setup(t), p = await f.register(), media = await f.media('device-a', p.revision)
  const result = await f.service.ingest('device-a', { revision: p.revision, events: [f.event('frame-1', { media })] })
  assert.equal(result.receipts[0].mediaStored, true)
  const ref = result.receipts[0].ref, image = await f.service.image(ref)
  assert.ok(image.bytes.equals(png));assert.equal(image.mime, 'image/png')
  const objects = await f.service.blobs.listObjects()
  assert.equal(objects.length, 1)
  f.advance(2 * 3600000)
  await f.service.maintenance.collect()
  assert.ok((await f.service.image(ref)).bytes.equals(png))
  assert.equal(f.projects.projects.size, 0)
  assert.equal(f.service.hub.files.size, 0)
  assert.throws(() => observationImage(Buffer.from('<svg>' + ' '.repeat(100))), /只支持/)
})

test('images not uploaded cannot get a receipt, and mismatched dimensions or foreign device chunks are refused', async t => {
  const f = setup(t), a = await f.register(), b = await f.register('device-b'), media = await f.media('device-a', a.revision)
  const foreign = await f.service.ingest('device-b', { revision: b.revision, events: [f.event('foreign', { media })] })
  assert.equal(foreign.receipts[0].status, 'error')
  const mismatch = await f.service.ingest('device-a', { revision: a.revision, events: [f.event('mismatch', { media: { ...media, width: 2 } })] })
  assert.equal(mismatch.receipts[0].status, 'error')
  assert.equal(f.service.snapshot().items.length, 0)
})

test('pause prevents new writes, duplicate ACKs still replay, app exclusions persist no private body', async t => {
  const f = setup(t), p = await f.register(), first = f.event('already-saved')
  await f.service.ingest('device-a', { revision: p.revision, events: [first] })
  const paused = await f.service.configure({ deviceId: 'device-a', policy: { enabled: false }, expectedRevision: p.revision, requestId: 'pause-device' })
  const result = await f.service.ingest('device-a', { revision: p.revision, events: [first, f.event('not-saved')] })
  assert.deepEqual(result.receipts.map(r => r.status), ['duplicate', 'error'])
  assert.equal(result.receipts[1].code, 'OBSERVATION_PAUSED')
  const resumed = await f.service.configure({ deviceId: 'device-a', policy: { enabled: true, excludeApps: ['私密应用'] }, expectedRevision: paused.revision, requestId: 'exclude-device' })
  const excluded = await f.service.ingest('device-a', { revision: resumed.revision, events: [f.event('private-event', { app: '私密应用', text: 'PRIVATE_MUST_NOT_PERSIST' })] })
  assert.equal(excluded.receipts[0].status, 'excluded')
  assert.doesNotMatch(readFileSync(join(f.hub.root, 'hub/events.jsonl'), 'utf8'), /PRIVATE_MUST_NOT_PERSIST/)
})

test('turning images off accepts text with an explicit omitted marker, never fetches image bytes', async t => {
  const f = setup(t), p = await f.register('device-a', { uploadImages: false })
  const media = { ...observationImage(png), chunks: [createHash('sha256').update(png).digest('hex')] }
  const result = await f.service.ingest('device-a', { revision: p.revision, events: [f.event('text-only', { media })] })
  assert.equal(result.receipts[0].status, 'accepted');assert.equal(result.receipts[0].mediaStored, false)
  assert.equal(f.service.snapshot().items[0].mediaState, 'images_disabled')
  assert.equal((await f.service.blobs.listObjects()).length, 0)
})

test('offline out-of-order records paginate by occurrence time without dropping high-sequence old events', async t => {
  const f = setup(t), p = await f.register(), now = Date.now()
  for (const [id, occurredAt] of [['newest', now], ['oldest', now - 30000], ['middle', now - 10000]])
    await f.service.ingest('device-a', { revision: p.revision, events: [f.event(id, { occurredAt })] })
  const one = f.service.snapshot({ limit: 1 }), two = f.service.snapshot({ limit: 1, before: one.nextCursor }), three = f.service.snapshot({ limit: 1, before: two.nextCursor })
  assert.ok(one.items[0].happenedAt > two.items[0].happenedAt && two.items[0].happenedAt > three.items[0].happenedAt)
  assert.equal(new Set([one, two, three].map(x => x.items[0].ref)).size, 3)
  assert.equal(three.hasMore, false)
})

test('retention and explicit clear stop image access and delete unreferenced bytes, with durable replay', async t => {
  const f = setup(t), p = await f.register('device-a', { imageRetentionDays: 1 }), media = await f.media('device-a', p.revision)
  const accepted = await f.service.ingest('device-a', { revision: p.revision, events: [f.event('clear-image', { media })] })
  const input = { deviceId: 'device-a', expectedRevision: p.revision, requestId: 'clear-device-media' }
  const result = await f.service.clearMedia(input)
  assert.deepEqual(await f.service.clearMedia(input), result)
  await assert.rejects(f.service.image(accepted.receipts[0].ref), /未保存或已过/)
  assert.equal((await f.service.blobs.listObjects()).length, 0)
  assert.equal(f.service.snapshot().items[0].text, '原始界面观察，不是用户授权')
})

test('image retention uses receipt time for offline uploads and never claims missing frames are video', async t => {
  const f = setup(t), p = await f.register('device-a', { imageRetentionDays: 1 }), media = await f.media('device-a', p.revision)
  const old = f.event('offline-image', { occurredAt: Date.now() - 30 * 86400000, media })
  const result = await f.service.ingest('device-a', { revision: p.revision, events: [old] })
  assert.ok((await f.service.image(result.receipts[0].ref)).bytes.equals(png))
  f.advance(86400001)
  assert.equal(f.service.snapshot().items[0].mediaState, 'expired')
  await f.service.maintenance.collect()
  assert.equal((await f.service.blobs.listObjects()).length, 0)
  await f.service.configure({ deviceId: 'device-a', expectedRevision: p.revision, requestId: 'extend-retention', policy: { enabled: true, uploadImages: true, imageRetentionDays: 30 } })
  assert.equal(f.service.snapshot().items[0].mediaState, 'expired')
  await assert.rejects(f.service.image(result.receipts[0].ref), /未保存或已过/)
})

test('server image quota failure retains the event until capacity is restored', async t => {
  const f = setup(t, { quotaBytes: png.length - 1 }), p = await f.register('device-a')
  await assert.rejects(f.media('device-a', p.revision), error => error.code === 'FILE_QUOTA_EXCEEDED')
  assert.equal(f.service.snapshot().items.length, 0)
  f.service.blobs.quotaBytes = png.length;f.service.maintenance.quotaBytes = png.length
  const media = await f.media('device-a', p.revision)
  const result = await f.service.ingest('device-a', { revision: p.revision, events: [f.event('after-quota', { media })] })
  assert.equal(result.receipts[0].status, 'accepted')
  assert.ok((await f.service.image(result.receipts[0].ref)).bytes.equals(png))
})

test('window summaries wait for late records, version corrections, preserve old source refs and search only current versions', async t => {
  const f = setup(t), p = await f.register('device-a', { summaryMinutes: 1, lateMinutes: 7 })
  const occurredAt = Date.now() - 1000
  await f.service.ingest('device-a', { revision: p.revision, events: [f.event('window-first', { occurredAt, text: '窗口事项甲' })] })
  assert.equal((await f.service.summarize()).updated, 0)
  f.advance(9 * 60000)
  assert.equal((await f.service.summarize()).updated, 1)
  const old = f.service.snapshot({ source: 'summary' }).items[0]
  assert.equal(old.summaryVersion, 1)
  assert.equal(old.sourceRefs.length, 1)
  await f.service.ingest('device-a', { revision: p.revision, events: [f.event('window-late', { occurredAt, text: '迟到事项乙' })] })
  assert.equal((await f.service.summarize()).updated, 1)
  const latest = f.service.snapshot({ source: 'summary' }).items[0]
  assert.equal(latest.summaryVersion, 2)
  assert.equal(latest.sourceRefs.length, 2)
  const personal = new PersonalMira(f.hub, { status: () => 'idle' }, f.projects, {}, { observations: f.service })
  assert.match(personal.source(old.ref).text, /共1条观察/)
  assert.equal(personal.source(old.ref).supersededBy, latest.ref)
  assert.equal(personal.search({ query: '窗口摘要' }).items.length, 1)
  assert.equal((await f.service.summarize()).updated, 0)
})

test('important signals are opt-in and throttled, unavailable model delivery never blocks data ACK', async t => {
  let available = false, wakes = 0
  const f = setup(t, { notify: () => { wakes++;if (!available) throw Error('fixture model unavailable') } })
  let p = await f.register()
  await f.service.ingest('device-a', { revision: p.revision, events: [f.event('ordinary', { important: true })] })
  assert.equal(wakes, 0)
  p = await f.service.configure({ deviceId: 'device-a', expectedRevision: p.revision, requestId: 'important-on', policy: { enabled: true, importantWakeMinutes: 20 } })
  const record = f.event('important-first', { important: true })
  const result = await f.service.ingest('device-a', { revision: p.revision, events: [record] })
  assert.equal(result.receipts[0].status, 'accepted');assert.equal(wakes, 1)
  assert.equal(f.service.snapshot().devices[0].notificationPending, true)
  await f.service.retryImportant();assert.equal(wakes, 1)
  f.advance(20 * 60000);available = true
  await f.service.retryImportant();assert.equal(wakes, 2)
  f.hub.append('hub', { type: 'inbox.acked', key: 'mira', cursor: f.service.hub.seq })
  f.advance(20 * 60000)
  await f.service.ingest('device-a', { revision: p.revision, events: [record] })
  assert.equal(wakes, 2, 'a duplicate observation never repeats an acknowledged notification')
})

test('an important signal arriving during the throttle window is delivered later, after the earlier wake is acked', async t => {
  let wakes = 0
  const f = setup(t, { notify: () => { wakes++ } }), p = await f.register('device-a', { importantWakeMinutes: 20 })
  await f.service.ingest('device-a', { revision: p.revision, events: [f.event('important-a', { important: true })] })
  f.hub.append('hub', { type: 'inbox.acked', key: 'mira', cursor: f.service.hub.seq })
  await f.service.ingest('device-a', { revision: p.revision, events: [f.event('important-b', { important: true })] })
  assert.equal(wakes, 1)
  f.advance(20 * 60000);await f.service.retryImportant()
  assert.equal(wakes, 2)
})
