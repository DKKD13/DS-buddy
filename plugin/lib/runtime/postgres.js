/**
 * PostgreSQL event log and durable inbox wake coordination.
 *
 * This is a trusted control-plane API, not a network endpoint for agents. A
 * SessionHost must authenticate callers, derive their role and validate domain
 * actions before passing events here. No database credentials belong in an
 * agent session. The current JSONL/DSH runtime is not switched by importing it.
 */
import { MIRA, OBSERVABLE } from '../store.js'
import { createHash } from 'node:crypto'

const MAX_SEQ = Number.MAX_SAFE_INTEGER
const CONTENT = 'mira-projects-runtime'
export const POSTGRES_SCHEMA_VERSION = 3
const TABLES = ['meta', 'projects', 'events', 'commands', 'wake_targets', 'lease_receipts']

export class RuntimeError extends Error {
  constructor(code, message) { super(message);this.name = 'RuntimeError';this.code = code }
}
const fail = (code, message) => { throw new RuntimeError(code, message) }
function integer(value, name, min = 0, max = MAX_SEQ) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT', `${name} 超出范围`)
  return value
}
function text(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value) || !value.isWellFormed()) fail('INVALID_INPUT', `${name} 无效`)
  return value
}
function labels(value = []) {
  if (!Array.isArray(value) || value.length > 128) fail('INVALID_INPUT', 'labels 无效')
  return [...new Set(value.map(item => text(item, 'label', 128)))].sort()
}
function sequence(value) { return integer(Number(value), '数据库序号') }
function leaseIdentity(lease) {
  if (!lease || typeof lease !== 'object') fail('INVALID_INPUT', '缺少租约')
  text(lease.projectId, 'projectId', 160);text(lease.key, 'key', 160);text(lease.owner, 'owner', 200)
  if (typeof lease.fence !== 'string' || !/^[1-9]\d{0,18}$/.test(lease.fence)) fail('INVALID_INPUT', 'fence 无效')
  if (lease.executionId !== undefined) text(lease.executionId, 'executionId', 160)
  return lease
}
export function inputBatch(events, wakes = []) {
  if (!Array.isArray(events) || !events.length || events.length > 128) fail('INVALID_INPUT', '每批需要 1–128 个事件')
  let clean
  try { clean = JSON.parse(JSON.stringify(events)) } catch { fail('INVALID_INPUT', '事件须可序列化为 JSON') }
  for (const [index, event] of clean.entries()) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail('INVALID_INPUT', '事件须为对象')
    text(event.type, '事件类型', 128)
    if (['seq', 'at', 'projectId'].some(key => Object.hasOwn(event, key)) || event.type === 'inbox.acked') fail('INVALID_INPUT', '事件使用了运行时保留字段或类型')
    if (event.to !== undefined) {
      if (!Array.isArray(event.to) || event.to.length > 128) fail('INVALID_INPUT', 'to 须为收件人数组')
      event.to = [...new Set(event.to.map(key => text(key, '收件人', 160)))]
    }
    if (event.type === 'project.created' && (index !== 0 || !Array.isArray(event.members) || !event.members.length || typeof event.name !== 'string' || !event.name.trim())) fail('INVALID_INPUT', '项目创建事件无效')
    if (event.type === 'runtime.target.configured') { text(event.key, 'key', 160);event.requiredLabels = labels(event.requiredLabels) }
  }
  if (Buffer.byteLength(JSON.stringify(clean)) > 2 * 1024 * 1024) fail('INVALID_INPUT', '事件批次超过 2 MB')
  if (!Array.isArray(wakes) || wakes.length > 128) fail('INVALID_INPUT', 'wakes 无效')
  const targets = new Map()
  for (const wake of wakes) {
    if (!wake || typeof wake !== 'object' || Array.isArray(wake)) fail('INVALID_INPUT', 'wake 须为对象')
    const key = text(wake.key, 'key', 160), delayMs = integer(wake.delayMs ?? 0, 'delayMs', 0, 86400000)
    const reason = text(wake.reason ?? 'event', 'reason', 160), old = targets.get(key)
    if (!old || delayMs < old.delayMs) targets.set(key, { key, delayMs, reason })
  }
  return { events: clean, wakes: [...targets.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) }
}
// Canonical JSON hashes ignore object key order without round-tripping through
// JSONB, which cannot represent NUL or lone-surrogate strings accepted by JSONL.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
function completion(turn) {
  if (turn === undefined) return null
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) fail('INVALID_INPUT', 'turn 无效')
  const value = { sessionId: text(turn.sessionId, 'sessionId', 200) }
  for (const flag of ['silent', 'nudged', 'unanswered']) {
    if (turn[flag] !== undefined && typeof turn[flag] !== 'boolean') fail('INVALID_INPUT', `${flag} 无效`)
    if (turn[flag] !== undefined) value[flag] = turn[flag]
  }
  return value
}

export class PostgresRuntime {
  /** Accept a node-postgres compatible Pool; the caller owns its lifecycle. */
  constructor(pool, { schema = 'mira_runtime' } = {}) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema === 'public' || schema === 'information_schema' || schema.startsWith('pg_')) fail('INVALID_INPUT', 'schema 必须是独立的安全名称')
    if (typeof pool?.connect !== 'function' || typeof pool?.query !== 'function') fail('INVALID_INPUT', '需要 PostgreSQL pool')
    this.pool = pool;this.schema = schema;this.s = `"${schema}"`
  }

  async transaction(run) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* retain the original failure, including a lost COMMIT response */ }
      throw error
    } finally { client.release() }
  }

  async initialize() {
    const s = this.s
    await this.transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['mira-runtime/schema/' + this.schema])
      const existing = (await c.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [this.schema])).rowCount > 0
      if (existing) {
        const meta = (await c.query('SELECT to_regclass($1) AS name', [this.schema + '.meta'])).rows[0].name
        if (!meta) fail('FOREIGN_SCHEMA', '该 schema 不属于 Mira 运行时，保持原样')
        const row = (await c.query(`SELECT component, version FROM ${s}.meta WHERE singleton=true`)).rows[0]
        if (row?.component !== CONTENT) fail('FOREIGN_SCHEMA', '该 schema 不属于 Mira 运行时，保持原样')
        if (row.version !== POSTGRES_SCHEMA_VERSION) fail('SCHEMA_VERSION', '不支持的运行时 schema 版本')
        for (const name of TABLES) if (!(await c.query('SELECT to_regclass($1) AS name', [this.schema + '.' + name])).rows[0].name) fail('SCHEMA_INCOMPLETE', '运行时 schema 不完整，不能静默重建数据表')
        return
      }
      await c.query(`CREATE SCHEMA ${s}`)
      await c.query(`
        CREATE TABLE ${s}.meta (singleton boolean PRIMARY KEY CHECK(singleton), component text NOT NULL, version integer NOT NULL);
        CREATE TABLE ${s}.projects (project_id text PRIMARY KEY, head_seq bigint NOT NULL DEFAULT 0 CHECK(head_seq BETWEEN 0 AND ${MAX_SEQ}));
        CREATE TABLE ${s}.events (project_id text NOT NULL REFERENCES ${s}.projects, seq bigint NOT NULL CHECK(seq BETWEEN 1 AND ${MAX_SEQ}), data text NOT NULL, event_type text NOT NULL, recipients text[] NOT NULL, from_mira boolean NOT NULL, PRIMARY KEY(project_id, seq));
        CREATE TABLE ${s}.commands (project_id text NOT NULL REFERENCES ${s}.projects, request_id text NOT NULL, fingerprint text NOT NULL, result text NOT NULL, PRIMARY KEY(project_id, request_id));
        CREATE TABLE ${s}.wake_targets (
          project_id text NOT NULL REFERENCES ${s}.projects, key text NOT NULL,
          requested_through bigint NOT NULL DEFAULT 0, announced_through bigint NOT NULL DEFAULT 0, cursor bigint NOT NULL DEFAULT 0,
          due_at timestamptz NOT NULL DEFAULT clock_timestamp(), reason text NOT NULL DEFAULT 'event', required_labels text[] NOT NULL DEFAULT '{}',
          fence bigint NOT NULL DEFAULT 0, lease_owner text, lease_until timestamptz, claimed_through bigint, read_through bigint,
          execution_hold text,
          PRIMARY KEY(project_id,key),
          CHECK(requested_through BETWEEN 0 AND ${MAX_SEQ}), CHECK(announced_through BETWEEN 0 AND ${MAX_SEQ}), CHECK(cursor BETWEEN 0 AND ${MAX_SEQ}),
          CHECK((lease_owner IS NULL)=(lease_until IS NULL) AND (lease_owner IS NULL)=(claimed_through IS NULL) AND (lease_owner IS NULL)=(read_through IS NULL)),
          CHECK(read_through IS NULL OR read_through>=cursor)
        );
        CREATE INDEX wake_ready ON ${s}.wake_targets(due_at, project_id, key);
        CREATE TABLE ${s}.lease_receipts (
          project_id text NOT NULL, key text NOT NULL, fence bigint NOT NULL, owner text NOT NULL,
          kind text NOT NULL CHECK(kind IN ('finish','retry')), fingerprint text NOT NULL, result text NOT NULL,
          completed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(project_id,key,fence),
          FOREIGN KEY(project_id,key) REFERENCES ${s}.wake_targets
        )`)
      await c.query(`INSERT INTO ${s}.meta VALUES(true,$1,$2)`, [CONTENT, POSTGRES_SCHEMA_VERSION])
    })
  }

  /** Optional device extension is checked from DB, including after reconstruction.
   * Request rows are read without row locks while the target is locked: a
   * result transaction may itself be waiting for this project/target. */
  async deviceExtension(c) {
    const found=(await c.query('SELECT to_regclass($1) AS meta,to_regclass($2) AS requests',[this.schema+'.device_meta',this.schema+'.device_requests'])).rows[0]
    if (!found.meta && !found.requests) return false
    if (!found.meta || !found.requests) fail('SCHEMA_INCOMPLETE','设备扩展停止记录不完整')
    const meta=(await c.query(`SELECT component,version FROM ${this.s}.device_meta WHERE singleton`)).rows[0]
    if (meta?.component!=='mira-device-broker'||meta.version!==1) fail('SCHEMA_VERSION','设备执行扩展不兼容')
    return true
  }
  async deviceAvailable(c) {
    return await this.deviceExtension(c) ? `NOT EXISTS(SELECT 1 FROM ${this.s}.device_requests d WHERE d.project_id=w.project_id AND d.key=w.key AND NOT d.stopped)` : 'true'
  }
  async assertDeviceStopped(c,projectId,key) {
    if (await this.deviceExtension(c) && (await c.query(`SELECT 1 FROM ${this.s}.device_requests WHERE project_id=$1 AND key=$2 AND NOT stopped LIMIT 1`,[projectId,key])).rowCount) fail('EXECUTION_HELD','设备操作停止确认前不能确认、重投或改变放置')
  }

  async head(c, projectId, create = false) {
    if (create) await c.query(`INSERT INTO ${this.s}.projects(project_id) VALUES($1) ON CONFLICT DO NOTHING`, [projectId])
    const row = (await c.query(`SELECT head_seq FROM ${this.s}.projects WHERE project_id=$1 FOR UPDATE`, [projectId])).rows[0]
    if (!row) fail('PROJECT_NOT_FOUND', '没有这个项目')
    return sequence(row.head_seq)
  }

  async command(c, projectId, requestId, fingerprint) {
    const row = (await c.query(`SELECT result, fingerprint=$3 AS same FROM ${this.s}.commands WHERE project_id=$1 AND request_id=$2`, [projectId, requestId, digest(fingerprint)])).rows[0]
    if (!row) return null
    if (!row.same) fail('IDEMPOTENCY_CONFLICT', '同一 requestId 的内容不同')
    return { ...JSON.parse(row.result), replayed: true }
  }

  async persist(c, projectId, head, events, requestId, fingerprint, extra = {}) {
    integer(head + events.length, '新 head')
    const at = sequence((await c.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS at')).rows[0].at)
    const committed = events.map((event, index) => ({ ...event, projectId, seq: head + index + 1, at }))
    for (const event of committed) await c.query(`INSERT INTO ${this.s}.events(project_id,seq,data,event_type,recipients,from_mira) VALUES($1,$2,$3,$4,$5::text[],$6)`, [projectId, event.seq, JSON.stringify(event), event.type, event.to ?? [], event.type === 'message.posted' && event.author?.id === MIRA])
    const result = { ...extra, events: committed, headSeq: head + committed.length, replayed: false }
    await c.query(`UPDATE ${this.s}.projects SET head_seq=$2 WHERE project_id=$1`, [projectId, result.headSeq])
    await c.query(`INSERT INTO ${this.s}.commands(project_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4)`, [projectId, requestId, digest(fingerprint), JSON.stringify(result)])
    return result
  }

  async active(c, row) {
    return row?.lease_owner != null && (await c.query('SELECT $1::timestamptz>clock_timestamp() AS active', [row.lease_until])).rows[0].active
  }

  async lockTarget(c, projectId, key) {
    return (await c.query(`SELECT * FROM ${this.s}.wake_targets WHERE project_id=$1 AND key=$2 FOR UPDATE`, [projectId, key])).rows[0]
  }

  async lockLease(c, lease) {
    const row = await this.lockTarget(c, lease.projectId, lease.key)
    if (!row || row.lease_owner !== lease.owner || String(row.fence) !== lease.fence || !await this.active(c, row)) fail('STALE_LEASE', '租约已失效，旧执行者不能继续读写或确认')
    if (row.execution_hold && row.execution_hold !== lease.executionId) fail('EXECUTION_HELD', '目标由另一执行实例占用')
    return row
  }

  async queue(c, projectId, key, throughSeq, delayMs, reason) {
    await c.query(`INSERT INTO ${this.s}.wake_targets AS w(project_id,key,requested_through,due_at,reason)
      VALUES($1,$2,$3,clock_timestamp()+($4::double precision*interval '1 millisecond'),$5)
      ON CONFLICT(project_id,key) DO UPDATE SET
        due_at=CASE WHEN excluded.requested_through<=w.requested_through THEN w.due_at
          WHEN (w.lease_owner IS NOT NULL AND w.lease_until>clock_timestamp() AND w.requested_through<=w.claimed_through)
            OR w.requested_through<=GREATEST(w.cursor,w.announced_through) THEN excluded.due_at
          ELSE LEAST(w.due_at,excluded.due_at) END,
        reason=CASE WHEN excluded.requested_through>w.requested_through THEN excluded.reason ELSE w.reason END,
        requested_through=GREATEST(w.requested_through,excluded.requested_through)`, [projectId, key, throughSeq, delayMs, reason])
  }

  async append(projectId, events, { requestId, expectedSeq, wakes = [], lease } = {}) {
    text(projectId, 'projectId', 160);text(requestId, 'requestId')
    if (requestId.startsWith('sys:')) fail('INVALID_INPUT', 'requestId 使用了保留前缀')
    integer(expectedSeq, 'expectedSeq')
    const input = inputBatch(events, wakes), fingerprint = { kind: 'append', ...input }
    if (lease) {
      leaseIdentity(lease)
      if (lease.projectId !== projectId) fail('INVALID_SCOPE', '租约属于另一个项目')
      if (input.events.some(event => event.type === 'runtime.target.configured' || event.type === 'project.created')) fail('INVALID_SCOPE', '执行者租约不能创建项目或改变放置策略')
    }
    return this.transaction(async c => {
      const head = await this.head(c, projectId, input.events[0].type === 'project.created')
      if (lease) await this.lockLease(c, lease)
      const replay = await this.command(c, projectId, requestId, fingerprint)
      if (replay) return replay
      if (head !== expectedSeq) fail('HEAD_CONFLICT', '项目事件已变化，请重新读取后再提交')
      if ((head === 0) !== (input.events[0].type === 'project.created')) fail('INVALID_INPUT', '项目须先创建且不能重新创建')
      const result = await this.persist(c, projectId, head, input.events, requestId, fingerprint)
      for (const event of input.events.filter(event => event.type === 'runtime.target.configured')) {
        await c.query(`INSERT INTO ${this.s}.wake_targets(project_id,key) VALUES($1,$2) ON CONFLICT DO NOTHING`, [projectId, event.key])
        const row = await this.lockTarget(c, projectId, event.key)
        if (row.execution_hold) fail('EXECUTION_HELD', '必须确认执行节点已停止后才能改变放置策略')
        await this.assertDeviceStopped(c,projectId,event.key)
        if (await this.active(c, row)) fail('LEASE_BUSY', '目标仍在执行，停止确认后才能改变放置策略')
        await c.query(`UPDATE ${this.s}.wake_targets SET required_labels=$3::text[],fence=fence+1,lease_owner=NULL,lease_until=NULL,claimed_through=NULL,read_through=NULL WHERE project_id=$1 AND key=$2`, [projectId, event.key, event.requiredLabels])
      }
      for (const wake of input.wakes) await this.queue(c, projectId, wake.key, result.headSeq, wake.delayMs, wake.reason)
      return result
    })
  }

  async read(projectId, { after = 0, limit = 1000, through = MAX_SEQ } = {}) {
    text(projectId, 'projectId', 160);integer(after, 'after');integer(through, 'through');integer(limit, 'limit', 1, 10000)
    const result = await this.pool.query(`SELECT p.head_seq,e.data FROM ${this.s}.projects p
      LEFT JOIN LATERAL (SELECT seq,data FROM ${this.s}.events WHERE project_id=p.project_id AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT $4) e ON true
      WHERE p.project_id=$1 ORDER BY e.seq`, [projectId, after, through, limit])
    if (!result.rowCount) fail('PROJECT_NOT_FOUND', '没有这个项目')
    const headSeq = sequence(result.rows[0].head_seq), throughSeq = Math.min(headSeq, through)
    const events = result.rows.filter(row => row.data).map(row => JSON.parse(row.data))
    const readThrough = events.at(-1)?.seq ?? Math.min(after, throughSeq)
    return { headSeq, throughSeq, readThrough, hasMore: readThrough < throughSeq, events }
  }

  async enqueue(projectId, key, { throughSeq, delayMs = 0, reason = 'event' } = {}) {
    text(projectId, 'projectId', 160);text(key, 'key', 160);integer(throughSeq, 'throughSeq', 1);integer(delayMs, 'delayMs', 0, 86400000);text(reason, 'reason', 160)
    return this.transaction(async c => {
      const head = await this.head(c, projectId)
      if (throughSeq > head) fail('INVALID_INPUT', '唤醒不能越过项目当前 head')
      await this.queue(c, projectId, key, throughSeq, delayMs, reason)
      return { queued: true }
    })
  }

  lease(row) {
    return { projectId: row.project_id, key: row.key, owner: row.lease_owner, fence: String(row.fence), throughSeq: sequence(row.claimed_through), cursor: sequence(row.cursor), leaseUntil: new Date(row.lease_until).toISOString(), reason: row.reason,
      ...(row.execution_hold ? { executionId: row.execution_hold } : {}) }
  }

  async claim(options = {}) { return this.transaction(c => this.claimLocked(c, options)) }

  async claimLocked(c, { owner, labels: capabilities = [], leaseMs = 30000, projectId = null, key = null } = {}) {
    text(owner, 'owner', 200);const available = labels(capabilities);integer(leaseMs, 'leaseMs', 50, 600000)
    if (projectId !== null) text(projectId, 'projectId', 160)
    if (key !== null) { text(key, 'key', 160);if (projectId === null) fail('INVALID_INPUT', '按 key 认领时需要 projectId') }
      const deviceAvailable = await this.deviceAvailable(c)
      const row = (await c.query(`WITH candidate AS (
        SELECT w.project_id,w.key FROM ${this.s}.wake_targets w
        WHERE requested_through>GREATEST(cursor,announced_through) AND due_at<=clock_timestamp()
          AND execution_hold IS NULL AND ${deviceAvailable} AND (lease_owner IS NULL OR lease_until<=clock_timestamp()) AND required_labels<@$3::text[]
          AND ($4::text IS NULL OR project_id=$4) AND ($5::text IS NULL OR key=$5)
        ORDER BY due_at,project_id,key FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE ${this.s}.wake_targets w SET lease_owner=$1,fence=w.fence+1,
        lease_until=clock_timestamp()+($2::double precision*interval '1 millisecond'),claimed_through=w.requested_through,read_through=w.cursor
      FROM candidate c WHERE w.project_id=c.project_id AND w.key=c.key RETURNING w.*`, [owner, leaseMs, available, projectId, key])).rows[0]
      return row ? this.lease(row) : null
  }

  async heartbeat(lease, { leaseMs = 30000 } = {}) {
    leaseIdentity(lease);integer(leaseMs, 'leaseMs', 50, 600000)
    return this.transaction(async c => {
      await this.lockLease(c, lease)
      const row = (await c.query(`UPDATE ${this.s}.wake_targets SET lease_until=clock_timestamp()+($3::double precision*interval '1 millisecond') WHERE project_id=$1 AND key=$2 RETURNING *`, [lease.projectId, lease.key, leaseMs])).rows[0]
      return this.lease(row)
    })
  }

  async readInbox(lease, { limit = 30, peek = false } = {}) {
    return this.transaction(c => this.readInboxLocked(c, lease, { limit, peek }))
  }

  /** Internal transaction seam for control-plane authorization before reading. */
  async readInboxLocked(c, lease, { limit = 30, peek = false } = {}) {
    leaseIdentity(lease);integer(limit, 'limit', 1, 50)
    if (typeof peek !== 'boolean') fail('INVALID_INPUT', 'peek 须为布尔值')
    const row = await this.lockLease(c, lease), after = Math.max(sequence(row.cursor), sequence(row.read_through))
    const events = (await c.query(`SELECT data FROM ${this.s}.events WHERE project_id=$1 AND seq>$2 AND
      CASE WHEN $3=$4 THEN (event_type=ANY($5::text[]) AND NOT from_mira)
        ELSE $3=ANY(recipients) END ORDER BY seq LIMIT $6`, [lease.projectId, after, lease.key, MIRA, [...OBSERVABLE], limit])).rows.map(row => JSON.parse(row.data))
    if (!peek && events.length) await c.query(`UPDATE ${this.s}.wake_targets SET read_through=$3 WHERE project_id=$1 AND key=$2`, [lease.projectId, lease.key, events.at(-1).seq])
    return { events, cursor: sequence(row.cursor), readThrough: !peek && events.length ? events.at(-1).seq : sequence(row.read_through) }
  }

  async receipt(c, lease, fingerprint) {
    const row = (await c.query(`SELECT owner,kind,result,fingerprint=$4 AS same FROM ${this.s}.lease_receipts WHERE project_id=$1 AND key=$2 AND fence=$3`, [lease.projectId, lease.key, lease.fence, digest(fingerprint)])).rows[0]
    if (!row) return null
    if (row.owner !== lease.owner || !row.same) fail('IDEMPOTENCY_CONFLICT', '同一租约已有不同的完成回执')
    return { ...JSON.parse(row.result), replayed: true }
  }

  async saveReceipt(c, lease, fingerprint, result) {
    await c.query(`INSERT INTO ${this.s}.lease_receipts(project_id,key,fence,owner,kind,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6,$7)`, [lease.projectId, lease.key, lease.fence, lease.owner, fingerprint.kind, digest(fingerprint), JSON.stringify(result)])
  }

  async finish(lease, { turn } = {}) {
    return this.transaction(c => this.finishLocked(c, lease, { turn }))
  }

  async finishLocked(c, lease, { turn } = {}) {
    leaseIdentity(lease);const ended = completion(turn), fingerprint = { kind: 'finish', turn: ended }
      const head = await this.head(c, lease.projectId)
      const replay = await this.receipt(c, lease, fingerprint)
      if (replay) return replay
      const row = await this.lockLease(c, lease), cursor = sequence(row.read_through), events = []
      if (row.execution_hold) fail('EXECUTION_HELD', '执行实例停止确认前不能确认收件箱')
      await this.assertDeviceStopped(c,lease.projectId,lease.key)
      if (cursor > sequence(row.cursor)) events.push({ type: 'inbox.acked', key: lease.key, cursor })
      if (ended) events.push({ type: 'turn.ended', key: lease.key, ...ended })
      const saved = events.length ? await this.persist(c, lease.projectId, head, events, `sys:finish:${lease.key}:${lease.fence}`, fingerprint) : { headSeq: head }
      await c.query(`UPDATE ${this.s}.wake_targets SET cursor=$3,announced_through=GREATEST(announced_through,claimed_through),
        due_at=GREATEST(due_at,clock_timestamp()),lease_owner=NULL,lease_until=NULL,claimed_through=NULL,read_through=NULL WHERE project_id=$1 AND key=$2`, [lease.projectId, lease.key, cursor])
      const result = { cursor, headSeq: saved.headSeq, ackSeq: events[0]?.type === 'inbox.acked' ? head + 1 : null, replayed: false }
      await this.saveReceipt(c, lease, fingerprint, result)
      return result
  }

  async retry(lease, { delayMs = 0 } = {}) {
    leaseIdentity(lease);integer(delayMs, 'delayMs', 0, 86400000)
    const fingerprint = { kind: 'retry', delayMs }
    return this.transaction(async c => {
      const replay = await this.receipt(c, lease, fingerprint)
      if (replay) return replay
      await this.lockLease(c, lease)
      await this.assertDeviceStopped(c,lease.projectId,lease.key)
      await c.query(`UPDATE ${this.s}.wake_targets SET due_at=clock_timestamp()+($3::double precision*interval '1 millisecond'),lease_owner=NULL,lease_until=NULL,claimed_through=NULL,read_through=NULL WHERE project_id=$1 AND key=$2`, [lease.projectId, lease.key, delayMs])
      const result = { released: true, replayed: false }
      await this.saveReceipt(c, lease, fingerprint, result)
      return result
    })
  }

  async recover(projectId, key) {
    text(projectId, 'projectId', 160);text(key, 'key', 160)
    return this.transaction(async c => {
      const row = await this.lockTarget(c, projectId, key)
      if (!row) return { requeued: false }
      if (row.execution_hold) fail('EXECUTION_HELD', '执行实例停止确认前不能恢复投递')
      await this.assertDeviceStopped(c,projectId,key)
      if (await this.active(c, row)) fail('LEASE_BUSY', '目标仍在执行，不能同时恢复')
      await c.query(`UPDATE ${this.s}.wake_targets SET announced_through=cursor,due_at=clock_timestamp(),fence=fence+1,lease_owner=NULL,lease_until=NULL,claimed_through=NULL,read_through=NULL WHERE project_id=$1 AND key=$2`, [projectId, key])
      return { requeued: sequence(row.requested_through) > sequence(row.cursor) }
    })
  }

  async inspectWake(projectId, key) {
    text(projectId, 'projectId', 160);text(key, 'key', 160)
    const row = (await this.pool.query(`SELECT *,lease_until>clock_timestamp() AS active FROM ${this.s}.wake_targets WHERE project_id=$1 AND key=$2`, [projectId, key])).rows[0]
    if (!row) return null
    return { projectId, key, cursor: sequence(row.cursor), requestedThrough: sequence(row.requested_through), announcedThrough: sequence(row.announced_through), fence: String(row.fence), owner: row.lease_owner, active: row.active === true, readThrough: row.read_through == null ? null : sequence(row.read_through), requiredLabels: row.required_labels, executionHold: row.execution_hold, dueAt: new Date(row.due_at).toISOString() }
  }
}
