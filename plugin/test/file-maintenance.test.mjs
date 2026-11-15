import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileBlobs, ProjectFiles } from '../lib/files.js'
import { ProjectStore } from '../lib/store.js'
import { BlobMaintenance, liveBlobKeysFromStore } from '../lib/blob-maintenance.js'

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mira-blob-maintenance-'));t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(join(root, 'data'), { warn() {} }), project = store.createProject({ name: 'Storage', instructions: '' })
  const blobs = new FileBlobs(join(root, 'blobs'), options);await blobs.initialize()
  const files = new ProjectFiles(store, { deliver() {} }, { blobs })
  return { root, store, id: project.projectId, blobs, files }
}

test('duplicate immutable objects do not consume additional quota', async t => {
  const f = await setup(t, { quotaBytes: 10 }), six = Buffer.from('123456')
  assert.equal(await f.blobs.put(f.id, six), await f.blobs.put(f.id, six))
  await f.blobs.put(f.id, Buffer.from('abcd'))
  await assert.rejects(f.blobs.put(f.id, Buffer.from('x')), { code: 'FILE_QUOTA_EXCEEDED' })
  assert.equal(await f.blobs.put(f.id, six), await f.blobs.put(f.id, six))
  assert.equal(await f.blobs.usage(), 10)
})

test('concurrent writers cannot both cross the shared quota', async t => {
  const f = await setup(t, { quotaBytes: 64 })
  const results = await Promise.allSettled([f.blobs.put(f.id, Buffer.alloc(48, 1)), f.blobs.put(f.id, Buffer.alloc(48, 2))])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'FILE_QUOTA_EXCEEDED')
  assert.ok(await f.blobs.usage() <= 64)
})

test('GC preserves every referenced version and recent uploads while deleting only expired orphans', async t => {
  const f = await setup(t), first = await f.files.writeText(f.id, 'owner', { path: 'spec.txt', text: 'one', expected_revision: 0 })
  const second = await f.files.writeText(f.id, 'owner', { path: 'spec.txt', text: 'two', expected_revision: 1 })
  const orphan = await f.blobs.put(f.id, Buffer.from('orphan')), recent = await f.blobs.put(f.id, Buffer.from('recent'))
  const observedNow = (await stat(f.blobs.location(f.id, recent))).mtimeMs + 25
  const parent = await f.blobs.directory(f.id, true)
  await writeFile(join(parent, '.upload-old'), 'stale')
  const scratch = join(f.blobs.root, '.git-imports', 'import-old');await mkdir(scratch, { recursive: true });await writeFile(join(scratch, 'scratch'), 'old')
  const old = Date.now() / 1000 - 60
  await utimes(f.blobs.location(f.id, orphan), old, old);await utimes(join(parent, '.upload-old'), old, old);await utimes(join(scratch, 'scratch'), old, old)
  const maintenance = new BlobMaintenance(f.blobs, { liveKeys: () => liveBlobKeysFromStore(f.store, f.blobs), retentionMs: 50, now: () => observedNow })
  const result = await maintenance.collect()
  assert.equal(result.deletedObjects, 3)
  await assert.rejects(f.blobs.read(f.id, orphan), /不存在/)
  assert.equal((await f.blobs.read(f.id, first.sha256)).toString(), 'one')
  assert.equal((await f.blobs.read(f.id, second.sha256)).toString(), 'two')
  assert.equal((await f.blobs.read(f.id, recent)).toString(), 'recent')
})

test('GC refuses to run without a live event reference provider', async t => {
  const f = await setup(t)
  assert.throws(() => new BlobMaintenance(f.blobs, { retentionMs: 1 }), /引用清单/)
})

test('quota collection can reclaim only expired unreferenced capacity before a new write', async t => {
  const f = await setup(t, { quotaBytes: 8 }), orphan = await f.blobs.put(f.id, Buffer.alloc(8, 7))
  const old = Date.now() / 1000 - 60;await utimes(f.blobs.location(f.id, orphan), old, old)
  new BlobMaintenance(f.blobs, { liveKeys: () => liveBlobKeysFromStore(f.store, f.blobs), quotaBytes: 8, retentionMs: 50 })
  assert.equal((await f.blobs.put(f.id, Buffer.from('new'))).length, 64)
  assert.equal(await f.blobs.usage(), 3)
})

test('publication and GC serialize so an old orphan becomes referenced before collection', async t => {
  const f = await setup(t), orphan = await f.blobs.put(f.id, Buffer.from('old-orphan'))
  const old = Date.now() / 1000 - 60;await utimes(f.blobs.location(f.id, orphan), old, old)
  const maintenance = new BlobMaintenance(f.blobs, { liveKeys: () => liveBlobKeysFromStore(f.store, f.blobs), retentionMs: 5 })
  const read = f.blobs.read.bind(f.blobs)
  f.blobs.read = async (...args) => { await new Promise(resolve => setTimeout(resolve, 50));return read(...args) }
  const publishing = f.files.publishBlob(f.id, 'owner', { path: 'old.txt', sha256: orphan, expected_revision: 0 })
  const collecting = maintenance.collect()
  await publishing;await collecting
  assert.equal((await f.blobs.read(f.id, orphan)).toString(), 'old-orphan')
  assert.equal(f.store.get(f.id).events.filter(e => e.type === 'file.published').length, 1)
})

test('GC takes a defensive reference snapshot even if the provider set is later mutated', async t => {
  const f = await setup(t), referenced = await f.blobs.put(f.id, Buffer.from('referenced')), orphan = await f.blobs.put(f.id, Buffer.from('orphan'))
  const old = Date.now() / 1000 - 60;await utimes(f.blobs.location(f.id, referenced), old, old);await utimes(f.blobs.location(f.id, orphan), old, old)
  const live = new Set([f.blobs.location(f.id, referenced)]), list = f.blobs.listObjects.bind(f.blobs)
  f.blobs.listObjects = async directory => { live.clear();return list(directory) }
  const result = await new BlobMaintenance(f.blobs, { liveKeys: async () => live, retentionMs: 5 }).collect()
  assert.equal(result.deletedObjects, 1)
  assert.equal((await f.blobs.read(f.id, referenced)).toString(), 'referenced')
  await assert.rejects(f.blobs.read(f.id, orphan), /不存在/)
})

test('GC reports exact usage from one consistent object scan without a second backend listing', async t => {
  const f = await setup(t), referenced = await f.files.writeText(f.id, 'owner', { path: 'keep.txt', text: 'keep', expected_revision: 0 })
  const orphan = await f.blobs.put(f.id, Buffer.from('orphan'))
  const old = Date.now() / 1000 - 60;await utimes(f.blobs.location(f.id, orphan), old, old)
  const list = f.blobs.listObjects.bind(f.blobs);let rootCalls = 0
  f.blobs.listObjects = async directory => { if ((directory ?? f.blobs.root) === f.blobs.root) rootCalls++;return list(directory) }
  const result = await new BlobMaintenance(f.blobs, { liveKeys: () => liveBlobKeysFromStore(f.store, f.blobs), retentionMs: 5 }).collect()
  assert.equal(rootCalls, 1)
  assert.equal(result.deletedObjects, 1)
  assert.equal(result.usage, referenced.size)
})

test('maintenance quota counts an incoming temp object once even at the exact limit', async t => {
  const f = await setup(t, { quotaBytes: 10 })
  new BlobMaintenance(f.blobs, { liveKeys: () => liveBlobKeysFromStore(f.store, f.blobs), quotaBytes: 10 })
  await f.blobs.put(f.id, Buffer.alloc(10, 1))
  assert.equal(await f.blobs.usage(), 10)
})

test('a backend listing failure cannot delete any object', async t => {
  const f = await setup(t), orphan = await f.blobs.put(f.id, Buffer.from('orphan'))
  const old = Date.now() / 1000 - 60;await utimes(f.blobs.location(f.id, orphan), old, old)
  f.blobs.listObjects = async () => { throw new Error('second page unavailable') }
  await assert.rejects(new BlobMaintenance(f.blobs, { liveKeys: () => liveBlobKeysFromStore(f.store, f.blobs), retentionMs: 5 }).collect(), /second page/)
  assert.equal((await f.blobs.read(f.id, orphan)).toString(), 'orphan')
})
