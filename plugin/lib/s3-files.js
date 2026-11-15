/** S3-compatible immutable blobs with SigV4, bounded reads and no redirects. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FileBlobs, FileError, MAX_FILE_BYTES, FILE_CHUNK_BYTES } from './files.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = (message, code = 'S3_BACKEND') => { throw new FileError(message, code) }
const require = createRequire(import.meta.url)

function dependency(name) {
  const paths = [process.env.MIRA_DSH_DEPENDENCIES ?? '/opt/dsh/node_modules', join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules')]
  return pathToFileURL(require.resolve(name, { paths })).href
}
class Sha256 {
  constructor() { this.hash = createHash('sha256') }
  update(value) { this.hash.update(value) }
  async digest() { return this.hash.digest() }
}
function validName(value, label, pattern, max = 256) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !pattern.test(value)) fail(`${label}无效`, 'S3_CONFIG')
  return value
}
function parseList(xml) {
  return import(dependency('saxes')).then(({ SaxesParser }) => {
    const parser = new SaxesParser(), objects = []
    let current = '', object = null, truncated = false, token = null
    parser.on('opentag', node => { current = node.name;if (current === 'Contents') object = {} })
    parser.on('text', text => {
      if (current === 'Key' && object) object.key = (object.key ?? '') + text
      else if (current === 'Size' && object) object.size = Number(text)
      else if (current === 'LastModified' && object) object.mtimeMs = Date.parse(text)
      else if (current === 'IsTruncated') truncated = text === 'true'
      else if (current === 'NextContinuationToken') token = (token ?? '') + text
    })
    parser.on('closetag', node => { if (node.name === 'Contents') { objects.push(object);object = null } })
    parser.write(xml).close()
    return { objects, truncated, token }
  })
}

export class S3FileBlobs extends FileBlobs {
  constructor(root, options = {}) {
    super(root, { quotaBytes: options.quotaBytes, lock: options.sharedLock })
    this.bucket = validName(options.bucket, 'S3 bucket', /^[a-z0-9][a-z0-9.-]{1,62}$/)
    this.prefix = validName(options.prefix ?? 'mira', 'S3 prefix', /^[A-Za-z0-9_./-]+$/).replace(/^\/+|\/+$/g, '')
    if (!this.prefix || this.prefix.split('/').some(part => !part || part === '.' || part === '..')) fail('S3 prefix无效', 'S3_CONFIG')
    this.region = validName(options.region ?? 'us-east-1', 'S3 region', /^[a-z0-9-]+$/)
    this.credentials = { accessKeyId: validName(options.accessKeyId, 'S3 access key', /^\S+$/, 512),
      secretAccessKey: validName(options.secretAccessKey, 'S3 secret key', /^\S+$/, 1024), ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}) }
    this.endpoint = validName(options.endpoint, 'S3 endpoint', /^https?:\/\/\S+$/, 2048).replace(/\/+$/, '')
    this.forcePathStyle = options.forcePathStyle !== false
    this.requiresSharedLock = true
    this.fetch = options.fetch ?? fetch
    this.createBucket = options.createBucket === true
    this.clock = options.clock ?? (() => new Date())
  }
  scope(projectId) {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 160 || !projectId.isWellFormed()) fail('项目身份无效')
    return `${this.prefix}/${hash(projectId)}`
  }
  location(projectId, sha256) {
    if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) fail('文件摘要无效')
    return `${this.scope(projectId)}/${sha256}`
  }
  async initialize() {
    if (this.ready) return
    if (this.initializing) return this.initializing
    this.initializing = (async () => {
      await super.initialize()
      if ((this.quotaBytes !== undefined || this.maintenance) && !this.sharedLock) fail('S3配额或GC需要共享锁', 'STORAGE_LOCK_REQUIRED')
      const endpoint = new URL(this.endpoint)
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail('S3 endpoint配置无效', 'S3_CONFIG')
      const loopback = ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)
      if (endpoint.protocol !== 'https:' && !loopback) fail('非本机S3端点必须使用HTTPS', 'S3_CONFIG')
      const { SignatureV4 } = await import(dependency('@smithy/signature-v4'))
      this.signer = new SignatureV4({ credentials: this.credentials, region: this.region, service: 's3', sha256: Sha256, uriEscapePath: true })
      if (this.createBucket) {
        const response = await this.request('PUT', '')
        if (![200, 409].includes(response.status)) fail(`S3 bucket创建失败：HTTP ${response.status}`)
      }
      const response = await this.request('GET', '', { query: { 'list-type': '2', 'max-keys': '1' } })
      if (response.status !== 200) fail(`S3 bucket不可用：HTTP ${response.status}`)
      this.ready = true
    })()
    try { await this.initializing } finally { this.initializing = null }
  }
  async request(method, key, { query = {}, body, headers: extra = {} } = {}) {
    const endpoint = new URL(this.endpoint), base = endpoint.pathname.replace(/\/+$/, '')
    const hostname = this.forcePathStyle ? endpoint.host : `${this.bucket}.${endpoint.host}`
    const path = this.forcePathStyle ? `${base}/${this.bucket}${key ? '/' + key : '/'}` : `${base}${key ? '/' + key : '/'}`
    const headers = { host: hostname, ...extra }
    const signed = await this.signer.sign({ method, protocol: endpoint.protocol, hostname, path, query, headers, body }, { signingDate: this.clock() })
    const params = new URLSearchParams()
    for (const [name, value] of Object.entries(signed.query ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (Array.isArray(value)) for (const item of value) params.append(name, item)
      else if (value !== undefined && value !== null) params.append(name, String(value))
    }
    const target = `${signed.protocol}//${signed.hostname}${signed.path}${params.size ? '?' + params.toString() : ''}`
    return this.fetch(target, { method, headers: signed.headers, body, redirect: 'error', signal: AbortSignal.timeout(15000) })
  }
  async read(projectId, sha256) {
    await this.initialize()
    const response = await this.request('GET', this.location(projectId, sha256))
    if (response.status === 404) fail('文件内容不存在', 'INVALID_FILE')
    if (response.status !== 200) fail(`S3读取失败：HTTP ${response.status}`)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_FILE_BYTES) fail('文件超过大小限制')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_FILE_BYTES) fail('文件超过大小限制')
    if (hash(bytes) !== sha256) fail('文件内容完整性检查失败，保留现场')
    return bytes
  }
  async put(projectId, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) fail('文件内容超出大小限制')
    bytes = Buffer.from(bytes)
    const sha256 = hash(bytes), key = this.location(projectId, sha256)
    await this.initialize()
    return this.withLock(async () => {
      if (await this.exists(projectId, sha256)) return sha256
      if (this.maintenance) await this.maintenance.assertCapacityUnlocked(bytes.length)
      else if (this.quotaBytes !== undefined && await this.usage() + bytes.length > this.quotaBytes) fail('文件存储配额已满', 'FILE_QUOTA_EXCEEDED')
      const response = await this.request('PUT', key, { body: bytes, headers: { 'if-none-match': '*' } })
      if ([409, 412].includes(response.status)) { await this.read(projectId, sha256);return sha256 }
      if (response.status !== 200) fail(`S3写入失败：HTTP ${response.status}`)
      return sha256
    })
  }
  async assemble(projectId, chunks, expectedHash, size) {
    if (!Array.isArray(chunks) || chunks.length > MAX_FILE_BYTES / FILE_CHUNK_BYTES + 1 || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) fail('文件上传清单无效')
    if (!/^[a-f0-9]{64}$/.test(expectedHash ?? '')) fail('文件摘要无效')
    const values = [];let total = 0
    for (const chunk of chunks) {
      if (!/^[a-f0-9]{64}$/.test(chunk ?? '')) fail('文件分块摘要无效')
      const bytes = await this.read(projectId, chunk)
      if (bytes.length > FILE_CHUNK_BYTES) fail('文件分块过大')
      total += bytes.length;if (total > size) fail('文件分块长度不符')
      values.push(bytes)
    }
    const bytes = Buffer.concat(values, total)
    if (total !== size || hash(bytes) !== expectedHash) fail('文件上传完整性检查失败')
    return this.put(projectId, bytes)
  }
  async listObjects() {
    await this.initialize()
    const objects = [];let token
    for (let page = 0; page < 10000; page++) {
      const query = { 'list-type': '2', prefix: this.prefix + '/', 'max-keys': '1000', ...(token ? { 'continuation-token': token } : {}) }
      const response = await this.request('GET', '', { query })
      if (response.status !== 200) fail(`S3列表失败：HTTP ${response.status}`)
      const result = parseList(await response.text()), batch = await result
      for (const object of batch.objects) {
        if (typeof object.key !== 'string' || !object.key.startsWith(this.prefix + '/') || !Number.isSafeInteger(object.size) || object.size < 0 || !Number.isFinite(object.mtimeMs)) fail('S3对象元数据无效，停止扫描')
        objects.push(object)
      }
      if (!batch.truncated) return objects
      if (!batch.token || batch.token === token) fail('S3列表分页没有进展')
      token = batch.token
    }
    fail('S3列表分页过多，停止扫描')
  }
  async usage() { return (await this.listObjects()).reduce((sum, object) => sum + object.size, 0) }
  async deleteObject(object) {
    if (typeof object.key !== 'string' || !object.key.startsWith(this.prefix + '/')) fail('垃圾回收对象超出S3前缀')
    const response = await this.request('DELETE', object.key)
    if (![200, 204, 404].includes(response.status)) fail(`S3删除失败：HTTP ${response.status}`)
  }
}
