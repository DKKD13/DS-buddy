import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ProjectStore } from '../lib/store.js'
import { FileBlobs, ProjectFiles } from '../lib/files.js'
import { ProjectRepositories, checkoutRepository } from '../lib/repositories.js'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'mira-repos-'));t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source');await mkdir(source)
  git(source, 'init', '-b', 'main');git(source, 'config', 'user.name', 'Repo QA');git(source, 'config', 'user.email', 'qa@local.invalid')
  await writeFile(join(source, 'README.md'), 'IMPORTED_SOURCE_V1\n');await symlink('README.md', join(source, 'readme-link'))
  git(source, 'add', '.');git(source, 'commit', '-m', 'one');const first = git(source, 'rev-parse', 'HEAD')
  await writeFile(join(source, 'README.md'), 'IMPORTED_SOURCE_V2\n');git(source, 'add', '.');git(source, 'commit', '-m', 'two')
  const second = git(source, 'rev-parse', 'HEAD');await writeFile(join(source, 'untracked-secret'), 'NOT_IMPORTED')
  const store = new ProjectStore(join(root, 'data'), { warn() {} }), projectId = store.createProject({ name: 'Repo', instructions: '' }).projectId
  const blobs = new FileBlobs(join(root, 'blobs'));await blobs.initialize()
  const files = new ProjectFiles(store, { deliver() {} }, { blobs }), repos = new ProjectRepositories(files)
  return { root, source, first, second, store, projectId, blobs, files, repos }
}
test('explicit import preserves the selected commit/history and excludes uncommitted files and Git config', async t => {
  const f = await setup(t), imported = await f.repos.import(f.projectId, { sourcePath: f.source, ref: f.first, expected_revision: 0, requestId: 'first-import' })
  assert.equal(imported.commit, f.first);assert.equal(imported.revision, 1)
  const bundle = (await f.files.read(f.projectId, { file_id: imported.fileId, revision: imported.fileRevision })).bytes
  const dest = join(f.root, 'checkout')
  await checkoutRepository({ destination: dest, repository: imported, bytes: bundle, branch: 'codex/repo-qa' })
  assert.equal(git(dest, 'rev-parse', 'HEAD'), f.first)
  assert.equal(await readFile(join(dest, 'README.md'), 'utf8'), 'IMPORTED_SOURCE_V1\n')
  assert.equal((await lstat(join(dest, 'readme-link'))).isSymbolicLink(), true)
  await assert.rejects(readFile(join(dest, 'untracked-secret')))
  assert.equal(git(dest, 'remote'), '')
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.second)
})
test('repository import rejects stale changes and preserves immutable versions on response replay', async t => {
  const f = await setup(t), input = { sourcePath: f.source, ref: f.first, expected_revision: 0, requestId: 'once' }
  const first = await f.repos.import(f.projectId, input)
  const second = await f.repos.import(f.projectId, { sourcePath: f.source, ref: 'HEAD', expected_revision: 1, requestId: 'twice' })
  assert.equal(second.commit, f.second);assert.equal(second.revision, 2)
  assert.deepEqual(await f.repos.import(f.projectId, input), first)
  await assert.rejects(f.repos.import(f.projectId, { ...input, ref: 'HEAD' }), /请求/)
  await assert.rejects(f.repos.import(f.projectId, { sourcePath: f.source, ref: 'HEAD', expected_revision: 1 }), /版本/)
  assert.equal(f.store.get(f.projectId).repository.commit, f.second)
})
test('fresh checkout reuses the same repository and keeps later working files and commits', async t => {
  const f = await setup(t), repository = await f.repos.import(f.projectId, { sourcePath: f.source, ref: 'HEAD', expected_revision: 0 })
  const bytes = (await f.files.read(f.projectId, { file_id: repository.fileId, revision: repository.fileRevision })).bytes, destination = join(f.root, 'checkout')
  await checkoutRepository({ destination, repository, bytes, branch: 'codex/test' })
  await writeFile(join(destination, 'local.txt'), 'KEEP');git(destination, 'add', '.');git(destination, 'commit', '-m', 'work')
  const head = git(destination, 'rev-parse', 'HEAD')
  await checkoutRepository({ destination, repository, branch: 'codex/test' })
  assert.equal(await readFile(join(destination, 'local.txt'), 'utf8'), 'KEEP');assert.equal(git(destination, 'rev-parse', 'HEAD'), head)
  const changed = { ...repository, commit: f.first }
  await assert.rejects(checkoutRepository({ destination, repository: changed, bytes, branch: 'codex/test' }), /迁移|不匹配/)
  assert.equal(git(destination, 'rev-parse', 'HEAD'), head)
})
test('unrelated destination contents and missing/corrupt bundle input are never overwritten', async t => {
  const f = await setup(t), repository = await f.repos.import(f.projectId, { sourcePath: f.source, expected_revision: 0 })
  const destination = join(f.root, 'foreign');await mkdir(destination);await writeFile(join(destination, 'keep'), 'FOREIGN')
  const bytes = (await f.files.read(f.projectId, { file_id: repository.fileId })).bytes
  await assert.rejects(checkoutRepository({ destination, repository, bytes, branch: 'codex/test' }), /已有|目录/)
  assert.equal(await readFile(join(destination, 'keep'), 'utf8'), 'FOREIGN')
  await assert.rejects(checkoutRepository({ destination: join(f.root, 'new'), repository, bytes: Buffer.from('bad'), branch: 'codex/test' }))
})
test('invalid sources, credential-bearing URLs and unknown refs cannot create repository metadata', async t => {
  const f = await setup(t)
  for (const input of [{ sourceURL: 'https://user:password@example.invalid/x.git' }, { sourceURL: 'ext::sh' }, { sourceURL: 'https://example.invalid/x.git?token=secret' },
    { sourcePath: f.source, ref: 'no_such_ref' }]) await assert.rejects(f.repos.import(f.projectId, { ...input, expected_revision: 0 }))
  assert.equal(f.store.get(f.projectId).repository, null)
  assert.equal(f.files.list(f.projectId).length, 0)
})
test('concurrent importers have one winner and never overwrite the chosen snapshot', async t => {
  const f = await setup(t), other = new ProjectRepositories(f.files)
  const results = await Promise.allSettled([f.repos.import(f.projectId, { sourcePath: f.source, ref: f.first, expected_revision: 0 }), other.import(f.projectId, { sourcePath: f.source, ref: f.second, expected_revision: 0 })])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(f.files.list(f.projectId)[0].revision, 1)
  assert.equal(f.store.get(f.projectId).repository.revision, 1)
})
test('an interrupted local publish resumes its recorded bundle even after the source disappears', async t => {
  const f = await setup(t), append = f.store.append.bind(f.store);let failed = false
  f.store.append = (id, event) => { if (event.type === 'repository.imported' && !failed) { failed = true;throw new Error('crash before pointer') }return append(id, event) }
  const input = { sourcePath: f.source, ref: f.first, expected_revision: 0, requestId: 'recover-import' }
  await assert.rejects(f.repos.import(f.projectId, input), /crash before pointer/)
  await rm(f.source, { recursive: true })
  assert.equal((await new ProjectRepositories(f.files).import(f.projectId, input)).commit, f.first)
  assert.equal(f.files.list(f.projectId)[0].revision, 1)
})
test('lost execution authority aborts checkout promotion and never creates a ready working directory', async t => {
  const f = await setup(t), repository = await f.repos.import(f.projectId, { sourcePath: f.source, expected_revision: 0 })
  const bytes = (await f.files.read(f.projectId, { file_id: repository.fileId })).bytes, destination = join(f.root, 'stopped')
  await assert.rejects(checkoutRepository({ destination, repository, bytes, branch: 'codex/test', assertCurrent: async () => { throw new Error('authority expired') } }), /authority expired/)
  await assert.rejects(lstat(destination), { code: 'ENOENT' })
})
test('offline checkout does not execute host-configured content filters', async t => {
  const f = await setup(t), config = join(f.root, 'global-gitconfig'), marker = join(f.root, 'filter-ran')
  await writeFile(join(f.source, '.gitattributes'), 'README.md filter=hostfilter\n');git(f.source, 'add', '.');git(f.source, 'commit', '-m', 'filter metadata')
  execFileSync('git', ['config', '--file', config, 'filter.hostfilter.smudge', `sh -c 'touch ${marker}; cat'`])
  const before = process.env.GIT_CONFIG_GLOBAL;process.env.GIT_CONFIG_GLOBAL = config
  try {
    const repository = await f.repos.import(f.projectId, { sourcePath: f.source, expected_revision: 0 })
    const bytes = (await f.files.read(f.projectId, { file_id: repository.fileId })).bytes
    await checkoutRepository({ destination: join(f.root, 'checkout'), repository, bytes, branch: 'codex/test' })
    await assert.rejects(lstat(marker), { code: 'ENOENT' })
  } finally { if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL = before }
})
test('inherited Git paths cannot redirect private export refs into the source repository', async t => {
  const f = await setup(t), before = process.env.GIT_DIR;process.env.GIT_DIR = join(f.source, '.git')
  try {
    const repository = await f.repos.import(f.projectId, { sourcePath: f.source, ref: f.first, expected_revision: 0 })
    assert.equal(repository.commit, f.first)
    assert.throws(() => git(f.source, 'show-ref', '--verify', 'refs/heads/mira-import'))
    assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.second)
  } finally { if (before === undefined) delete process.env.GIT_DIR;else process.env.GIT_DIR = before }
})
