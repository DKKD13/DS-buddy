/** Explicit project publication; working directories are never scanned. */
import { constants } from 'node:fs'
import { mkdir, lstat, realpath, open, link, unlink, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve, sep, posix } from 'node:path'
import { TextDecoder } from 'node:util'

export const MAX_FILE_BYTES = 64 * 1024 * 1024
export const FILE_CHUNK_BYTES = 512 * 1024
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const lockContext = new AsyncLocalStorage()
// macOS ships no flock command. There open() itself can take the same kind of lock: held until the file is closed or the process ends.
const O_EXLOCK_DARWIN = 0x20
export class FileError extends Error {
  constructor(message, code = 'INVALID_FILE') { super(message);this.name = 'FileError';this.code = code }
}
const fail = (message, code) => { throw new FileError(message, code) }
export function decodeFileChunk(value) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(FILE_CHUNK_BYTES / 3)) fail('文件分块过大或无效')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > FILE_CHUNK_BYTES || bytes.toString('base64') !== value) fail('文件分块编码无效')
  return bytes
}
export function filePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || !value.isWellFormed() || /[\\\u0000-\u001f]/.test(value)
    || value.startsWith('/') || value.endsWith('/') || value.split('/').some(p => p === '.' || p === '..') || posix.normalize(value) !== value) fail('共享文件路径无效')
  return value
}
function digest(value) { if (!/^[a-f0-9]{64}$/.test(value ?? '')) fail('文件摘要无效');return value }
function revision(value) { if (!Number.isSafeInteger(value) || value < 0) fail('文件版本无效');return value }
export async function boundedRead(handle, max = MAX_FILE_BYTES) {
  const info = await handle.stat()
  if (!info.isFile() || info.size > max) fail('文件不是有界普通文件')
  const chunks = [];let size = 0
  while (true) {
    const chunk = Buffer.alloc(Math.min(1024 * 1024, max + 1 - size)), { bytesRead } = await handle.read(chunk)
    if (!bytesRead) break
    size += bytesRead;if (size > max) fail('文件超过大小限制')
    chunks.push(chunk.subarray(0, bytesRead))
  }
  return Buffer.concat(chunks, size)
}

/** Immutable bytes, namespaced by project; no user path becomes a disk path. */
export class FileBlobs {
  constructor(root, { quotaBytes, lock } = {}) {
    if (!isAbsolute(root) || resolve(root) !== root) fail('文件存储需要规范绝对目录')
    if (quotaBytes !== undefined && (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1)) fail('文件存储配额无效', 'FILE_QUOTA_EXCEEDED')
    this.root = root
    this.quotaBytes = quotaBytes;this.sharedLock = lock
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const info = await lstat(this.root)
    if (!info.isDirectory() || await realpath(this.root) !== this.root || info.uid !== process.getuid() || (info.mode & 0o077)) fail('文件存储不是受保护的规范目录')
  }
  scope(projectId) {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 160 || !projectId.isWellFormed()) fail('项目身份无效')
    return join(this.root, hash(projectId))
  }
  location(projectId, sha256) { return join(this.scope(projectId), digest(sha256)) }
  async withLock(run) {
    if (lockContext.getStore() === this) return run()
    const execute = () => lockContext.run(this, () => this.exclusiveLock(run))
    const previous = this.lockQueue ?? Promise.resolve()
    const result = previous.then(execute, execute)
    this.lockQueue = result.catch(() => {})
    return result
  }
  async exclusiveLock(run) {
    if (this.sharedLock) return this.sharedLock(run)
    await this.initialize()
    if (process.platform === 'darwin') return this.openLock(run)
    const child = spawn('flock', ['-x', join(this.root, '.quota.lock'), '-c', 'echo locked; read'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let timer, settled = false
    try {
      await new Promise((resolve, reject) => {
        const done = error => { if (settled) return;settled = true;clearTimeout(timer);error ? reject(error) : resolve() }
        child.once('error', done);child.stdout.once('data', () => done())
        child.once('exit', code => { if (!settled) done(new Error(`文件存储锁提前退出：${code}`)) })
        timer = setTimeout(() => { child.kill('SIGKILL');done(new Error('文件存储锁等待超时')) }, 15000)
      })
    } catch (error) { child.kill('SIGKILL');throw error }
    try { return await run() }
    finally {
      child.stdin.end()
      await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL');resolve() }, 2000);child.once('exit', () => { clearTimeout(timer);resolve() }) })
    }
  }
  async openLock(run) {
    const path = join(this.root, '.quota.lock'), deadline = Date.now() + 15000
    let handle
    for (;;) {
      try { handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_EXLOCK_DARWIN, 0o600);break } catch (error) {
        if (error?.code !== 'EAGAIN' && error?.code !== 'EWOULDBLOCK') throw error
        if (Date.now() > deadline) throw new Error('文件存储锁等待超时')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    try { return await run() } finally { await handle.close() }
  }
  async listObjects(directory = this.root) {
    await this.initialize()
    const output = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (path === join(this.root, '.quota.lock')) continue
      const info = await lstat(path)
      if (info.isSymbolicLink()) fail('文件存储包含符号链接，停止扫描')
      if (info.isDirectory()) output.push(...await this.listObjects(path))
      else if (info.isFile()) output.push({ key: path, size: info.size, mtimeMs: info.mtimeMs })
      else fail('文件存储包含非普通对象，停止扫描')
    }
    return output
  }
  async usage() { return (await this.listObjects()).reduce((sum, object) => sum + object.size, 0) }
  async deleteObject(object) {
    if (typeof object.key !== 'string' || !object.key.startsWith(this.root + '/')) fail('垃圾回收对象超出存储目录')
    const info = await lstat(object.key)
    if (!info.isFile() || info.isSymbolicLink()) fail('垃圾回收对象不是普通文件')
    await unlink(object.key)
  }
  async directory(projectId, create = false) {
    await this.initialize()
    const path = this.scope(projectId)
    if (create) await mkdir(path, { mode: 0o700 }) .catch(error => { if (error.code !== 'EEXIST') throw error })
    let info
    try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT') fail('项目文件内容不存在');throw error }
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) fail('项目文件目录不受保护')
    return path
  }
  async read(projectId, sha256) {
    await this.directory(projectId)
    let handle
    try { handle = await open(this.location(projectId, sha256), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if (error.code === 'ENOENT') fail('文件内容不存在');throw error }
    try {
      const bytes = await boundedRead(handle)
      if (hash(bytes) !== sha256) fail('文件内容完整性检查失败，保留现场')
      return bytes
    } finally { await handle.close() }
  }
  async exists(projectId, sha256) {
    try { await this.read(projectId, sha256);return true }
    catch (error) { if (error.message === '文件内容不存在') return false;throw error }
  }
  async put(projectId, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) fail('文件内容超出大小限制')
    bytes = Buffer.from(bytes)
    const parent = await this.directory(projectId, true), sha256 = hash(bytes), dest = this.location(projectId, sha256)
    const temp = join(parent, '.upload-' + randomUUID())
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      await handle.writeFile(bytes);await handle.sync();await handle.close()
      return await this.withLock(async () => {
        if (await this.exists(projectId, sha256)) return sha256
        // usage() includes this temp file, so the incoming bytes are already
        // part of the capacity check before the hard link is created.
        if (this.maintenance) await this.maintenance.assertCapacityUnlocked()
        else if (this.quotaBytes !== undefined && await this.usage() > this.quotaBytes) fail('文件存储配额已满', 'FILE_QUOTA_EXCEEDED')
        try { await link(temp, dest) }
        catch (error) { if (error.code !== 'EEXIST') throw error;await this.read(projectId, sha256) }
        const dir = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY)
        try { await dir.sync() } finally { await dir.close() }
        return sha256
      })
    } finally { await handle.close().catch(() => {});await unlink(temp).catch(() => {}) }
  }
  async assemble(projectId, chunks, expectedHash, size) {
    if (!Array.isArray(chunks) || chunks.length > MAX_FILE_BYTES / FILE_CHUNK_BYTES + 1 || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) fail('文件上传清单无效')
    digest(expectedHash)
    const values = [];let total = 0
    for (const chunk of chunks) {
      const bytes = await this.read(projectId, digest(chunk))
      if (bytes.length > FILE_CHUNK_BYTES) fail('文件分块过大')
      total += bytes.length;if (total > size) fail('文件分块长度不符')
      values.push(bytes)
    }
    const bytes = Buffer.concat(values, total)
    if (total !== size || hash(bytes) !== expectedHash) fail('文件上传完整性检查失败')
    return this.put(projectId, bytes)
  }
}

const mimeFor = path => ({ md: 'text/markdown', txt: 'text/plain', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain',
  json: 'application/json', html: 'text/html', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', pdf: 'application/pdf' })[path.split('.').at(-1).toLowerCase()] ?? 'application/octet-stream'
const view = version => ({ ...version })
export class ProjectFiles {
  constructor(store, driver, { blobs, workspace, uploadedArtifact } = {}) { this.store = store;this.driver = driver;this.blobs = blobs;this.workspace = workspace;this.uploadedArtifact = uploadedArtifact }
  writer(projectId, key) {
    const project = this.store.get(projectId)
    if (key === 'owner') return { kind: 'human', id: 'owner' }
    const thread = key?.startsWith('w:') ? project.threads.get(key.slice(2)) : null
    if (!thread || thread.state === 'done' || thread.resolved || !project.members.some(m => m.id === thread.assignee && m.active !== false)) fail('当前角色或线程不能发布项目文件', 'FORBIDDEN')
    return { kind: 'assistant', id: thread.assignee, threadId: thread.id }
  }
  list(projectId) {
    return [...(this.store.get(projectId).files?.values() ?? [])].map(file => ({ ...view(file.versions.at(-1)), versions: file.versions.map(v => v.revision) }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }
  metadata(projectId, { path, file_id, revision: wanted } = {}) {
    const files = this.store.get(projectId).files ?? new Map()
    const file = file_id ? [...files.values()].find(f => f.id === file_id) : files.get(filePath(path))
    if (!file) fail('共享文件不存在')
    if (wanted !== undefined && (!Number.isSafeInteger(wanted) || wanted < 1)) fail('文件版本无效')
    const selected = wanted === undefined ? file.versions.at(-1) : file.versions.find(v => v.revision === wanted)
    if (!selected) fail('共享文件版本不存在')
    return view(selected)
  }
  async read(projectId, input) {
    const file = this.metadata(projectId, input), bytes = await this.blobs.read(projectId, file.sha256)
    return { file, bytes }
  }
  async readChunk(projectId, input) {
    const { file, bytes } = await this.read(projectId, input), offset = input.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) fail('文件分块偏移无效')
    const end = Math.min(bytes.length, offset + FILE_CHUNK_BYTES)
    return { file, data: bytes.subarray(offset, end).toString('base64'), offset, nextOffset: end < bytes.length ? end : null }
  }
  async commitUpload(projectId, key, input) {
    this.writer(projectId, key);filePath(input.path)
    await this.blobs.assemble(projectId, input.chunks, input.sha256, input.size)
    return this.publishBlob(projectId, key, input)
  }
  async publishBlob(projectId, key, { path, sha256, expected_revision = 0, requestId = randomUUID() }, internal = {}) {
    path = filePath(path);revision(expected_revision);digest(sha256)
    if (path.startsWith('.repository/') && (key !== 'owner' || !internal.repositoryDraft)) fail('仓库快照只能由用户通过仓库导入操作发布', 'FORBIDDEN')
    if (typeof requestId !== 'string' || !requestId || requestId.length > 160) fail('文件请求身份无效')
    this.writer(projectId, key)
    return this.blobs.withLock(async () => {
      const bytes = await this.blobs.read(projectId, sha256), by = this.writer(projectId, key)
      // Metadata publication and GC share this lock. A newly referenced old
      // object cannot be deleted between its byte check and the event append.
      const project = this.store.get(projectId), fingerprint = hash(JSON.stringify({ path, sha256, expected_revision, by }))
      const old = project.events.find(e => e.type === 'file.published' && e.requestId === requestId)
      if (old) { if (old.fingerprint !== fingerprint) fail('相同文件请求的内容已改变', 'IDEMPOTENCY_CONFLICT');return this.metadata(projectId, { file_id: old.fileId, revision: old.revision }) }
      const existing = project.files?.get(path), current = existing?.versions.at(-1)
      if ((current?.revision ?? 0) !== expected_revision) fail('共享文件版本已变化，请先读取并合并最新版', 'FILE_CONFLICT')
      const event = this.store.append(projectId, { type: 'file.published', fileId: existing?.id ?? 'f_' + randomUUID().replaceAll('-', ''), path,
        revision: expected_revision + 1, sha256, size: bytes.length, mime: mimeFor(path), by, requestId, fingerprint, to: [],
        ...(key === 'owner' && internal.repositoryDraft ? { repositoryDraft: internal.repositoryDraft } : {}) })
      this.driver?.deliver?.(event, 'file')
      return this.metadata(projectId, { file_id: event.fileId, revision: event.revision })
    })
  }
  async writeText(projectId, key, input) {
    this.writer(projectId, key);filePath(input.path);revision(input.expected_revision ?? 0)
    if (typeof input.text !== 'string' || !input.text.isWellFormed() || Buffer.byteLength(input.text) > 128 * 1024) fail('文本文件需为不超过128KB的有效UTF-8文本')
    const sha256 = await this.blobs.put(projectId, Buffer.from(input.text, 'utf8'))
    return this.publishBlob(projectId, key, { ...input, sha256 })
  }
  async publishWorkspace(projectId, key, input) {
    this.writer(projectId, key);filePath(input.path)
    if (!this.workspace) fail('此入口需要节点明确上传工作文件')
    const bytes = await readWorkspaceFile(await this.workspace(this.store.get(projectId), key), input.source_path ?? input.path)
    const sha256 = await this.blobs.put(projectId, bytes)
    return this.publishBlob(projectId, key, { ...input, sha256 })
  }
  async publishArtifact(projectId, key, input) {
    if (Object.hasOwn(input, 'sha256')) fail('文件摘要由节点传输层提供，不接受模型参数', 'FORBIDDEN')
    return this.uploadedArtifact ? this.publishBlob(projectId, key, { ...input, sha256: this.uploadedArtifact.sha256 }) : this.publishWorkspace(projectId, key, input)
  }
  attachments(projectId, paths = []) {
    if (!Array.isArray(paths) || paths.length > 8) fail('每条消息最多附加8份文件')
    return [...new Set(paths)].map(path => { const file = this.metadata(projectId, { path });return { fileId: file.id, path: file.path, revision: file.revision } })
  }
  static text(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { fail('此文件不是UTF-8文本，请下载或取二进制分块') }
  }
}

export async function readWorkspaceFile(workspace, source) {
  const root = await realpath(workspace), path = await realpath(resolve(root, filePath(source)))
  if (!path.startsWith(root + sep)) fail('发布文件超出已绑定工作目录')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return await boundedRead(handle) } finally { await handle.close() }
}
