/** Owner-controlled source-body retention. Conversation/project/knowledge logs are not purged. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, mkdirSync, lstatSync, readFileSync, openSync, closeSync, writeSync, writeFileSync, readSync, fsyncSync, renameSync, unlinkSync, realpathSync, fstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { PersonalSearchIndex, discardPersonalSearchCache } from './personal-search-index.js'

const DAY = 86400000
const RAW = new Set(['pc.window', 'pc.signal', 'observation.accepted', 'connector.record'])
const kind = event => event.type === 'observation.summary' ? 'summary' : RAW.has(event.type) ? 'raw' : null
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const requestId = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9:._-]{8,128}$/.test(value)) throw Error('保留设置需要稳定请求标识');return value }
const METADATA = new Set(['seq', 'at', 'projectId', 'type', 'deviceId', 'deviceName', 'eventId', 'localSeq', 'source', 'occurredAt', 'receivedAt', 'startedAt', 'endedAt', 'minutes', 'kind', 'app', 'windowId', 'start', 'end', 'connectorId', 'connectorName', 'externalId', 'provider', 'scope', 'deleted', 'trust', 'projectRef', 'correlationId', 'media', 'mediaExpiresAt', 'mediaOmitted', 'summaryMinutes', 'lateMinutes', 'clockSkewMs', 'policyRevision', 'fingerprint', 'version', 'refs', 'count', 'to'])
function sanitized(event, target, plan) {
  return { ...Object.fromEntries(Object.entries(event).filter(([key]) => METADATA.has(key))), text: '', title: '',
    ...(event.type === 'pc.window' ? { summary: '' } : {}), sourceExpired: true, sourceExpiredAt: plan.expiredAt, sourceContentHash: target.digest }
}
function regular(path) {
  let stat
  try { stat = lstatSync(path) } catch (e) { if (e.code === 'ENOENT') return null;throw e }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('保留清理文件归属无效')
  return stat
}
function syncDirectory(path) { const fd = openSync(path, constants.O_RDONLY);try { fsyncSync(fd) } finally { closeSync(fd) } }
export function retentionPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['rawDays', 'summaryDays'].includes(k))) throw Error('文字保留设置字段无效')
  const policy = { rawDays: 0, summaryDays: 0, ...value }
  for (const days of Object.values(policy)) if (!Number.isInteger(days) || days < 0 || days > 3650) throw Error('保留时间需为0–3650天，0表示长期保留')
  return policy
}

export class SourceRetention {
  constructor(store, projects, { now = Date.now } = {}) {
    this.store = store;this.projects = projects;this.now = now
    this.root = join(store.root, '_source-retention');this.file = join(store.root, 'hub/events.jsonl')
    this.plans = new Map();this.repair = new Set();this.expiredSeqs = new Set();this.completedSeqs = new Set();this.pendingSeqs = new Set();this.requests = new Map();this.personals = new Set();this.error = null
    for (const event of this.hub.events) this.fold(event)
    this.off = store.onChange(event => { if (event?.projectId === 'hub') this.fold(event) })
    // Pure legacy day views share the same deadline guard without serializing
    // the service or exposing the raw journal through another read path.
    Object.defineProperty(this.hub, 'sourceRetention', { value: this, configurable: true })
    // Recovery precedes Drivers and source consumers. A partial purge never exposes the old body again.
    try { this.collect() } catch { /* Snapshot reports pending cleanup; queries retry instead of returning stale hits. */ }
  }
  get hub() { return this.store.get('hub') }
  close() { this.off?.();this.closed = true }
  attach(personal) { this.personals.add(personal) }
  detach(personal) { this.personals.delete(personal) }
  event(seq) { const direct = this.hub.events[seq - 1];return direct?.seq === seq ? direct : this.hub.events.find(e => e.seq === seq) }
  fold(event) {
    if (kind(event)) { this.nextCheckAt = 0;if (event.sourceExpired) this.expiredSeqs.add(event.seq) }
    if (event.type === 'source.retention.policy') { this.saved = event;this.requests.set(event.requestId, event);this.nextCheckAt = 0 }
    if (event.type === 'source.retention.started') {
      if (!/^[0-9a-f-]{36}$/.test(event.purgeId) || !Array.isArray(event.targets) || !Number.isFinite(event.expiredAt)) throw Error('保留清理记录无效')
      const plan = { ...event, completed: false };this.plans.set(event.purgeId, plan);this.mask(plan)
    }
    if (event.type === 'source.retention.completed') {
      const plan = this.plans.get(event.purgeId);if (plan) plan.completed = true
      if (plan && !this.repair.has(plan.purgeId)) for (const target of plan.targets) { this.completedSeqs.add(target.seq);this.pendingSeqs.delete(target.seq) }
      this.lastCompletedAt = event.completedAt
      this.lastCompletedSeq = event.seq
    }
  }
  mask(plan) {
    for (const target of plan.targets) {
      if (!Number.isSafeInteger(target.seq) || target.seq < 1 || !/^[0-9a-f]{64}$/.test(target.digest)) throw Error('保留清理来源身份无效')
      const event = this.event(target.seq)
      if (!event || !kind(event) || !(hash(event) === target.digest || event.sourceExpired && event.sourceContentHash === target.digest)) throw Error('保留清理来源已变化')
      const next = sanitized(event, target, plan)
      this.expiredSeqs.add(event.seq)
      this.pendingSeqs.add(event.seq)
      if (JSON.stringify(event) !== JSON.stringify(next)) {
        this.repair.add(plan.purgeId)
        for (const key of Object.keys(event)) delete event[key]
        Object.assign(event, next)
      }
    }
  }
  validateJournal() {
    if (realpathSync(dirname(this.file)) !== join(realpathSync(this.store.root), 'hub') || !regular(this.file)) throw Error('原日志位置或归属无效')
  }
  sync() { this.validateJournal();const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);try { fsyncSync(fd) } finally { closeSync(fd) };syncDirectory(dirname(this.file)) }
  append(event) { this.validateJournal();const result = this.store.append('hub', event);this.sync();return result }
  policy() { return { ...retentionPolicy(this.saved?.policy ?? {}), revision: this.saved?.seq ?? 0 } }
  epoch() { return this.lastCompletedSeq ?? 0 }
  expiresAt(event) {
    const category = kind(event), policy = this.policy(), days = category && policy[category === 'raw' ? 'rawDays' : 'summaryDays'], received = event.receivedAt ?? event.at
    return days && Number.isFinite(received) ? received + days * DAY : null
  }
  isExpired(event) { const expires = this.expiresAt(event);return Boolean(event.sourceExpired || expires !== null && expires <= this.now()) }
  sourceStatus(event) {
    if (!kind(event)) return null
    const expires = this.expiresAt(event)
    return { sourceExpiresAt: expires, ...(this.isExpired(event) ? { sourceState: 'expired', sourceExpiredAt: event.sourceExpiredAt ?? expires,
      sourceCleanupPending: !this.completedSeqs.has(event.seq) || this.pendingSeqs.has(event.seq) } : {}) }
  }
  targets() {
    const policy = this.policy(), now = this.now()
    if (!policy.rawDays && !policy.summaryDays || now < (this.nextCheckAt ?? 0)) return []
    let next = Infinity
    const targets = this.hub.events.filter(event => {
      const category = kind(event), days = category && policy[category === 'raw' ? 'rawDays' : 'summaryDays']
      const received = event.receivedAt ?? event.at
      if (!days || event.sourceExpired || event.deleted || !Number.isFinite(received)) return false
      const expires = received + days * DAY
      if (expires > now) { next = Math.min(next, expires);return false }
      return true
    }).map(event => ({ seq: event.seq, digest: hash(event) }))
    this.nextCheckAt = next
    return targets
  }
  configure({ policy, expectedRevision, requestId: request }) {
    if (this.closed) throw Error('文字留存服务已停止')
    requestId(request)
    const normalized = retentionPolicy(policy)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw Error('保留策略版本无效')
    const fingerprint = hash({ policy: normalized, expectedRevision }), old = this.requests.get(request)
    if (old && old.fingerprint !== fingerprint) throw Error('同一保留设置请求内容不一致')
    if (!old && expectedRevision !== this.policy().revision) throw Error('保留设置已变化，请重新读取')
    const event = old ?? this.append({ type: 'source.retention.policy', policy: normalized, requestId: request, fingerprint })
    if (old) this.sync()
    try { this.collect() } catch {}
    return { ok: true, revision: event.seq, cleanup: this.snapshot() }
  }
  prepareRoot() {
    this.validateJournal()
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const stat = lstatSync(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('保留清理目录须为私有实际目录')
    const marker = join(this.root, 'owner.json'), expected = { component: 'mira-source-retention', hubRoot: realpathSync(this.store.root), version: 1 }
    if (regular(marker)) {
      if (JSON.stringify(JSON.parse(readFileSync(marker, 'utf8'))) !== JSON.stringify(expected)) throw Error('保留清理目录归属无效')
    } else {
      const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { writeFileSync(fd, JSON.stringify(expected));fsyncSync(fd) } finally { closeSync(fd) }
      syncDirectory(this.root);syncDirectory(dirname(this.root))
    }
  }
  replaceJournal(temporary, identity) {
    const current = regular(this.file)
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs) throw Error('原日志在清理时发生变化')
    renameSync(temporary, this.file)
    syncDirectory(dirname(this.file));syncDirectory(this.root)
  }
  rewrite(plan) {
    const temporary = join(this.root, plan.purgeId + '.next')
    if (regular(temporary)) unlinkSync(temporary)
    const input = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW), identity = fstatSync(input)
    let output
    try {
      output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const targets = new Map(plan.targets.map(t => [t.seq, t])), seen = new Set(), chunk = Buffer.alloc(64 * 1024)
      const write = bytes => { let offset = 0;while (offset < bytes.length) offset += writeSync(output, bytes, offset, bytes.length - offset) }
      const line = bytes => {
        if (!bytes.toString('utf8').trim()) { write(bytes);return }
        let event;try { event = JSON.parse(bytes.toString('utf8')) } catch { throw Error('原日志包含无法安全清理的记录') }
        const target = targets.get(event.seq)
        if (!target) { write(bytes);return }
        if (seen.has(event.seq) || !kind(event) || !(hash(event) === target.digest || event.sourceExpired && event.sourceContentHash === target.digest)) throw Error('原文身份与清理记录不一致')
        seen.add(event.seq);write(Buffer.from(JSON.stringify(sanitized(event, target, plan)) + (bytes.at(-1) === 10 ? '\n' : '')))
      }
      let pending = Buffer.alloc(0), size
      while ((size = readSync(input, chunk, 0, chunk.length, null))) {
        pending = Buffer.concat([pending, chunk.subarray(0, size)])
        let start = 0, end
        while ((end = pending.indexOf(10, start)) >= 0) { line(pending.subarray(start, end + 1));start = end + 1 }
        pending = Buffer.from(pending.subarray(start))
      }
      if (pending.length) line(pending)
      if (seen.size !== targets.size) throw Error('清理来源不完整')
      fsyncSync(output);closeSync(output);output = undefined
      this.replaceJournal(temporary, identity)
    } finally {
      closeSync(input);if (output !== undefined) closeSync(output)
      if (regular(temporary)) { unlinkSync(temporary);syncDirectory(this.root) }
    }
  }
  finish(plan) {
    this.append({ type: 'source.retention.completed', purgeId: plan.purgeId, count: plan.targets.length, completedAt: this.now() })
  }
  validateCacheEpoch() {
    const epoch = this.epoch()
    if (!epoch || this.cacheValidatedEpoch === epoch) return
    const index = new PersonalSearchIndex({ hubStore: this.store, projects: this.projects })
    if (!['', '-journal', '-wal', '-shm'].some(suffix => regular(index.file + suffix))) { this.cacheValidatedEpoch = epoch;return }
    let actual
    try { index.open();actual = index.db.prepare('SELECT count FROM checkpoints WHERE log_id=?').get('@source-retention')?.count ?? 0 }
    finally { index.close() }
    if (actual !== epoch) {
      for (const personal of this.personals) personal.index.close()
      discardPersonalSearchCache(this.store, this.projects)
      for (const personal of this.personals) personal.index = new PersonalSearchIndex(personal)
    }
    this.cacheValidatedEpoch = epoch
  }
  collect() {
    if (this.closed) throw Error('文字留存服务已停止')
    if (this.collecting) throw Error('文字留存清理正在进行')
    this.collecting = true
    try {
      let count = 0
      for (;;) {
        let pending = [...this.plans.values()].filter(p => !p.completed || this.repair.has(p.purgeId))
        // Admit every newly due record before retrying a failed older plan.
        // A cache/rename failure must not leave later expired sources readable.
        const targets = this.targets()
        if (targets.length) {
          this.prepareRoot()
          const event = this.append({ type: 'source.retention.started', purgeId: randomUUID(), targets, expiredAt: this.now() })
          pending.push(this.plans.get(event.purgeId))
        }
        if (!pending.length) break
        this.prepareRoot()
        for (const personal of this.personals) personal.index.close()
        discardPersonalSearchCache(this.store, this.projects)
        for (const plan of pending) {
          this.mask(plan);this.rewrite(plan);this.repair.delete(plan.purgeId);this.finish(plan);count += plan.targets.length
        }
        for (const personal of this.personals) personal.index = new PersonalSearchIndex(personal)
        this.cacheValidatedEpoch = this.epoch();this.nextCheckAt = 0
      }
      this.validateCacheEpoch()
      this.error = null;if (count) this.store.touch()
      return { ok: true, expired: count }
    } catch {
      // targets() computed a future wake before planning. Until the plan is
      // durable, every retry must re-evaluate those still-unmasked records.
      this.nextCheckAt = 0
      this.error = '原文清理尚未完成，过期资料暂不用于检索；可重试清理。'
      throw Error(this.error)
    } finally { this.collecting = false }
  }
  snapshot() {
    return { policy: this.policy(), pending: Boolean(this.error) || [...this.plans.values()].some(p => !p.completed || this.repair.has(p.purgeId)), error: this.error,
      lastCompletedAt: this.lastCompletedAt ?? null, expired: this.expiredSeqs.size, cleaned: this.completedSeqs.size, now: this.now(),
      scope: '按服务器收到时间清理源原文和标题；图片按设备策略单独保留。对话、项目交接、记忆、回顾和原生执行历史不在此清理范围。' }
  }
}
