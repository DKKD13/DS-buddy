/** Owner imports committed Git history; agents receive an offline bundle only. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, lstat, realpath, open, writeFile, readFile, readdir, rmdir, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { FileError, boundedRead } from './files.js'

const exec = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const imports = new WeakMap()
const fail = message => { throw new FileError(message, 'REPOSITORY_ERROR') }
async function git(cwd, args, { offline = false } = {}) {
  const env = offline ? Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) : { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete env[key]
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }, offline ? { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' } : {})
  try { return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim() }
  catch { fail('仓库Git操作未完成，请核对来源、提交与开发机认证') }
}
const offlineGit = (cwd, args) => git(cwd, args, { offline: true })
function sourceOf({ sourcePath, sourceURL }) {
  if (!!sourcePath === !!sourceURL) fail('请只选择本机仓库目录或远程仓库URL')
  if (sourcePath) {
    if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath) || /[\u0000-\u001f]/.test(sourcePath)) fail('仓库目录需要绝对路径')
    return { kind: 'local', path: resolve(sourcePath) }
  }
  let url
  try { url = new URL(sourceURL) } catch { fail('仓库URL无效，请使用HTTPS或SSH URL') }
  if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash || url.protocol === 'https:' && url.username) fail('仓库URL不能含凭据、查询或片段，仅支持HTTPS/SSH')
  return { kind: 'remote', url: url.href }
}

export class ProjectRepositories {
  constructor(files) { this.files = files;this.store = files.store;this.driver = files.driver }
  async bundle(source, ref) {
    await this.files.blobs.initialize()
    const root = join(this.files.blobs.root, '.git-imports');await mkdir(root, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e })
    if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) fail('仓库导入目录不是规范私有目录')
    const temp = await mkdtemp(join(root, 'import-'))
    try {
      const bare = join(temp, 'source.git')
      if (source.kind === 'local') await git(temp, ['clone', '--bare', '--shared', '--no-hardlinks', '--template=', '--', await realpath(source.path), bare])
      else await git(temp, ['clone', '--mirror', '--template=', '--', source.url, bare])
      const commit = await git(bare, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) fail('仓库没有可导入的提交')
      await git(bare, ['update-ref', 'refs/heads/mira-import', commit])
      const file = join(temp, 'snapshot.bundle');await git(bare, ['bundle', 'create', file, 'refs/heads/mira-import'])
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { return { commit, bytes: await boundedRead(handle) } } finally { await handle.close() }
    } finally { await rm(temp, { recursive: true, force: true }) }
  }
  async import(projectId, input) {
    let locks = imports.get(this.store)
    if (!locks) { locks = new Map();imports.set(this.store, locks) }
    const before = locks.get(projectId) ?? Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve });locks.set(projectId, current)
    await before
    try { return await this.importLocked(projectId, input) }
    finally { release();if (locks.get(projectId) === current) locks.delete(projectId) }
  }
  async importLocked(projectId, { sourcePath, sourceURL, ref = 'HEAD', expected_revision = 0, requestId = randomUUID() }) {
    const source = sourceOf({ sourcePath, sourceURL })
    if (typeof ref !== 'string' || !ref || ref.length > 160 || /[\u0000-\u001f]/.test(ref) || !Number.isSafeInteger(expected_revision) || expected_revision < 0
      || typeof requestId !== 'string' || !requestId || requestId.length > 160) fail('仓库版本或请求参数无效')
    const fingerprint = hash(JSON.stringify({ source, ref, expected_revision })), project = this.store.get(projectId)
    const receipt = project.events.find(e => e.type === 'repository.imported' && e.requestId === requestId)
    if (receipt) { if (receipt.fingerprint !== fingerprint) fail('相同仓库请求的内容已改变');return structuredClone(receipt.repository) }
    if ((project.repository?.revision ?? 0) !== expected_revision) fail('仓库版本已变化，请刷新后重试')
    const fileRequest = 'repo-file-' + hash(requestId)
    const prepared = project.events.find(e => e.type === 'file.published' && e.requestId === fileRequest)?.repositoryDraft
    let draft = prepared
    if (prepared && prepared.fingerprint !== fingerprint) fail('仓库准备请求的内容已改变')
    if (!draft) {
      const { commit, bytes } = await this.bundle(source, ref), sha256 = await this.files.blobs.put(projectId, bytes)
      draft = { fingerprint, commit, sha256, source, ref }
    }
    if ((this.store.get(projectId).repository?.revision ?? 0) !== expected_revision) fail('仓库版本已变化，请刷新后重试')
    const currentFile = this.files.list(projectId).find(file => file.path === '.repository/snapshot.bundle')
    const file = await this.files.publishBlob(projectId, 'owner', { path: '.repository/snapshot.bundle', sha256: draft.sha256,
      expected_revision: prepared ? project.events.find(e => e.type === 'file.published' && e.requestId === fileRequest).revision - 1 : currentFile?.revision ?? 0,
      requestId: fileRequest }, { repositoryDraft: draft })
    const repository = { revision: expected_revision + 1, commit: draft.commit, fileId: file.id, fileRevision: file.revision, sha256: file.sha256,
      size: file.size, source: draft.source, ref: draft.ref }
    const event = this.store.append(projectId, { type: 'repository.imported', repository, requestId, fingerprint, by: { kind: 'human', id: 'owner' }, to: [] })
    this.driver?.deliver?.(event, 'repository')
    return structuredClone(repository)
  }
  async ensureThread(project, thread) {
    if (!thread.repositoryBound && project.repository) this.store.append(project.id, { type: 'thread.repository.bound', threadId: thread.id,
      repository: project.sessions.has('w:' + thread.id) ? null : project.repository })
    if (!thread.repository) return false
    const destination = resolve(this.store.root, '_repository-workspaces', hash(project.id + '/' + thread.id).slice(0, 32))
    const branch = 'codex/mira-' + hash(project.id + '/' + thread.id).slice(0, 24), readyBefore = thread.workspace?.status === 'ready', wasReady = readyBefore || thread.workspace?.previouslyReady === true
    if (!readyBefore) this.store.append(project.id, { type: 'thread.workspace.preparing', threadId: thread.id, workspace: { path: destination, cwd: destination, status: 'preparing', type: 'repository-snapshot', previouslyReady: wasReady } })
    try {
      const options = { destination, repository: thread.repository, branch, requireExisting: wasReady }
      let workspace
      try { workspace = await checkoutRepository(options) }
      catch (error) {
        if (error.code !== 'REPOSITORY_DATA_REQUIRED') throw error
        const { bytes } = await this.files.read(project.id, { file_id: thread.repository.fileId, revision: thread.repository.fileRevision })
        workspace = await checkoutRepository({ ...options, bytes })
      }
      if (!readyBefore) this.store.append(project.id, { type: 'thread.workspace.ready', threadId: thread.id, workspace: { ...workspace, type: 'repository-snapshot' } })
      return true
    } catch (error) {
      this.store.append(project.id, { type: 'thread.workspace.failed', threadId: thread.id, workspace: { path: destination, cwd: destination,
        status: 'failed', type: 'repository-snapshot', error: String(error.message).slice(0, 300), previouslyReady: wasReady } })
      throw error
    }
  }
}

function identity(repository) { return { format: 'mira-project-checkout-v1', commit: repository.commit, sha256: repository.sha256, fileId: repository.fileId, fileRevision: repository.fileRevision } }
/** Repeated calls validate their marker and preserve all later work. */
export async function checkoutRepository({ destination, repository, bytes, branch, requireExisting = false, assertCurrent = async () => {} }) {
  if (!isAbsolute(destination) || resolve(destination) !== destination || !/^codex\/[A-Za-z0-9_./-]+$/.test(branch ?? '')
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(repository?.commit ?? '') || !/^[a-f0-9]{64}$/.test(repository?.sha256 ?? '')) fail('仓库恢复身份无效')
  const marker = join(destination, '.git/mira-project-checkout.json'), expected = identity(repository)
  let existing
  try { existing = await lstat(destination) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (existing) {
    if (!existing.isDirectory() || await realpath(destination) !== destination) fail('仓库恢复目录不匹配')
    const entries = await readdir(destination)
    if (entries.length) {
      let saved
      try {
        if (!(await lstat(join(destination, '.git'))).isDirectory()) fail('仓库元数据目录不匹配')
        const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW)
        try { saved = JSON.parse((await boundedRead(handle, 4096)).toString()) } finally { await handle.close() }
      } catch { fail('已有目录不属于此仓库恢复操作，保留原内容') }
      if (!saved || Object.keys(saved).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => saved[key] !== value)) fail('仓库快照不匹配；需要显式迁移，保留当前工作文件')
      await offlineGit(destination, ['cat-file', '-e', repository.commit + '^{commit}'])
      await assertCurrent()
      return { path: destination, cwd: destination, branch: await offlineGit(destination, ['branch', '--show-current']), baseCommit: repository.commit, repository: destination, status: 'ready' }
    }
  }
  if (requireExisting) fail('原仓库工作目录丢失，需显式恢复；不会静默覆盖已有工作')
  if (bytes === undefined) throw new FileError('需要仓库快照字节', 'REPOSITORY_DATA_REQUIRED')
  if (!Buffer.isBuffer(bytes) || hash(bytes) !== repository.sha256) fail('仓库快照字节不匹配')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temp = await mkdtemp(join(dirname(destination), '.mira-checkout-'))
  try {
    const bundle = join(temp, 'source.bundle'), checkout = join(temp, 'repo');await writeFile(bundle, bytes, { mode: 0o600, flag: 'wx' })
    await offlineGit(temp, ['clone', '--no-checkout', '--no-hardlinks', '--template=', '--', bundle, checkout])
    await offlineGit(checkout, ['checkout', '-b', branch, repository.commit])
    await offlineGit(checkout, ['config', 'user.name', 'Mira Project']);await offlineGit(checkout, ['config', 'user.email', 'mira-project@local.invalid'])
    await offlineGit(checkout, ['remote', 'remove', 'origin'])
    await writeFile(join(checkout, '.git/mira-project-checkout.json'), JSON.stringify(expected), { mode: 0o600, flag: 'wx' })
    await assertCurrent()
    if (existing) await rmdir(destination)
    await rename(checkout, destination)
    return { path: destination, cwd: destination, branch, baseCommit: repository.commit, repository: destination, status: 'ready' }
  } finally { await rm(temp, { recursive: true, force: true }) }
}
