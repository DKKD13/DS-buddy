/** Signed GitHub data enters the inbox, never the owner command interface. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { RuntimeError } from './postgres.js'
import { COORDINATOR, MIRA } from '../store.js'
import { planMiraWake } from '../mira.js'

const TYPES = ['pull_request', 'issue_comment', 'check_run']
const MAX_BODY = 1024 * 1024
const fail = (code, message) => { throw new RuntimeError(code, message) }
function text(value, label, max = 1024) {
  if (typeof value !== 'string' || value.length > max) fail('INVALID_INPUT', label + ' 无效或过长')
  return value
}
function number(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_INPUT', label + ' 无效')
  return value
}
function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) fail('INVALID_INPUT', label + ' 不受支持')
  return value
}
function sha(value) {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value ?? '')) fail('INVALID_INPUT', '提交 SHA 无效')
  return value
}
function normalize(source, type, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'GitHub 正文须为对象')
  if (type === 'ping' && input.repository == null) return null
  if (String(input.repository?.id) !== source.repository_id
    || input.repository?.full_name !== source.repository) fail('FORBIDDEN', '事件仓库与授权来源不匹配')
  if (type === 'ping') return null
  const base = { provider: 'github', event: type, repository: source.repository,
    actor: text(input.sender?.login ?? '', 'sender', 256) }
  const origin = 'https://github.com/' + source.repository
  if (type === 'pull_request') {
    const pr = input.pull_request, n = number(input.number, 'pull request number')
    return { ...base, action: oneOf(input.action, ['opened', 'closed', 'reopened', 'synchronize', 'edited', 'ready_for_review', 'converted_to_draft', 'labeled', 'unlabeled'], 'action'),
      subject: { kind: type, number: n, title: text(pr?.title, 'title'), url: origin + '/pull/' + n,
        sha: sha(pr?.head?.sha), state: oneOf(pr?.state, ['open', 'closed'], 'state'), merged: pr?.merged === true },
      content: text(pr?.body ?? '', 'body', 65536) }
  }
  if (type === 'issue_comment') {
    const n = number(input.issue?.number, 'issue number')
    return { ...base, action: oneOf(input.action, ['created', 'edited', 'deleted'], 'action'),
      subject: { kind: input.issue?.pull_request ? 'pull_request' : 'issue', number: n, title: text(input.issue?.title, 'title'),
        url: origin + (input.issue?.pull_request ? '/pull/' : '/issues/') + n, commentId: number(input.comment?.id, 'comment id') },
      content: text(input.comment?.body, 'comment body', 65536) }
  }
  const check = input.check_run, n = number(check?.id, 'check run id')
  return { ...base, action: oneOf(input.action, ['created', 'completed', 'rerequested', 'requested_action'], 'action'),
    subject: { kind: 'check_run', number: n, title: text(check?.name, 'check name'), url: origin + '/runs/' + n,
      sha: sha(check?.head_sha), status: oneOf(check?.status, ['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'], 'check status'),
      conclusion: check?.conclusion == null ? null : oneOf(check.conclusion, ['action_required', 'cancelled', 'failure', 'neutral', 'success', 'skipped', 'stale', 'timed_out', 'startup_failure'], 'check conclusion') },
    content: text(check?.output?.summary ?? '', 'check summary', 65536) }
}

export class GitHubEvents {
  constructor(control) { this.control = control;this.runtime = control.runtime;this.s = this.runtime.s }
  async initialize() {
    await this.runtime.initialize()
    await this.runtime.transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mira-github/' + this.runtime.schema])
      const exists = async name => !!(await c.query('SELECT to_regclass($1) AS name', [this.runtime.schema + '.' + name])).rows[0].name
      if (await exists('github_meta')) {
        const meta = (await c.query(`SELECT * FROM ${this.s}.github_meta WHERE singleton`)).rows[0]
        if (meta?.component !== 'mira-github-events' || meta.version !== 1) fail('SCHEMA_VERSION', 'GitHub 扩展格式不兼容')
        for (const name of ['github_sources', 'github_deliveries']) if (!await exists(name)) fail('SCHEMA_INCOMPLETE', 'GitHub 扩展不完整')
        return
      }
      for (const name of ['github_sources', 'github_deliveries']) if (await exists(name)) fail('FOREIGN_SCHEMA', 'GitHub 表名被其他组件占用')
      await c.query(`CREATE TABLE ${this.s}.github_meta(singleton boolean PRIMARY KEY CHECK(singleton),component text NOT NULL,version integer NOT NULL);
        CREATE TABLE ${this.s}.github_sources(source_id text PRIMARY KEY,project_id text NOT NULL REFERENCES ${this.s}.projects,repository_id text NOT NULL,
          repository text NOT NULL,secret text NOT NULL,events text[] NOT NULL,active boolean NOT NULL DEFAULT true);
        CREATE TABLE ${this.s}.github_deliveries(source_id text NOT NULL REFERENCES ${this.s}.github_sources,delivery_id text NOT NULL,event_name text NOT NULL,
          body_hash text NOT NULL,result text NOT NULL,PRIMARY KEY(source_id,delivery_id));
        CREATE INDEX github_body_receipt ON ${this.s}.github_deliveries(source_id,event_name,body_hash);
        INSERT INTO ${this.s}.github_meta VALUES(true,'mira-github-events',1)`)
    })
  }
  /** Trusted owner API; never registered as an agent tool or a public route. */
  async provision({ projectId, repositoryId, repository, events = TYPES }) {
    if (!/^[1-9][0-9]{0,18}$/.test(String(repositoryId)) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')
      || repository.split('/').some(part => ['.', '..'].includes(part))
      || !Array.isArray(events) || !events.length || events.some(e => !TYPES.includes(e))) fail('INVALID_INPUT', 'GitHub 来源配置无效')
    const sourceId = 'gh_' + randomBytes(16).toString('hex'), secret = randomBytes(32).toString('hex')
    await this.runtime.transaction(async c => {
      await this.runtime.head(c, projectId)
      await c.query(`INSERT INTO ${this.s}.github_sources(source_id,project_id,repository_id,repository,secret,events) VALUES($1,$2,$3,$4,$5,$6)`,
        [sourceId, projectId, String(repositoryId), repository, secret, [...new Set(events)].sort()])
    })
    return { sourceId, secret, path: '/hooks/github/' + sourceId }
  }
  async revoke(sourceId) {
    const changed = await this.runtime.pool.query(`UPDATE ${this.s}.github_sources SET active=false WHERE source_id=$1`, [sourceId])
    if (!changed.rowCount) fail('NOT_FOUND', '没有此 GitHub 来源')
  }
  async receive(sourceId, headers, raw) {
    if (!Buffer.isBuffer(raw) || raw.length > MAX_BODY) fail('INVALID_INPUT', 'GitHub 请求超过 1 MB')
    const signature = /^sha256=([a-f0-9]{64})$/.exec(headers['x-hub-signature-256'] ?? '')?.[1]
    const deliveryId = headers['x-github-delivery'], eventName = headers['x-github-event']
    if (!signature) fail('FORBIDDEN', 'GitHub 签名无效')
    if (typeof deliveryId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(deliveryId)) fail('INVALID_INPUT', 'GitHub delivery id 无效')
    return this.runtime.transaction(async c => {
      const source = (await c.query(`SELECT * FROM ${this.s}.github_sources WHERE source_id=$1 FOR UPDATE`, [sourceId])).rows[0]
      if (!source?.active || !timingSafeEqual(Buffer.from(signature, 'hex'), createHmac('sha256', source.secret).update(raw).digest())) fail('FORBIDDEN', 'GitHub 签名无效或来源已撤销')
      if (eventName !== 'ping' && !source.events.includes(eventName)) fail('UNSUPPORTED', '未订阅此 GitHub 事件')
      const hash = createHash('sha256').update(raw).digest('hex')
      const prior = (await c.query(`SELECT * FROM ${this.s}.github_deliveries WHERE source_id=$1 AND delivery_id=$2`, [sourceId, deliveryId])).rows[0]
      if (prior) {
        if (prior.event_name !== eventName || prior.body_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'GitHub delivery id 的内容已改变')
        return { ...JSON.parse(prior.result), duplicate: true }
      }
      // A signature does not cover the delivery header. Replaying the same
      // signed body under another delivery id must not create another wake.
      const same = (await c.query(`SELECT result FROM ${this.s}.github_deliveries WHERE source_id=$1 AND event_name=$2 AND body_hash=$3 LIMIT 1`, [sourceId, eventName, hash])).rows[0]
      let result
      if (same) result = { ...JSON.parse(same.result), duplicate: true }
      else {
        let input
        try { input = JSON.parse(raw.toString('utf8')) } catch { fail('INVALID_INPUT', 'GitHub 请求须为 JSON') }
        const value = normalize(source, eventName, input)
        if (value === null) result = { accepted: true, ignored: true, eventSeq: null, duplicate: false }
        else {
        const head = await this.runtime.head(c, source.project_id)
        const event = { type: 'external.received', sourceId, deliveryId, trust: 'external', to: [COORDINATOR], ...value }
        const saved = await this.runtime.persist(c, source.project_id, head, [event], 'github:' + sourceId + ':' + deliveryId,
          { kind: 'github-v1', eventName, hash })
        await this.runtime.queue(c, source.project_id, COORDINATOR, saved.headSeq, 0, 'external')
        const store = await this.control.projection(c, source.project_id), wake = planMiraWake(store, store.get(source.project_id).events.at(-1))
        if (wake) await this.runtime.queue(c, source.project_id, MIRA, saved.headSeq, wake.delayMs, wake.reason)
        result = { accepted: true, eventSeq: saved.headSeq, duplicate: false }
        }
      }
      await c.query(`INSERT INTO ${this.s}.github_deliveries VALUES($1,$2,$3,$4,$5)`, [sourceId, deliveryId, eventName, hash, JSON.stringify(result)])
      return result
    })
  }
}

/** Run behind a trusted HTTPS proxy; HTTP defaults to loopback for the lab. */
export class GitHubIngress {
  constructor(events) { this.events = events }
  async handle(req, res) {
    try {
      const sourceId = /^\/hooks\/github\/(gh_[a-f0-9]{32})$/.exec(req.url)?.[1]
      if (!sourceId || req.method !== 'POST') fail('FORBIDDEN', '不支持的 webhook 路径或方法')
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('INVALID_INPUT', '只接受 application/json')
      const chunks = [];let size = 0
      for await (const chunk of req) { size += chunk.length;if (size > MAX_BODY) fail('INVALID_INPUT', 'GitHub 请求超过 1 MB');chunks.push(chunk) }
      const value = await this.events.receive(sourceId, req.headers, Buffer.concat(chunks))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });res.end(JSON.stringify(value))
    } catch (error) {
      req.resume();res.setHeader('connection', 'close')
      const known = error instanceof RuntimeError
      res.writeHead(known ? error.code === 'FORBIDDEN' ? 403 : error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400 : 503,
        { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: known ? error.message : 'GitHub 请求未提交，请重试', code: known ? error.code : 'UNAVAILABLE' }))
    }
  }
  async listen({ host = '127.0.0.1', port = 0 } = {}) {
    this.server = createServer((req, res) => this.handle(req, res));this.server.requestTimeout = 30000;this.server.headersTimeout = 5000
    await new Promise((resolve, reject) => { this.server.once('error', reject);this.server.listen(port, host, resolve) })
    return this.server.address()
  }
  async close() { if (this.server) { this.server.closeAllConnections();await new Promise(resolve => this.server.close(resolve)) } }
}
