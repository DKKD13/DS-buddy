import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../lib/store.js'
import { FileBlobs, ProjectFiles } from '../lib/files.js'
import { Actions } from '../lib/actions.js'
import { createTools } from '../lib/tools.js'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'mira-files-'));t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore(join(root, 'data'), { warn() {} })
  const project = store.createProject({ name: 'Files', instructions: '' }), id = project.projectId
  const blobs = new FileBlobs(join(root, 'blobs'));await blobs.initialize()
  const files = new ProjectFiles(store, { deliver() {} }, { blobs })
  return { root, store, id, blobs, files }
}
test('immutable project-scoped bytes survive reconstruction and reject missing or corrupt content', async t => {
  const f = await setup(t), bytes = Buffer.from([0, 255, 1, 80])
  const hash = await f.blobs.put(f.id, bytes), other = new FileBlobs(join(f.root, 'blobs'));await other.initialize()
  assert.deepEqual(await other.read(f.id, hash), bytes)
  await assert.rejects(other.read('other-project', hash), /不存在/)
  await writeFile(other.location(f.id, hash), 'corrupt')
  await assert.rejects(other.read(f.id, hash), /完整性/)
  await assert.rejects(other.put(f.id, bytes), /完整性/)
})
test('blob roots and existing objects cannot redirect through symbolic links', async t => {
  const f = await setup(t), hash = await f.blobs.put(f.id, Buffer.from('original')), path = f.blobs.location(f.id, hash)
  const outside = join(f.root, 'outside');await writeFile(outside, 'outside')
  await rm(path);await symlink(outside, path)
  await assert.rejects(f.blobs.read(f.id, hash))
  await assert.rejects(f.blobs.put(f.id, Buffer.from('original')))
  assert.equal(await readFile(outside, 'utf8'), 'outside')
  await symlink(join(f.root, 'blobs'), join(f.root, 'alias'))
  await assert.rejects(new FileBlobs(join(f.root, 'alias')).initialize(), /规范/)
})
test('file publication records versions and requires a current revision for concurrent changes', async t => {
  const f = await setup(t)
  const first = await f.files.writeText(f.id, 'owner', { path: 'notes/计划.md', text: 'first', expected_revision: 0, requestId: 'write-1' })
  assert.equal(first.revision, 1)
  const second = await f.files.writeText(f.id, 'owner', { path: first.path, text: 'second', expected_revision: 1, requestId: 'write-2' })
  assert.equal(second.id, first.id);assert.equal(second.revision, 2)
  await assert.rejects(f.files.writeText(f.id, 'owner', { path: first.path, text: 'stale', expected_revision: 1 }), /版本/)
  assert.equal((await f.files.read(f.id, { path: first.path })).bytes.toString(), 'second')
  assert.equal((await f.files.read(f.id, { path: first.path, revision: 1 })).bytes.toString(), 'first')
  assert.equal(f.files.list(f.id).length, 1)
  const loaded = new ProjectStore(join(f.root, 'data'), { warn() {} });loaded.load()
  const restored = new ProjectFiles(loaded, { deliver() {} }, { blobs: f.blobs })
  assert.equal((await restored.read(f.id, { file_id: first.id })).file.revision, 2)
})
test('response-loss replay preserves the old version while a conflicting request id is rejected', async t => {
  const f = await setup(t), input = { path: 'result.txt', text: 'one', expected_revision: 0, requestId: 'same-request' }
  const first = await f.files.writeText(f.id, 'owner', input)
  await f.files.writeText(f.id, 'owner', { path: input.path, text: 'two', expected_revision: 1 })
  assert.deepEqual(await f.files.writeText(f.id, 'owner', input), first)
  await assert.rejects(f.files.writeText(f.id, 'owner', { ...input, text: 'changed' }), /请求/)
  assert.equal(f.store.get(f.id).events.filter(e => e.type === 'file.published').length, 2)
})
test('concurrent local writes have one winner and preserve the losing version', async t => {
  const f = await setup(t)
  const result = await Promise.allSettled(['A', 'B'].map(text => f.files.writeText(f.id, 'owner', { path: 'shared.txt', text, expected_revision: 0 })))
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(f.store.get(f.id).events.filter(e => e.type === 'file.published').length, 1)
})
test('explicit workspace publication follows only in-scope regular files and does not scan the directory', async t => {
  const f = await setup(t), workspace = join(f.root, 'workspace');await mkdir(workspace)
  await writeFile(join(workspace, 'deliver.txt'), 'DELIVER');await writeFile(join(workspace, 'private.txt'), 'NOT_PUBLISHED')
  const files = new ProjectFiles(f.store, { deliver() {} }, { blobs: f.blobs, workspace: () => workspace })
  await files.publishWorkspace(f.id, 'owner', { path: 'deliver.txt', expected_revision: 0 })
  assert.deepEqual(files.list(f.id).map(file => file.path), ['deliver.txt'])
  const outside = join(f.root, 'secret.txt');await writeFile(outside, 'outside');await symlink(outside, join(workspace, 'escape.txt'))
  await assert.rejects(files.publishWorkspace(f.id, 'owner', { path: 'escape.txt', expected_revision: 0 }), /目录/)
  assert.equal(files.list(f.id).length, 1)
})
test('library paths, revisions and writers are validated before publication', async t => {
  const f = await setup(t)
  for (const path of ['../escape', '/absolute', 'a/../b', 'a\\b', 'a//b', 'a/./b', '.', 'a\0b']) {
    await assert.rejects(f.files.writeText(f.id, 'owner', { path, text: 'bad', expected_revision: 0 }))
  }
  for (const key of ['mira', 'coordinator', 'w:missing']) await assert.rejects(f.files.writeText(f.id, key, { path: 'bad', text: 'bad', expected_revision: 0 }))
  await assert.rejects(f.files.writeText(f.id, 'owner', { path: 'bad', text: 'bad', expected_revision: -1 }))
  assert.equal(f.files.list(f.id).length, 0)
})
test('message attachments require existing files and retain stable identities across updates', async t => {
  const f = await setup(t), one = await f.files.writeText(f.id, 'owner', { path: 'deliver.md', text: 'one', expected_revision: 0 })
  assert.deepEqual(f.files.attachments(f.id, ['deliver.md', 'deliver.md']), [{ fileId: one.id, path: 'deliver.md', revision: 1 }])
  assert.throws(() => f.files.attachments(f.id, ['missing']), /不存在/)
  await f.files.writeText(f.id, 'owner', { path: 'deliver.md', text: 'two', expected_revision: 1 })
  assert.equal(f.files.attachments(f.id, ['deliver.md'])[0].fileId, one.id)
})
test('the same DSH tool call replays its committed file revision after later edits', async t => {
  const f = await setup(t), driver = { deliver() {}, turnOf: () => ({}), status: () => 'idle' }, actions = new Actions(f.store, driver, { files: f.files })
  const project = f.store.get(f.id), { threadId } = actions.openThread(project, { title: 'Replay', brief: 'File', assignee: '工程师' })
  f.store.append(f.id, { type: 'session.bound', key: 'w:' + threadId, sessionId: 'file-session', assignee: 'engineer', generation: 1 })
  const definition = createTools({ defineTool: d => d, store: f.store, driver, actions, files: f.files }).find(t => t.definition.name === 'project_files_write').definition
  const args = { path: 'replayed.txt', text: 'one', expected_revision: 0 }, exec = { agent: { id: 'file-session' }, callId: 'original-call' }
  const first = await definition.execute(args, exec)
  await f.files.writeText(f.id, 'owner', { path: args.path, text: 'two', expected_revision: 1 })
  assert.equal(await definition.execute(args, exec), first)
  assert.equal(f.store.get(f.id).events.filter(e => e.type === 'file.published').length, 2)
})

test('the file store lock lets one holder in at a time, also between two stores on the same folder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mira-lock-'));t.after(() => rm(root, { recursive: true, force: true }))
  const a = new FileBlobs(join(root, 'blobs')), b = new FileBlobs(join(root, 'blobs')), order = []
  let release
  const held = new Promise(resolve => { release = resolve })
  const first = a.withLock(async () => { order.push('a in');await held;order.push('a out') })
  await new Promise(resolve => setTimeout(resolve, 300))
  const second = b.withLock(async () => { order.push('b in') })
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(order.join(), 'a in')
  release();await first;await second
  assert.equal(order.join(), 'a in,a out,b in')
})
