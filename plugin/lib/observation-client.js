/** Durable device outbox for Node 24; no capture starts merely by importing this module. */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const sqlite = () => { try { return require('node:sqlite').DatabaseSync } catch { fail('观察队列需要Node 24（Node 22测试需开启experimental-sqlite）', 'SQLITE_UNAVAILABLE') } }
import { mkdirSync, chmodSync, realpathSync, statSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { uptime } from 'node:os'
import { observationImage, observationPolicy, normalizeObservation, OBSERVATION_DEFAULTS } from './observations.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const CHUNK = 512 * 1024
const stringify = value => JSON.stringify(value)
const alive = pid => { try { process.kill(pid, 0);return true } catch (error) { return error.code !== 'ESRCH' } }
const fail = (message, code = 'OBSERVATION_CLIENT') => { const e = new Error(message);e.code = code;throw e }

/** Port of the existing Mira representative-frame priority, retaining its per-display rule.
 * See daimon-mira/client/electron/next-action/screen-evidence.ts. Caller supplies only
 * frames actually cited by the observation; ambiguous multi-event windows stay text-only.
 */
export function chooseObservationFrames(items, maxImages = 1) {
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 4) fail('代表图数量无效')
  const score = item => item.source === 'screen'
    ? /semantic_submit|shortcut|manual/i.test(String(item.context?.trigger || '')) ? 400 : 300
    : /typing_pause|visual_change|app_switch|window_focus/i.test(String(item.context?.captureTrigger || '')) ? 220 : 200
  const candidates = items.filter(item => ['screen', 'accessibility'].includes(item.source) && typeof item.context?.screenshotPath === 'string')
    .sort((a, b) => score(b) - score(a) || Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
  const seen = new Set(), selected = []
  for (const item of candidates) {
    const display = String(item.context.deviceName || item.context.display || 'default')
    if (seen.has(display)) continue
    seen.add(display);selected.push(item)
    if (selected.length >= maxImages) break
  }
  return selected
}

/** Existing Screenpipe adapter semantics: latest changed frame per display, not all frames.
 * Cursor advancement is the caller's transaction with enqueue(), never a wall-clock filter.
 */
export function latestChangedFrames(rows, lastHashByDevice = {}, maxImages = 4) {
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 4) fail('关键帧数量无效')
  const latest = new Map()
  for (const row of rows) {
    if (!Number.isSafeInteger(row.id) || row.id < 1 || !Number.isFinite(Date.parse(row.timestamp)) || !row.snapshot_path) continue
    const display = String(row.device_name || 'unknown-display'), previous = latest.get(display)
    if (!previous || previous.id < row.id) latest.set(display, row)
  }
  return [...latest.values()].filter(row => !row.content_hash || row.content_hash !== lastHashByDevice[String(row.device_name || 'unknown-display')])
    .sort((a, b) => a.id - b.id).slice(-maxImages)
}

/** For the always-on sensor: the latest frame of every window seen (display, app, window), not one per display, so a
 * quick switch to another window still shows up. A window whose latest frame is unchanged since last time is skipped.
 */
export function latestFramePerWindow(rows, lastHashByWindow = {}, max = 6) {
  const latest = new Map()
  for (const row of rows) {
    if (!Number.isSafeInteger(row.id) || row.id < 1 || !Number.isFinite(Date.parse(row.timestamp))) continue
    const key = [row.device_name || 'unknown-display', row.app_name || '', row.window_name || ''].join('|'), previous = latest.get(key)
    if (!previous || previous.id < row.id) latest.set(key, row)
  }
  const hashes = Object.fromEntries([...latest].map(([key, row]) => [key, row.content_hash || '']))
  const chosen = [...latest].filter(([key, row]) => !row.content_hash || row.content_hash !== lastHashByWindow[key]).map(([, row]) => row)
    .sort((a, b) => a.id - b.id).slice(-max)
  return { chosen, hashes }
}

/** Clip long screen text to its start and its end: the start names the window (often a sidebar), the end is what was shown last. */
export function clipEnds(text, max) {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.2)
  return (text.slice(0, head) + ' … ' + text.slice(text.length - (max - head - 3))).toWellFormed()
}

export class ObservationClient {
  constructor({ directory, serverUrl, deviceId, token, fetch: fetcher = fetch, now = () => Date.now(), monotonic = uptime, leaseSeconds = 60 }) {
    const url = new URL(serverUrl)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) fail('观察服务需要HTTPS根地址')
    if (!/^[\w:.-]{1,128}$/.test(deviceId)) fail('设备身份无效')
    if (resolve(directory) !== directory) fail('待发目录需要规范绝对路径')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const info = statSync(directory)
    if (realpathSync(directory) !== directory || info.uid !== process.getuid() || info.mode & 0o077) fail('待发目录必须由当前用户私有持有')
    this.options = { directory, serverUrl: url.origin, deviceId, token, fetcher, now, monotonic, leaseSeconds }
    this.owner = randomUUID();this.busy = false;this.closed = false
    const file = join(directory, 'observations.sqlite')
    this.db = new (sqlite())(file);chmodSync(file, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=4194304;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, body TEXT NOT NULL, image BLOB, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, at INTEGER NOT NULL);`)
    this.transaction(() => {
      const columns = new Set(this.db.prepare('PRAGMA table_info(pending)').all().map(row => row.name))
      if (!columns.has('attempts')) this.db.exec('ALTER TABLE pending ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0')
      if (!columns.has('error_code')) this.db.exec("ALTER TABLE pending ADD COLUMN error_code TEXT NOT NULL DEFAULT ''")
      const destination = this.get('destination')
      if (destination && (destination.serverUrl !== url.origin || destination.deviceId !== deviceId)) fail('待发队列不能切换设备或服务，请使用新的私有目录')
      this.set('destination', { serverUrl: url.origin, deviceId })
    })
  }
  get(name) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(name);return row ? JSON.parse(row.value) : null }
  set(name, value) { this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, stringify(value)) }
  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run();this.db.exec('COMMIT');return result }
    catch (error) { this.db.exec('ROLLBACK');throw error }
  }
  policy() { return this.get('policy') ?? { revision: 0, ...OBSERVATION_DEFAULTS } }
  status() {
    const queue = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(attempts>0),0) AS retries FROM pending').get()
    let diskBytes = 0
    for (const suffix of ['', '-wal', '-shm']) { try { diskBytes += statSync(join(this.options.directory, 'observations.sqlite' + suffix)).size } catch {} }
    const retryError = queue.retries ? `有${queue.retries}条资料等待重试，新资料仍可同步` : ''
    return { queueEvents: Number(queue.count), queueBytes: Number(queue.bytes), retryEvents: Number(queue.retries), diskBytes, lastError: [this.get('lastError'), this.get('sourceError'), retryError].filter(Boolean).join('；').slice(0, 400),
      captured: this.get('captured') || 0, filtered: this.get('filtered') || 0, networkBytes: this.get('networkBytes') || 0,
      lastSentAt: this.get('lastSentAt') || null, policy: this.policy(), syncing: this.busy }
  }
  checkpoint(stream) { return this.get('cursor:' + stream) }
  commitCheckpoint(stream, cursor, filtered = 0) {
    if (typeof stream !== 'string' || !stream || stream.length > 200 || Buffer.byteLength(stringify(cursor)) > 65536 || !Number.isSafeInteger(filtered) || filtered < 0) fail('上游游标或过滤计数无效')
    this.transaction(() => { this.set('cursor:' + stream, cursor);this.set('filtered', (this.get('filtered') || 0) + filtered) })
  }
  enqueue(input, image, { stream, cursor } = {}) {
    if (this.closed) fail('待发队列已关闭')
    return this.transaction(() => {
      const policy = this.policy()
      if (!policy.enabled || this.get('transportBlocked')) fail('设备同步已暂停或凭据已失效，不读取新活动', 'OBSERVATION_PAUSED')
      if (!input || typeof input.eventId !== 'string' || !/^[\w:.-]{1,128}$/.test(input.eventId)) fail('观察需要稳定事件ID')
      if (input.localSeq !== undefined || input.media !== undefined) fail('序号和图片元数据由耐久队列生成')
      if (stream !== undefined && (typeof stream !== 'string' || stream.length > 200 || Buffer.byteLength(stringify(cursor)) > 65536)) fail('上游游标无效')
      const validated = normalizeObservation({ ...input, localSeq: 1 })
      input = { eventId: validated.eventId, source: validated.source, occurredAt: validated.occurredAt, app: validated.app, title: validated.title, text: validated.text,
        ...(validated.projectRef ? { projectId: validated.projectRef } : {}), ...(validated.correlationId ? { correlationId: validated.correlationId } : {}), important: validated.important }
      const finish = () => { if (stream !== undefined) this.set('cursor:' + stream, cursor) }
      const bodyHash = hash(stringify(input)), old = this.db.prepare('SELECT fingerprint FROM seen WHERE id=?').get(input.eventId)
      if (old) {
        if (old.fingerprint !== bodyHash) fail('相同上游事件ID对应不同内容，未推进游标', 'EVENT_CONFLICT')
        finish();return { duplicate: true }
      }
      if (policy.excludeApps.some(app => app.toLowerCase() === String(input.app || '').toLowerCase()) || policy.excludeApps.length && !input.app) {
        this.db.prepare('INSERT INTO seen(id,fingerprint,at) VALUES (?,?,?)').run(input.eventId, bodyHash, this.options.now())
        this.set('filtered', (this.get('filtered') || 0) + 1);finish();return { filtered: true }
      }
      const media = image && policy.uploadImages ? observationImage(image) : null
      const chunks = []
      if (media) for (let offset = 0; offset < image.length; offset += CHUNK) chunks.push(hash(image.subarray(offset, offset + CHUNK)))
      const raw = { ...input, ...(media ? { media: { ...media, chunks } } : {}) }
      const localSeq = (this.get('localSeq') || 0) + 1, body = stringify({ ...raw, localSeq }), size = Buffer.byteLength(body) + (media?.size || 0)
      const pending = Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM pending').get().bytes)
      if (pending + size > policy.maxQueueBytes) fail('待发资料已达限额，停止读取新活动；现有资料保留', 'QUEUE_FULL')
      this.db.prepare('INSERT INTO pending(id,seq,body,image,bytes) VALUES (?,?,?,?,?)').run(input.eventId, localSeq, body, media ? image : null, size)
      this.db.prepare('INSERT INTO seen(id,fingerprint,at) VALUES (?,?,?)').run(input.eventId, bodyHash, this.options.now())
      this.set('localSeq', localSeq);this.set('captured', (this.get('captured') || 0) + 1);finish()
      return { queued: true, localSeq }
    })
  }
  /** Take already-associated old Mira event writer output; never attach an unrelated window image. */
  async enqueueWindow({ stream, cursor, events, items }, encodeImage) {
    if (!this.policy().enabled) fail('设备同步已暂停，不读取新活动', 'OBSERVATION_PAUSED')
    if (!Array.isArray(events) || !events.length) return
    const all = new Set(items.map(item => item.rawRef))
    const refs = events.map(event => [...new Set((event.sourceRefs || []).filter(ref => all.has(ref)))].sort())
    const signatures = refs.map(list => list.join('\n'))
    for (let index = 0; index < events.length; index++) {
      const event = events[index], cited = new Set(refs[index])
      const ambiguous = events.length > 1 && (!cited.size || cited.size === all.size || signatures.filter(s => s === signatures[index]).length > 1)
      const candidates = ambiguous ? [] : items.filter(item => cited.has(item.rawRef) || events.length === 1 && !cited.size)
      const frame = chooseObservationFrames(candidates, 1)[0]
      let image
      if (frame && this.policy().uploadImages && !(this.policy().excludeApps.length && !event.app) && !this.policy().excludeApps.some(app => app.toLowerCase() === String(event.app || '').toLowerCase())) image = await encodeImage(frame.context.screenshotPath)
      // The batch checkpoint is committed only with its final event. Retrying an interrupted prefix is safe.
      this.enqueue({ eventId: event.id, source: event.source || 'activity', occurredAt: Date.parse(event.occurredAt),
        app: event.app || '', title: event.title || '', text: event.text || event.summary,
        important: event.important === true,
        ...(event.projectId ? { projectId: event.projectId } : {}) }, image, index === events.length - 1 ? { stream, cursor } : {})
    }
  }
  claim() {
    return this.transaction(() => {
      const lease = this.get('lease'), now = this.options.monotonic()
      if (lease && lease.owner !== this.owner && lease.pid !== undefined && alive(lease.pid) && now >= lease.acquired && now < lease.until) return false
      this.set('lease', { owner: this.owner, pid: process.pid, acquired: now, until: now + this.options.leaseSeconds });return true
    })
  }
  renew() {
    this.transaction(() => {
      const lease = this.get('lease')
      if (lease?.owner !== this.owner) fail('另一进程正在同步，当前请求停止', 'LEASE_LOST')
      const now = this.options.monotonic();this.set('lease', { ...lease, until: now + this.options.leaseSeconds })
    })
  }
  release() {
    if (this.closed) return
    this.transaction(() => { if (this.get('lease')?.owner === this.owner) this.set('lease', null) })
  }
  async request(operation, payload) {
    this.renew()
    const credential = this.options.token()
    if (typeof credential !== 'string' || !credential) fail('设备凭据不可用')
    const body = stringify(payload), size = Buffer.byteLength(body)
    this.transaction(() => this.set('networkBytes', (this.get('networkBytes') || 0) + size))
    let response
    try {
      response = await this.options.fetcher(`${this.options.serverUrl}/api/desktop/observation/${operation}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' }, body })
    } catch { fail('连接观察服务失败，资料保留待重试', 'NETWORK_UNAVAILABLE') }
    const resultText = await response.text()
    this.transaction(() => this.set('networkBytes', (this.get('networkBytes') || 0) + Buffer.byteLength(resultText)))
    if (!response.ok) {
      let code
      try { code = JSON.parse(resultText).code } catch {}
      if (code === 'FILE_QUOTA_EXCEEDED') fail('服务器关键图片配额已满，待发资料保留；请先清理或增加配额', 'REMOTE_QUOTA_FULL')
      if (['STALE_POLICY', 'OBSERVATION_PAUSED', 'IMAGES_DISABLED'].includes(code)) fail('同步策略已变化，待发资料保留并在下次连接刷新', code)
      fail(`观察服务返回${response.status}，资料保留${response.status === 401 ? '；请检查设备凭据' : ''}`, 'HTTP_' + response.status)
    }
    try { return JSON.parse(resultText) } catch { fail('服务回执格式无效，资料保留') }
  }
  acknowledge(receipts, batch) {
    const expected = new Set(batch.map(row => row.id)), done = new Set()
    for (const receipt of receipts || []) {
      if (!expected.has(receipt.eventId) || done.has(receipt.eventId)) fail('回执包含未知或重复事件，保留待发资料')
      if (!['accepted', 'duplicate', 'excluded', 'error'].includes(receipt.status)
        || ['accepted', 'duplicate'].includes(receipt.status) && !/^hub#[1-9]\d*$/.test(receipt.ref ?? '')) fail('回执未证明事件已保存，保留待发资料')
      done.add(receipt.eventId)
    }
    if (done.size !== expected.size) fail('回执不完整，保留待发资料')
    this.transaction(() => {
      if (this.get('lease')?.owner !== this.owner) fail('当前同步已失去队列租约', 'LEASE_LOST')
      for (const receipt of receipts) if (['accepted', 'duplicate', 'excluded'].includes(receipt.status)) {
        const changed = this.db.prepare('DELETE FROM pending WHERE id=?').run(receipt.eventId).changes
        if (changed && receipt.status === 'excluded') this.set('filtered', (this.get('filtered') || 0) + 1)
      } else {
        const code = /^[A-Z0-9_]{1,80}$/.test(receipt.code ?? '') ? receipt.code : 'OBSERVATION_REJECTED'
        this.db.prepare('UPDATE pending SET attempts=attempts+1,error_code=? WHERE id=?').run(code, receipt.eventId)
      }
      this.db.prepare('DELETE FROM seen WHERE id NOT IN (SELECT id FROM pending) AND id IN (SELECT id FROM seen ORDER BY at DESC LIMIT -1 OFFSET 100000)').run()
      this.set('lastSentAt', this.options.now())
    })
  }
  async tick({ upload = true } = {}) {
    if (this.busy || this.closed || !this.claim()) return
    this.busy = true
    try {
      const status = this.status()
      const hello = await this.request('hello', { report: { queueEvents: status.queueEvents, queueBytes: status.queueBytes, retryEvents: status.retryEvents, lastError: status.lastError,
        captured: status.captured, filtered: status.filtered, networkBytes: status.networkBytes, localNow: this.options.now(), clientVersion: 'observations-v1' } })
      if (hello.ok === true && hello.deviceId !== this.options.deviceId) fail('设备凭据与当前设备身份不符，已停止读取新资料', 'DEVICE_IDENTITY_MISMATCH')
      if (hello.ok !== true || !hello.policy) fail('设备策略回执无效')
      const { revision, ...settings } = hello.policy
      if (!Number.isSafeInteger(revision) || revision < 0) fail('设备策略版本无效')
      const policy = { ...observationPolicy(settings), revision }
      this.transaction(() => { this.set('policy', policy);this.set('transportBlocked', false) })
      this.db.exec('PRAGMA max_page_count=' + (4096 + Math.ceil(policy.maxQueueBytes / 4096)))
      if (!policy.enabled || !upload) return
      this.transaction(() => {
        const rows = this.db.prepare('SELECT id, body FROM pending').all()
        for (const row of rows) if (policy.excludeApps.some(app => app.toLowerCase() === String(JSON.parse(row.body).app || '').toLowerCase()) || policy.excludeApps.length && !JSON.parse(row.body).app) {
          this.db.prepare('DELETE FROM pending WHERE id=?').run(row.id)
          this.set('filtered', (this.get('filtered') || 0) + 1)
        }
      })
      // Fair retries: a page of rejected observations cannot permanently starve newer valid work.
      const batch = this.db.prepare('SELECT id, body, image FROM pending ORDER BY attempts,seq LIMIT 25').all()
      if (batch.length) {
        const events = batch.map(row => JSON.parse(row.body))
        // Ask for idempotent receipts first. Already-committed images need no retransmission.
        let response = await this.request('ingest', { revision: policy.revision, events })
        if (response.ok !== true || !Array.isArray(response.receipts)) fail('观察回执格式无效')
        this.acknowledge(response.receipts, batch)
        const missing = new Set(response.receipts.filter(r => r.status === 'error' && r.code === 'MISSING_IMAGE').map(r => r.eventId))
        if (missing.size && policy.uploadImages) {
          for (let index = 0; index < batch.length; index++) if (missing.has(batch[index].id) && batch[index].image) {
            const bytes = Buffer.from(batch[index].image)
            for (let offset = 0; offset < bytes.length; offset += CHUNK) {
              const chunk = bytes.subarray(offset, offset + CHUNK), expected = hash(chunk)
              const result = await this.request('chunk', { revision: policy.revision, data: chunk.toString('base64') })
              if (result.ok !== true || result.sha256 !== expected || result.size !== chunk.length) fail('图片分块回执不匹配，原图保留')
            }
          }
          response = await this.request('ingest', { revision: policy.revision, events })
        }
        this.acknowledge(response.receipts, batch)
        const failed = response.receipts.find(r => !['accepted', 'duplicate', 'excluded'].includes(r.status))
        if (failed) fail('部分观察尚未接收：' + (failed.code || 'UNKNOWN'), failed.code)
      }
      this.transaction(() => this.set('lastError', ''))
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch (error) {
      // Never persist a raw fetch error or a request URL containing a credential.
      const message = typeof error.code === 'string' ? error.message : '观察同步失败，原始待发资料保留'
      this.transaction(() => { this.set('lastError', message);if (['HTTP_401', 'HTTP_403', 'DEVICE_IDENTITY_MISMATCH'].includes(error.code)) this.set('transportBlocked', true) })
    } finally { this.busy = false;this.release();this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') }
  }
  close() {
    if (this.busy) fail('正在同步，不能关闭待发队列')
    if (!this.closed) { this.release();this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db.close();this.closed = true }
  }
}

/** Timers are independent: polling the source never implies uploading or waking a model. */
export class ObservationRunner {
  constructor({ client, sources = [], encodeImage, enabled = () => true, available = () => true, monotonic = uptime }) {
    this.client = client;this.sources = sources;this.encodeImage = encodeImage;this.enabled = enabled;this.available = available;this.monotonic = monotonic
    this.nextPolicy = 0;this.nextUpload = 0;this.nextSample = 0;this.busy = false;this.timer = null;this.stopped = true
  }
  pauseSources() {
    if (this.client.get('sourceControl')?.paused) return
    this.client.transaction(() => this.client.set('sourceControl', { paused: true, generation: randomUUID() }))
  }
  resumeSources() {
    const control = this.client.get('sourceControl')
    if (!control?.paused) return
    this.client.transaction(() => {
      for (const source of this.sources) if (source.stream) this.client.set('resume:' + source.stream, control.generation)
      this.client.set('sourceControl', { ...control, paused: false })
    })
  }
  async runOnce() {
    if (this.busy) return
    this.busy = true
    try {
      if (!this.enabled()) { this.pauseSources();return }
      const now = this.monotonic(), uploadDue = now >= this.nextUpload
      if (now >= this.nextPolicy || uploadDue) {
        await this.client.tick({ upload: uploadDue })
        this.nextPolicy = now + 30
        if (uploadDue) this.nextUpload = now + this.client.policy().uploadSeconds
      }
      const policy = this.client.policy()
      if (!policy.enabled || this.client.get('transportBlocked') || !this.available()) { this.pauseSources();return }
      if (now < this.nextSample) return
      this.resumeSources()
      const sourceErrors = []
      for (const source of this.sources) {
        try { await source.collect(this.client, this.encodeImage) }
        catch (error) { sourceErrors.push(typeof error.code === 'string' ? error.message : '一个活动来源暂时不可用，游标保留') }
      }
      this.client.transaction(() => this.client.set('sourceError', sourceErrors.join('；').slice(0, 400)))
      this.nextSample = now + policy.sampleSeconds
      if (this.client.status().queueEvents >= 25) {
        await this.client.tick()
        this.nextUpload = now + (this.client.status().queueEvents >= 25 ? 1 : policy.uploadSeconds)
      }
    } catch (error) {
      this.client.transaction(() => this.client.set('lastError', typeof error.code === 'string' ? error.message : '读取活动失败，游标保留待重试'))
    } finally { this.busy = false }
  }
  start() {
    if (!this.stopped) return
    this.stopped = false
    const next = async () => { if (this.stopped) return;await this.runOnce();if (!this.stopped) this.timer = setTimeout(next, 1000) }
    this.timer = setTimeout(next, 0)
  }
  async stop() {
    this.stopped = true;clearTimeout(this.timer)
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Adapter for the existing Mira/Screenpipe frames schema. Opens a supplied DB read-only;
 * it does not start Screenpipe, take a screenshot or read earlier account history by default.
 */
export class ScreenpipeObservationSource {
  /** intervalMs, perWindow and maxText are for the always-on sensor: read at most that often, keep every window seen, clip its text. */
  constructor({ dbPath, imageRoot, stream = 'screenpipe-frames', startFromNow = true, intervalMs = 0, perWindow = false, maxText = 16000, now = Date.now }) {
    this.dbPath = resolve(dbPath);this.imageRoot = realpathSync(imageRoot);this.stream = stream;this.startFromNow = startFromNow
    Object.assign(this, { intervalMs, perWindow, maxText, now });this.lastRun = -Infinity
  }
  async collect(client, encodeImage) {
    if (!client.policy().enabled) return
    if (this.intervalMs) { const now = this.now();if (now - this.lastRun < this.intervalMs) return;this.lastRun = now }
    let info
    try { info = statSync(this.dbPath) } catch { fail('Screenpipe数据库暂时不可用，未读取活动', 'SCREENPIPE_UNAVAILABLE') }
    const identity = `${info.dev}:${info.ino}`
    const db = new (sqlite())(this.dbPath, { readOnly: true })
    try {
      const required = ['id', 'timestamp', 'app_name', 'device_name', 'window_name', 'window_name_redacted_at', 'snapshot_path', 'image_redacted_at', 'accessibility_text', 'accessibility_redacted_at', 'content_hash']
      const columns = new Set(db.prepare('PRAGMA table_info(frames)').all().map(row => row.name))
      if (required.some(column => !columns.has(column))) fail('此Screenpipe库缺少所需的图片/脱敏字段，未读取活动', 'SCREENPIPE_SCHEMA')
      const maximum = Number(db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM frames').get().id)
      let state = client.checkpoint(this.stream)
      const resumeGeneration = client.get('resume:' + this.stream), resumed = (state?.resumeGeneration ?? null) !== resumeGeneration
      if (!state || state.identity !== identity || state.id > maximum || resumed) {
        const first = !state
        const skipExisting = first && this.startFromNow || resumed
        state = { identity, epoch: randomUUID(), id: skipExisting ? maximum : 0, hashes: {}, resumeGeneration }
        client.commitCheckpoint(this.stream, state)
        if (skipExisting) return
      }
      // Screenpipe 0.4 stores content_hash as a 64-bit integer; read it as text so it is never too large for a JS number.
      const rows = db.prepare(`SELECT id,timestamp,app_name,device_name,CAST(content_hash AS TEXT) AS content_hash,
        CASE WHEN window_name_redacted_at IS NULL THEN window_name ELSE '' END AS window_name,
        CASE WHEN image_redacted_at IS NULL THEN snapshot_path ELSE NULL END AS snapshot_path,
        CASE WHEN accessibility_redacted_at IS NULL THEN accessibility_text ELSE '' END AS accessibility_text
        FROM frames WHERE id>? ORDER BY id ASC LIMIT 120`).all(state.id)
      if (!rows.length) return
      const eligible = rows.filter(row => !(client.policy().excludeApps.length && !row.app_name) && !client.policy().excludeApps.some(app => app.toLowerCase() === String(row.app_name || '').toLowerCase()))
      const perWindow = this.perWindow ? latestFramePerWindow(eligible, state.hashes) : null
      const chosen = perWindow ? perWindow.chosen : latestChangedFrames(eligible, state.hashes, 4)
      // Per window, only the windows of this read are remembered, so the place stays small however many windows were ever open.
      const hashes = perWindow ? perWindow.hashes : { ...state.hashes }
      for (const row of chosen) {
        let image
        if (client.policy().uploadImages && (!this.perWindow || row.snapshot_path)) {
          if (typeof encodeImage !== 'function') fail('需要已配置的关键图片编码器，原游标保留', 'IMAGE_ENCODER_REQUIRED')
          const file = realpathSync(row.snapshot_path)
          if (file !== this.imageRoot && !file.startsWith(this.imageRoot + sep)) fail('关键图片不在明确授权的缓存目录内', 'IMAGE_PATH')
          image = await encodeImage(file)
        }
        const raw = String(row.accessibility_text || row.window_name || '屏幕发生变化，未提供文字内容')
        const text = this.perWindow ? clipEnds(raw, this.maxText) : raw.slice(0, this.maxText).toWellFormed()
        client.enqueue({ eventId: 'screen-' + hash(state.epoch + ':' + row.id).slice(0, 40), source: 'screen', occurredAt: Date.parse(row.timestamp),
          app: String(row.app_name || '').slice(0, 160).toWellFormed(), title: String(row.window_name || '').slice(0, 400).toWellFormed(), text }, image)
        if (row.content_hash && !perWindow) hashes[String(row.device_name || 'unknown-display')] = row.content_hash
      }
      client.commitCheckpoint(this.stream, { ...state, id: Number(rows.at(-1).id), hashes }, rows.length - chosen.length)
    } finally { db.close() }
  }
}

/** Read the existing completed-window journal, preserving its 10-minute assembly and late wait. */
export class MiraJournalObservationSource {
  constructor({ journal, stream = 'mira-completed-windows', startFromNow = true }) { this.journal = resolve(journal);this.stream = stream;this.startFromNow = startFromNow }
  async collect(client) {
    if (!client.policy().enabled) return
    let info
    try { info = statSync(this.journal) } catch { fail('本地活动台账尚未生成，未读取历史', 'JOURNAL_UNAVAILABLE') }
    const identity = `${info.dev}:${info.ino}`
    let state = client.checkpoint(this.stream)
    const resumeGeneration = client.get('resume:' + this.stream), resumed = (state?.resumeGeneration ?? null) !== resumeGeneration
    if (!state || state.identity !== identity || info.size < state.offset || resumed) {
      const first = !state
      const skipExisting = first && this.startFromNow || resumed
      let partial = false
      if (skipExisting && info.size) {
        const fd = openSync(this.journal, 'r'), last = Buffer.alloc(1)
        try { partial = readSync(fd, last, 0, 1, info.size - 1) === 1 && last[0] !== 10 } finally { closeSync(fd) }
      }
      state = { identity, offset: skipExisting ? info.size : 0, resumeGeneration, skipPartialLine: partial }
      client.commitCheckpoint(this.stream, state)
      if (skipExisting) return
    }
    const buffer = Buffer.alloc(Math.min(256 * 1024, Math.max(0, info.size - state.offset))), fd = openSync(this.journal, 'r')
    let count
    try { count = readSync(fd, buffer, 0, buffer.length, state.offset) } finally { closeSync(fd) }
    const end = buffer.subarray(0, count).lastIndexOf(10)
    if (end < 0) { if (count === 256 * 1024) fail('本地活动台账单行过大，未推进游标', 'SOURCE_LINE_TOO_LARGE');return }
    const start = state.skipPartialLine ? buffer.subarray(0, count).indexOf(10) + 1 : 0
    let content
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(start, end + 1)) }
    catch { fail('本地活动台账不是有效UTF-8，未推进游标', 'SOURCE_INVALID_UTF8') }
    if (start) { state.offset += start;state.skipPartialLine = false;client.commitCheckpoint(this.stream, state) }
    for (const line of content.split('\n').slice(0, -1)) {
      if (!line) { state.offset++;client.commitCheckpoint(this.stream, state);continue }
      let row
      try { row = JSON.parse(line) } catch { fail('本地活动台账存在无效记录，未推进游标', 'SOURCE_INVALID_JSON') }
      const occurredAt = Date.parse(row.start), endedAt = Date.parse(row.end)
      const body = Array.isArray(row.eventTitles) ? row.eventTitles.filter(t => typeof t === 'string').join('；').slice(0, 16000) : ''
      if (row.flushReason === 'time_fallback' && body && Number.isFinite(occurredAt) && Number.isFinite(endedAt) && endedAt > occurredAt) {
        const id = 'window-' + hash(String(row.windowId ?? occurredAt)).slice(0, 32)
        client.enqueue({ eventId: id, correlationId: id, source: 'activity', occurredAt, title: '本地活动窗口', text: body })
      }
      state.offset += Buffer.byteLength(line + '\n')
      client.commitCheckpoint(this.stream, state)
    }
  }
}

/** Use Electron's existing raster codec rather than shipping another screenshot capture stack. */
export function electronObservationEncoder(nativeImage, { maxEdge = 1600, quality = 80 } = {}) {
  if (!Number.isInteger(maxEdge) || maxEdge < 320 || maxEdge > 4096 || !Number.isInteger(quality) || quality < 30 || quality > 95) fail('图片压缩设置无效')
  return async path => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size < 24 || stat.size > 32 * 1024 * 1024) fail('原始关键画面过大或不可用', 'IMAGE_DECODE')
      bytes = Buffer.alloc(stat.size);let offset = 0
      while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset);if (!count) fail('读取期间关键画面发生变化', 'IMAGE_CHANGED');offset += count }
      if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length)) fail('读取期间关键画面发生变化', 'IMAGE_CHANGED')
      observationImage(bytes, { maxBytes: 32 * 1024 * 1024 })
    } finally { closeSync(fd) }
    let image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) fail('关键图片无法读取，原游标保留', 'IMAGE_DECODE')
    const size = image.getSize(), scale = Math.min(1, maxEdge / Math.max(size.width, size.height))
    if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' })
    return image.toJPEG(quality)
  }
}
