/** Device observations are evidence, never owner instructions or project Library files. */
import { createHash } from 'node:crypto'
import { openSync, fsyncSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { FileBlobs, decodeFileChunk } from './files.js'
import { BlobMaintenance } from './blob-maintenance.js'

export const MAX_OBSERVATION_IMAGE = 2 * 1024 * 1024
export const OBSERVATION_DEFAULTS = Object.freeze({ enabled: false, uploadImages: false,
  sampleSeconds: 10, uploadSeconds: 30, summaryMinutes: 10, lateMinutes: 7,
  importantWakeMinutes: 0, imageRetentionDays: 7, maxQueueBytes: 128 * 1024 * 1024, excludeApps: [] })
const SOURCES = new Set(['screen', 'activity', 'accessibility', 'agent', 'docs', 'lark', 'email'])
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const fail = (message, code = 'INVALID_OBSERVATION') => { const e = new Error(message);e.code = code;throw e }
const key = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:._-]{1,128}$/.test(value)) fail('稳定身份标识无效')
  return value
}
const text = (value, field, max, optional = false) => {
  if (optional && value === undefined) return ''
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || !optional && !value.trim()) fail(`${field}无效`)
  return value.trim()
}
const integer = (v, min, max, name) => { if (!Number.isSafeInteger(v) || v < min || v > max) fail(`${name}无效`);return v }
const fields = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('需要对象')
  for (const k of Object.keys(value)) if (!allowed.includes(k)) fail(`不支持的资料字段：${k}`)
}
const sha = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('图片摘要无效');return value }
const missing = error => error.code === 'ENOENT' || ['文件内容不存在', '项目文件内容不存在'].includes(error.message)
function fingerprintOf(item) {
  const { localSeq, media, ...body } = item
  // A replayed upstream ID may be re-enqueued after bounded local dedupe history.
  // Keep the first sequence and original bytes; semantic evidence must still match.
  return digest({ ...body, media: media ? { sha256: media.sha256, size: media.size, mime: media.mime, width: media.width, height: media.height } : null })
}

export function observationPolicy(input) {
  fields(input, Object.keys(OBSERVATION_DEFAULTS))
  const result = { ...OBSERVATION_DEFAULTS, ...input }
  for (const name of ['enabled', 'uploadImages']) if (typeof result[name] !== 'boolean') fail('采集开关无效')
  for (const [name, min, max] of [['sampleSeconds', 2, 3600], ['uploadSeconds', 1, 3600], ['summaryMinutes', 1, 120], ['lateMinutes', 7, 60],
    ['importantWakeMinutes', 0, 1440], ['imageRetentionDays', 1, 365], ['maxQueueBytes', MAX_OBSERVATION_IMAGE * 2, 2 * 1024 ** 3]]) integer(result[name], min, max, name)
  if (result.importantWakeMinutes && result.importantWakeMinutes < 20) fail('重要信号整理间隔至少20分钟，0为关闭')
  if (!Array.isArray(result.excludeApps) || result.excludeApps.length > 100) fail('应用排除列表无效')
  result.excludeApps = [...new Set(result.excludeApps.map(app => text(app, '排除应用', 160)))].sort()
  return result
}

/** Parse bounded raster dimensions. SVG/HTML and unchecked caller dimensions are never served. */
export function observationImage(bytes, { maxBytes = MAX_OBSERVATION_IMAGE } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MAX_OBSERVATION_IMAGE || maxBytes > 32 * 1024 * 1024) fail('图片检查上限无效')
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > maxBytes) fail('关键图片过大或格式无效')
  let width, height, mime
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') fail('PNG结构无效')
    width = bytes.readUInt32BE(16);height = bytes.readUInt32BE(20);mime = 'image/png'
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) fail('JPEG结构无效')
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) fail('JPEG片段无效')
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) fail('JPEG尺寸无效')
        height = bytes.readUInt16BE(offset + 3);width = bytes.readUInt16BE(offset + 5);mime = 'image/jpeg';break
      }
      offset += length
    }
  }
  if (!mime || !width || !height || width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024) fail('只支持有界PNG/JPEG关键图片')
  return { width, height, mime, size: bytes.length, sha256: digest(bytes) }
}

export function normalizeObservation(input, projectExists = () => true) {
  fields(input, ['eventId', 'localSeq', 'source', 'occurredAt', 'app', 'title', 'text', 'projectId', 'correlationId', 'media', 'important'])
  key(input.eventId);integer(input.localSeq, 1, Number.MAX_SAFE_INTEGER, '设备序号')
  if (!SOURCES.has(input.source)) fail('观察来源无效')
  if (input.important !== undefined && typeof input.important !== 'boolean') fail('重要信号标记无效')
  integer(input.occurredAt, 1, 8640000000000000, '发生时间')
  if (input.projectId !== undefined && (typeof input.projectId !== 'string' || !/^p_[\w-]+$/.test(input.projectId) || !projectExists(input.projectId))) fail('关联项目不存在')
  const event = { eventId: input.eventId, localSeq: input.localSeq, source: input.source, occurredAt: input.occurredAt,
    app: text(input.app, '应用', 160, true), title: text(input.title, '标题', 400, true), text: text(input.text, '观察正文', 16000),
    projectRef: input.projectId ?? null, correlationId: input.correlationId === undefined ? null : key(input.correlationId), media: null, important: input.important === true }
  if (input.media !== undefined && input.media !== null) {
    fields(input.media, ['sha256', 'size', 'mime', 'width', 'height', 'chunks'])
    const m = input.media
    sha(m.sha256);integer(m.size, 24, MAX_OBSERVATION_IMAGE, '图片字节');integer(m.width, 1, 8192, '图片宽度');integer(m.height, 1, 8192, '图片高度')
    if (!['image/jpeg', 'image/png'].includes(m.mime) || m.width * m.height > 16 * 1024 * 1024) fail('图片格式或尺寸无效')
    if (!Array.isArray(m.chunks) || !m.chunks.length || m.chunks.length > 4) fail('图片分块无效')
    m.chunks.forEach(sha)
    event.media = { sha256: m.sha256, size: m.size, mime: m.mime, width: m.width, height: m.height, chunks: [...m.chunks] }
  }
  return event
}

export class Observations {
  constructor(hubStore, projects, { root, quotaBytes = 1024 ** 3, now = () => Date.now(), blobs, orphanRetentionMs = 60 * 60_000, notify, retention } = {}) {
    this.store = hubStore;this.projects = projects;this.now = now;this.notify = notify;this.retention = retention
    this.blobs = blobs ?? new FileBlobs(root, { quotaBytes })
    this.records = new Map();this.bySeq = new Map();this.summaries = new Map();this.windows = new Map();this.notified = new Map();this.notices = new Map();this.noticeForRef = new Map();this.latestImportant = new Map();this.noticeErrors = new Map();this.devices = new Map();this.policies = new Map();this.cleared = new Map();this.requests = new Map()
    for (const event of this.hub.events) this.fold(event)
    this.off = hubStore.onChange(event => { if (event?.projectId === 'hub') this.fold(event) })
    this.maintenance = new BlobMaintenance(this.blobs, { quotaBytes, retentionMs: orphanRetentionMs, now, liveKeys: () => this.liveKeys() })
  }
  get hub() { return this.store.get('hub') }
  close() { this.off?.() }
  scope(deviceId) { return 'observation/' + key(deviceId) }
  fold(event) {
    if (event.type === 'observation.accepted' || event.type === 'observation.filtered') this.records.set(`${event.deviceId}|${event.eventId}`, event)
    if (event.type === 'observation.accepted') {
      this.bySeq.set(event.seq, event)
      if (event.important) this.latestImportant.set(event.deviceId, event)
      const minutes = event.summaryMinutes ?? 10, start = Math.floor(event.occurredAt / (minutes * 60000)) * minutes * 60000
      const id = `${event.deviceId}|${event.source}|${minutes}|${start}`
      const window = this.windows.get(id) ?? { id, deviceId: event.deviceId, source: event.source, start, end: start + minutes * 60000, lateMinutes: event.lateMinutes ?? 7, events: [] }
      window.events.push(event);window.lateMinutes = Math.max(window.lateMinutes, event.lateMinutes ?? 7);this.windows.set(id, window)
    }
    if (event.type === 'observation.summary') { this.summaries.set(event.windowId, event);this.bySeq.set(event.seq, event) }
    if (event.type === 'mira.requested' && event.observationRef) { this.notified.set(event.deviceId, event.requestedAt);this.notices.set(event.deviceId, event);this.noticeForRef.set(event.observationRef, event) }
    if (event.type === 'observation.notice.result') this.noticeErrors.set(event.deviceId, !event.delivered)
    if (event.type === 'observation.device') this.devices.set(event.deviceId, event)
    if (event.type === 'observation.policy') this.policies.set(event.deviceId, event)
    if (event.type === 'observation.media.cleared') this.cleared.set(event.deviceId, event.through)
    if (['observation.policy', 'observation.media.cleared'].includes(event.type)) this.requests.set(event.requestId, event)
  }
  append(event) {
    const result = this.store.append('hub', event)
    this.sync()
    return result
  }
  sync() {
    // An upload ACK must survive a host crash, not just reach the JS projection.
    const fd = openSync(join(this.store.root, 'hub/events.jsonl'), 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    const dir = openSync(dirname(join(this.store.root, 'hub/events.jsonl')), 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }
  policy(deviceId) {
    const saved = this.policies.get(key(deviceId))
    return { revision: saved?.seq ?? 0, ...observationPolicy(saved?.policy ?? {}) }
  }
  async configure({ deviceId, policy, expectedRevision, requestId }) {
    return this.blobs.withLock(() => {
    key(deviceId);key(requestId)
    const normalized = observationPolicy(policy), fingerprint = digest({ deviceId, policy: normalized, expectedRevision })
    const old = this.requests.get(requestId)
    if (old) { if (old.fingerprint !== fingerprint) fail('同一策略请求内容不一致', 'REQUEST_CONFLICT');this.sync();return { ok: true, revision: old.seq } }
    if (!this.devices.has(deviceId)) fail('设备尚未连接')
    if (this.policy(deviceId).revision !== expectedRevision) fail('策略已变化，请刷新后重试', 'POLICY_CONFLICT')
    const event = this.append({ type: 'observation.policy', deviceId, policy: normalized, requestId, fingerprint })
    return { ok: true, revision: event.seq }
    })
  }
  hello(deviceId, name, report = {}) {
    key(deviceId);text(name, '设备名称', 80)
    fields(report, ['queueEvents', 'queueBytes', 'retryEvents', 'lastError', 'clientVersion', 'captured', 'filtered', 'networkBytes', 'localNow', 'gatewayReceivedBytes', 'gatewaySentBytes'])
    const data = { queueEvents: integer(report.queueEvents ?? 0, 0, 1000000, '队列数量'), queueBytes: integer(report.queueBytes ?? 0, 0, 2 ** 40, '队列字节'),
      retryEvents: integer(report.retryEvents ?? 0, 0, report.queueEvents ?? 0, '待重试数量'),
      captured: integer(report.captured ?? 0, 0, Number.MAX_SAFE_INTEGER, '采样数'), filtered: integer(report.filtered ?? 0, 0, Number.MAX_SAFE_INTEGER, '过滤数'),
      networkBytes: integer(report.networkBytes ?? 0, 0, Number.MAX_SAFE_INTEGER, '网络字节'),
      gatewayReceivedBytes: integer(report.gatewayReceivedBytes ?? 0, 0, Number.MAX_SAFE_INTEGER, '网关收到字节'), gatewaySentBytes: integer(report.gatewaySentBytes ?? 0, 0, Number.MAX_SAFE_INTEGER, '网关返回字节'),
      lastError: text(report.lastError, '设备错误', 400, true), clientVersion: text(report.clientVersion, '客户端版本', 80, true),
      localNow: integer(report.localNow ?? this.now(), 1, 8640000000000000, '设备时钟') }
    const old = this.devices.get(deviceId)
    if (!old || old.name !== name || this.now() - old.receivedAt >= 5000 || JSON.stringify(old.report) !== JSON.stringify(data))
      this.append({ type: 'observation.device', deviceId, name, report: data, receivedAt: this.now() })
    return { ok: true, deviceId, serverNow: this.now(), policy: this.policy(deviceId) }
  }
  enabled(deviceId, revision, images = false) {
    const policy = this.policy(deviceId)
    if (!policy.enabled) fail('设备同步已暂停，待发资料保留在设备', 'OBSERVATION_PAUSED')
    if (policy.revision !== revision) fail('采集策略已变化，请重新同步策略', 'STALE_POLICY')
    if (images && !policy.uploadImages) fail('关键图片上传未开启', 'IMAGES_DISABLED')
    return policy
  }
  async chunk(deviceId, { revision, data }) {
    key(deviceId)
    return this.blobs.withLock(async () => {
      this.enabled(deviceId, revision, true)
      const bytes = decodeFileChunk(data), sha256 = await this.blobs.put(this.scope(deviceId), bytes)
      return { ok: true, sha256, size: bytes.length }
    })
  }
  normalize(input) { return normalizeObservation(input, id => this.projects.projects.has(id)) }
  async ingest(deviceId, { revision, events }) {
    key(deviceId)
    if (!this.devices.has(deviceId)) fail('请先登记设备')
    if (!Array.isArray(events) || !events.length || events.length > 25) fail('每批需要1–25条观察')
    const receipts = []
    // Partial ACKs identify exactly which items are durable; one bad item cannot hide a committed prefix.
    for (const raw of events) {
      try {
        const receipt = await this.blobs.withLock(async () => {
          const item = this.normalize(raw), fingerprint = fingerprintOf(item), id = `${deviceId}|${item.eventId}`, old = this.records.get(id)
          if (old) {
            if (old.fingerprint !== fingerprint) fail('相同事件ID对应不同内容', 'EVENT_CONFLICT')
            this.sync();this.maybeNotify(old)
            return { eventId: item.eventId, status: old.type === 'observation.filtered' ? 'excluded' : 'duplicate', ref: old.type === 'observation.accepted' ? `hub#${old.seq}` : null, ...(old.reason ? { reason: old.reason } : {}) }
          }
          const policy = this.enabled(deviceId, revision)
          if (policy.excludeApps.some(app => app.toLowerCase() === item.app.toLowerCase()) || policy.excludeApps.length && !item.app) {
            const reason = item.app ? 'excluded_app' : 'unknown_app'
            this.append({ type: 'observation.filtered', deviceId, eventId: item.eventId, fingerprint, reason })
            return { eventId: item.eventId, status: 'excluded', reason }
          }
          let media = null
          if (item.media && policy.uploadImages) {
            const value = item.media
            let bytes
            try { bytes = await this.blobs.read(this.scope(deviceId), value.sha256) }
            catch (error) {
              if (!missing(error)) throw error
              try {
                const hash = await this.blobs.assemble(this.scope(deviceId), value.chunks, value.sha256, value.size)
                bytes = await this.blobs.read(this.scope(deviceId), hash)
              } catch (error) { if (missing(error)) fail('关键图片分块尚未收到，请补传', 'MISSING_IMAGE');throw error }
            }
            const actual = observationImage(bytes)
            if (Object.keys(actual).some(k => actual[k] !== value[k])) fail('图片实际内容与声明不符')
            media = actual
          }
          const receivedAt = this.now()
          const device = this.devices.get(deviceId), offset = device.report.localNow - device.receivedAt
          const event = this.append({ type: 'observation.accepted', ...item, media, deviceId, deviceName: this.devices.get(deviceId).name,
            fingerprint, receivedAt, policyRevision: policy.revision, trust: ['email', 'lark'].includes(item.source) ? 'external' : 'observation',
            mediaExpiresAt: media ? receivedAt + policy.imageRetentionDays * 86400000 : null,
            summaryMinutes: policy.summaryMinutes, lateMinutes: policy.lateMinutes,
            ...(item.media && !media ? { mediaOmitted: 'images_disabled' } : {}), clockSkewMs: Math.abs(offset) > 300000 ? offset : item.occurredAt > receivedAt + 300000 ? item.occurredAt - receivedAt : 0 })
          this.maybeNotify(event)
          return { eventId: item.eventId, status: 'accepted', ref: `hub#${event.seq}`, mediaStored: Boolean(media) }
        })
        receipts.push(receipt)
      } catch (error) { receipts.push({ eventId: typeof raw?.eventId === 'string' ? raw.eventId : null, status: 'error', code: error.code ?? 'OBSERVATION_UNAVAILABLE', error: error.message }) }
    }
    return { ok: true, receipts }
  }
  mediaAvailable(event) {
    return Boolean(event.media && event.seq > (this.cleared.get(event.deviceId) ?? 0)
      && (event.mediaExpiresAt ?? event.receivedAt + 7 * 86400000) > this.now())
  }
  liveKeys() {
    return [...this.records.values()].filter(e => e.type === 'observation.accepted' && this.mediaAvailable(e)).map(e => this.blobs.location(this.scope(e.deviceId), e.media.sha256))
  }
  maybeNotify(event) {
    if (!this.notify || event.type !== 'observation.accepted' || !event.important || event.sourceExpired || this.retention?.isExpired(event)) return
    const policy = this.policy(event.deviceId), previous = this.notified.get(event.deviceId) ?? 0
    const earlier = this.noticeForRef.get(`hub#${event.seq}`)
    if (earlier && (this.hub.cursors.get('mira') ?? 0) >= earlier.seq) return
    if (!policy.enabled || !policy.importantWakeMinutes || this.now() - previous < policy.importantWakeMinutes * 60000) return
    const wake = this.append({ type: 'mira.requested', reason: 'attention', deviceId: event.deviceId, observationRef: `hub#${event.seq}`, requestedAt: this.now(), to: ['mira'] })
    let delivered = false
    try { this.notify(wake);delivered = true } catch { /* Durable wake remains pending; data ACK does not wait for the model. */ }
    this.append({ type: 'observation.notice.result', deviceId: event.deviceId, wakeSeq: wake.seq, delivered })
  }
  async retryImportant() {
    return this.blobs.withLock(() => {
      for (const event of this.latestImportant.values()) this.maybeNotify(event)
    })
  }
  async summarize() {
    return this.blobs.withLock(() => {
      let updated = 0
      for (const window of this.windows.values()) {
        if (this.now() < window.end + window.lateMinutes * 60000) continue
        const original = [...window.events].sort((a, b) => a.occurredAt - b.occurredAt || a.seq - b.seq)
        const fingerprint = digest(original.map(e => e.seq)), old = this.summaries.get(window.id)
        if (old?.fingerprint === fingerprint) continue
        const events = original.filter(e => !e.sourceExpired && !this.retention?.isExpired(e))
        if (!events.length) continue
        const selected = events.slice(0, 50), text = selected.map(e => `${e.title || e.app || e.source}：${e.text.slice(0, 240)}`).join('\n')
        this.append({ type: 'observation.summary', windowId: window.id, deviceId: window.deviceId, deviceName: events.at(-1).deviceName, source: window.source,
          title: '活动窗口摘要', text: `本窗口共${events.length}条观察。${events.length > 50 ? '以下展示前50条，其余可按时间检索。' : ''}\n${text}`,
          refs: selected.map(e => `hub#${e.seq}`), count: events.length, start: window.start, end: window.end, occurredAt: events.at(-1).occurredAt,
          receivedAt: this.now(), trust: events.some(e => e.trust === 'external') ? 'external' : 'observation', fingerprint, version: (old?.version ?? 0) + 1 })
        updated++
      }
      return { ok: true, updated }
    })
  }
  view(event) {
    const retention = this.retention?.sourceStatus(event), expired = event.sourceExpired || retention?.sourceState === 'expired'
    return { ref: `hub#${event.seq}`, deviceId: event.deviceId, deviceName: event.deviceName, source: event.source, app: event.app, title: event.title,
      text: expired ? '' : event.text, ...retention, ...(expired ? { title: retention?.sourceCleanupPending ? '原文已到期，清理待完成' : '原文已按保留设置清理', sourceState: 'expired', sourceExpiredAt: event.sourceExpiredAt ?? retention?.sourceExpiredAt } : {}), projectId: event.projectRef, happenedAt: event.occurredAt, receivedAt: event.receivedAt, localSeq: event.localSeq,
      sourceRefs: event.refs ?? [], summaryVersion: event.version ?? null,
      mediaExpiresAt: event.mediaExpiresAt ?? null,
      trust: event.trust, clockSkewMs: event.clockSkewMs, media: this.mediaAvailable(event) ? { ...event.media, url: `/api/mira-projects/observation/image?ref=hub%23${event.seq}` } : null,
      mediaState: this.mediaAvailable(event) ? 'available' : event.media ? 'expired' : event.mediaOmitted || 'not_saved' }
  }
  source(ref) {
    const match = /^hub#([1-9]\d*)$/.exec(String(ref)), seq = Number(match?.[1])
    const event = this.bySeq.get(seq)
    if (!event) fail('观察来源不存在')
    return event
  }
  async image(ref) {
    return this.blobs.withLock(async () => {
      const event = this.source(ref)
      if (!this.mediaAvailable(event)) fail('关键图片未保存或已过保留期', 'IMAGE_UNAVAILABLE')
      return { bytes: await this.blobs.read(this.scope(event.deviceId), event.media.sha256), mime: event.media.mime }
    })
  }
  async clearMedia({ deviceId, expectedRevision, requestId, through: wanted }) {
    key(deviceId);key(requestId)
    return this.blobs.withLock(async () => {
      if (wanted !== undefined) integer(wanted, 0, this.hub.seq, '清理范围')
      const fingerprint = digest({ deviceId, expectedRevision, through: wanted, kind: 'clear-media' }), old = this.requests.get(requestId)
      if (old && old.fingerprint !== fingerprint) fail('同一清理请求内容不一致', 'REQUEST_CONFLICT')
      if (!old && (!this.devices.has(deviceId) || expectedRevision !== this.policy(deviceId).revision)) fail('设备或策略已变化', 'POLICY_CONFLICT')
      const through = old?.through ?? wanted ?? this.hub.seq
      if (!old) this.append({ type: 'observation.media.cleared', deviceId, through, requestId, fingerprint })
      else this.sync()
      const targets = new Set([...this.records.values()].filter(e => e.deviceId === deviceId && e.seq <= through && e.media)
        .map(e => this.blobs.location(this.scope(deviceId), e.media.sha256)))
      const live = new Set(this.liveKeys())
      for (const object of await this.blobs.listObjects()) if (targets.has(object.key) && !live.has(object.key)) await this.blobs.deleteObject(object)
      if (this.blobs instanceof FileBlobs && targets.size) {
        const directory = openSync(this.blobs.scope(this.scope(deviceId)), 'r')
        try { fsyncSync(directory) } finally { closeSync(directory) }
      }
      return { ok: true, through }
    })
  }
  snapshot({ before, limit = 40, deviceId, source, since, until } = {}) {
    integer(limit, 1, 100, '活动页大小')
    const cursor = before === undefined ? null : /^(\d+):(\d+)$/.exec(String(before))
    if (before !== undefined && (!cursor || !Number.isSafeInteger(Number(cursor[1])) || !Number.isSafeInteger(Number(cursor[2])))) fail('活动游标无效')
    if (deviceId !== undefined) key(deviceId)
    if (source !== undefined && source !== 'summary' && !SOURCES.has(source)) fail('观察来源无效')
    for (const n of [since, until]) if (n !== undefined) integer(n, 1, 8640000000000000, '时间范围')
    if (since !== undefined && until !== undefined && since >= until) fail('时间范围无效')
    const all = [...this.records.values()].filter(e => e.type === 'observation.accepted')
    const candidates = source === 'summary' ? [...this.summaries.values()] : all
    const items = candidates.filter(e => (!cursor || e.occurredAt < Number(cursor[1]) || e.occurredAt === Number(cursor[1]) && e.seq < Number(cursor[2])) && (!deviceId || e.deviceId === deviceId) && (!source || source === 'summary' || e.source === source)
      && (since === undefined || e.occurredAt >= since) && (until === undefined || e.occurredAt < until)).sort((a, b) => b.occurredAt - a.occurredAt || b.seq - a.seq)
    const page = items.slice(0, limit), tail = page.at(-1)
    return { items: page.map(e => this.view(e)), hasMore: items.length > limit, nextCursor: items.length > limit && tail ? `${tail.occurredAt}:${tail.seq}` : null,
      devices: [...this.devices.values()].map(d => {
        const records = all.filter(e => e.deviceId === d.deviceId), unique = new Map(records.filter(e => this.mediaAvailable(e)).map(e => [e.media.sha256, e.media.size]))
        return { id: d.deviceId, name: d.name, receivedAt: d.receivedAt, connection: this.now() - d.receivedAt < 90000 ? 'recent' : 'stale',
          report: d.report, policy: this.policy(d.deviceId), clearThrough: records.reduce((n, e) => Math.max(n, e.seq), 0), notificationPending: this.noticeErrors.get(d.deviceId) === true, events: records.length, images: records.filter(e => this.mediaAvailable(e)).length,
          retainedBytes: [...unique.values()].reduce((a, b) => a + b, 0), imageBytesReceived: records.reduce((n, e) => n + (e.media?.size ?? 0), 0) }
      }) }
  }
}
