/** Durable owner-provisioned execution nodes. No model receives node credentials. */
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { RuntimeError } from './postgres.js'

const fail = (code, message) => { throw new RuntimeError(code, message) }
const digest = value => createHash('sha256').update(value).digest('hex')
function id(value, label = 'id') {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f]/.test(value) || !value.isWellFormed()) fail('INVALID_INPUT', label + ' 无效')
  return value
}
function list(value, label) {
  if (!Array.isArray(value) || value.length > 128) fail('INVALID_INPUT', label + ' 无效')
  return [...new Set(value.map(v => id(v, label)))].sort()
}
const token = () => randomBytes(32).toString('base64url')
const nodeOwner = (node, epoch) => `node:${node}:${epoch}`

export class ExecutionNodes {
  constructor(control, { connectionMs = 30000, leaseMs = 30000 } = {}) {
    if (!Number.isSafeInteger(connectionMs) || connectionMs < 50 || connectionMs > 600000 || !Number.isSafeInteger(leaseMs) || leaseMs < 50 || leaseMs > 600000) fail('INVALID_INPUT', '节点期限无效')
    this.control = control;this.runtime = control.runtime;this.s = this.runtime.s
    this.connectionMs = connectionMs;this.leaseMs = leaseMs
  }

  async initialize() {
    await this.runtime.initialize()
    await this.runtime.transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mira-nodes/' + this.runtime.schema])
      const existing = (await c.query('SELECT to_regclass($1) AS name', [this.runtime.schema + '.node_meta'])).rows[0].name
      if (existing) {
        const row = (await c.query(`SELECT component,version FROM ${this.s}.node_meta WHERE singleton`)).rows[0]
        if (row?.component !== 'mira-execution-nodes' || row.version !== 1) fail('SCHEMA_VERSION', '节点扩展格式不兼容')
        for (const name of ['nodes', 'node_events', 'node_commands', 'node_runs', 'node_locations']) if (!(await c.query('SELECT to_regclass($1) AS name', [this.runtime.schema + '.' + name])).rows[0].name) fail('SCHEMA_INCOMPLETE', '节点扩展不完整')
        return
      }
      for (const name of ['nodes', 'node_events', 'node_commands', 'node_runs', 'node_locations']) if ((await c.query('SELECT to_regclass($1) AS name', [this.runtime.schema + '.' + name])).rows[0].name) fail('FOREIGN_SCHEMA', '节点表名已被其他组件占用')
      await c.query(`CREATE TABLE ${this.s}.node_meta(singleton boolean PRIMARY KEY CHECK(singleton),component text NOT NULL,version integer NOT NULL);
        CREATE TABLE ${this.s}.nodes(node_id text PRIMARY KEY,name text NOT NULL,token_hash text UNIQUE NOT NULL,status text NOT NULL CHECK(status IN('active','revoked')),
          labels text[] NOT NULL,projects text[] NOT NULL,roles text[] NOT NULL,epoch bigint NOT NULL DEFAULT 0,instance_id text,connected_until timestamptz);
        CREATE TABLE ${this.s}.node_events(seq bigserial PRIMARY KEY,node_id text NOT NULL REFERENCES ${this.s}.nodes,data text NOT NULL);
        CREATE TABLE ${this.s}.node_commands(node_id text NOT NULL REFERENCES ${this.s}.nodes,epoch bigint NOT NULL,request_id text NOT NULL,fingerprint text NOT NULL,result text NOT NULL,PRIMARY KEY(node_id,epoch,request_id));
        CREATE TABLE ${this.s}.node_locations(project_id text NOT NULL,key text NOT NULL,node_id text NOT NULL REFERENCES ${this.s}.nodes,PRIMARY KEY(project_id,key),FOREIGN KEY(project_id,key) REFERENCES ${this.s}.wake_targets);
        CREATE TABLE ${this.s}.node_runs(run_id text PRIMARY KEY,node_id text NOT NULL REFERENCES ${this.s}.nodes,epoch bigint NOT NULL,project_id text NOT NULL,key text NOT NULL,
          fence bigint NOT NULL,lease_owner text NOT NULL,session_id text NOT NULL,job_hash text UNIQUE NOT NULL,job_token text NOT NULL,resume boolean NOT NULL,bound boolean NOT NULL DEFAULT false,
          state text NOT NULL CHECK(state IN('assigned','running','complete','failed')),container_id text,turn text,receipt text,model_calls integer NOT NULL DEFAULT 0,
          FOREIGN KEY(project_id,key) REFERENCES ${this.s}.wake_targets);
        CREATE UNIQUE INDEX node_live_target ON ${this.s}.node_runs(project_id,key) WHERE state IN('assigned','running');
        INSERT INTO ${this.s}.node_meta VALUES(true,'mira-execution-nodes',1)`)
    })
  }

  async event(c, nodeId, value) {
    await c.query(`INSERT INTO ${this.s}.node_events(node_id,data) VALUES($1,$2)`, [nodeId, JSON.stringify({ at: Date.now(), ...value })])
  }

  /** Trusted owner operation; there is no node-facing provision endpoint. */
  async provision({ name, labels = [], projects = [], roles = ['coordinator', 'mira', 'worker'] }) {
    id(name, 'name');const capabilities = list(labels, 'labels'), allowed = list(projects, 'projects')
    if (capabilities.some(label => label.startsWith('node:'))) fail('INVALID_INPUT', 'node: 标签由控制面分配')
    const allowedRoles = list(roles, 'roles')
    if (allowedRoles.some(role => !['coordinator', 'mira', 'worker'].includes(role))) fail('INVALID_INPUT', '节点角色授权无效')
    const nodeId = 'n_' + randomUUID().replaceAll('-', ''), credential = token()
    await this.runtime.transaction(async c => {
      await c.query(`INSERT INTO ${this.s}.nodes(node_id,name,token_hash,status,labels,projects,roles) VALUES($1,$2,$3,'active',$4,$5,$6)`, [nodeId, name, digest(credential), capabilities, allowed, allowedRoles])
      await this.event(c, nodeId, { type: 'node.provisioned', name, labels: capabilities, projects: allowed, roles: allowedRoles, by: 'owner' })
    })
    return { nodeId, credential }
  }

  async auth(c, credential, { epoch, live = false, allowRevoked = false } = {}) {
    if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)) fail('FORBIDDEN', '节点身份无效')
    const node = (await c.query(`SELECT *,connected_until>clock_timestamp() AS connected FROM ${this.s}.nodes WHERE token_hash=$1 FOR UPDATE`, [digest(credential)])).rows[0]
    if (!node || (!allowRevoked && node.status !== 'active')) fail('FORBIDDEN', '节点身份无效或已撤销')
    if (live && (!node.connected || String(node.epoch) !== epoch)) fail('NODE_OFFLINE', '节点连接代际已失效，请先停止旧执行实例再重连')
    return node
  }

  async connect(credential, { instanceId }) {
    id(instanceId, 'instanceId')
    return this.runtime.transaction(async c => {
      const node = await this.auth(c, credential)
      const same = node.connected && node.instance_id === instanceId
      if (node.connected && !same) fail('NODE_BUSY', '同一节点仍有活跃监督进程')
      if (!same && (await c.query(`SELECT 1 FROM ${this.s}.node_runs WHERE node_id=$1 AND state IN('assigned','running') LIMIT 1`, [node.node_id])).rowCount) fail('RECOVERY_REQUIRED', '先报告旧执行实例已停止，才能建立新节点连接')
      const row = (await c.query(`UPDATE ${this.s}.nodes SET instance_id=$2,epoch=epoch+$3,connected_until=clock_timestamp()+($4::double precision*interval '1 millisecond') WHERE node_id=$1 RETURNING *`, [node.node_id, instanceId, same ? 0 : 1, this.connectionMs])).rows[0]
      if (!same) await this.event(c, node.node_id, { type: 'node.connected', epoch: String(row.epoch), instanceId })
      return { nodeId: node.node_id, epoch: String(row.epoch), labels: [...node.labels, 'node:' + node.node_id], projects: node.projects,
        roles: node.roles, schema: this.runtime.schema, connectionMs: this.connectionMs, leaseMs: this.leaseMs }
    })
  }

  lease(run) { return { projectId: run.project_id, key: run.key, owner: run.lease_owner, fence: String(run.fence), executionId: run.run_id } }

  async heartbeat(credential, { epoch }) {
    return this.runtime.transaction(async c => {
      const node = await this.auth(c, credential, { epoch, live: true }), lostRuns = []
      await c.query(`UPDATE ${this.s}.nodes SET connected_until=clock_timestamp()+($2::double precision*interval '1 millisecond') WHERE node_id=$1`, [node.node_id, this.connectionMs])
      const runs = (await c.query(`SELECT * FROM ${this.s}.node_runs WHERE node_id=$1 AND epoch=$2 AND state IN('assigned','running') ORDER BY project_id,key`, [node.node_id, epoch])).rows
      for (const run of runs) {
        const row = await this.runtime.lockTarget(c, run.project_id, run.key)
        if (row?.execution_hold !== run.run_id || row.lease_owner !== run.lease_owner || String(row.fence) !== String(run.fence) || !await this.runtime.active(c, row)) { lostRuns.push(run.run_id);continue }
        await c.query(`UPDATE ${this.s}.wake_targets SET lease_until=clock_timestamp()+($3::double precision*interval '1 millisecond') WHERE project_id=$1 AND key=$2`, [run.project_id, run.key, this.leaseMs])
      }
      return { connected: true, lostRuns }
    })
  }

  async claim(credential, { epoch, projectId, requestId }) {
    id(projectId, 'projectId');id(requestId, 'requestId')
    const ticket = await this.runtime.transaction(async c => {
      const node = await this.auth(c, credential, { epoch, live: true })
      if (!node.projects.includes(projectId)) fail('FORBIDDEN', '此节点未获本项目执行授权')
      const fingerprint = digest(JSON.stringify({ op: 'claim', projectId }))
      const receipt = (await c.query(`SELECT * FROM ${this.s}.node_commands WHERE node_id=$1 AND epoch=$2 AND request_id=$3`, [node.node_id, epoch, requestId])).rows[0]
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '同一节点请求的内容不同')
        return JSON.parse(receipt.result)
      }
      await this.runtime.head(c, projectId)
      const available = [...node.labels, 'node:' + node.node_id]
      const deviceAvailable = await this.runtime.deviceAvailable(c)
      const candidate = (await c.query(`SELECT w.key FROM ${this.s}.wake_targets w LEFT JOIN ${this.s}.node_locations l ON l.project_id=w.project_id AND l.key=w.key
        WHERE w.project_id=$1 AND (l.node_id IS NULL OR l.node_id=$2) AND w.execution_hold IS NULL AND ${deviceAvailable}
          AND w.requested_through>GREATEST(w.cursor,w.announced_through) AND w.due_at<=clock_timestamp()
          AND (w.lease_owner IS NULL OR w.lease_until<=clock_timestamp()) AND w.required_labels<@$3::text[]
          AND (CASE WHEN w.key='coordinator' THEN 'coordinator' WHEN w.key='mira' THEN 'mira' WHEN w.key LIKE 'w:%' THEN 'worker' ELSE 'unknown' END)=ANY($4::text[])
        ORDER BY w.due_at,w.key FOR UPDATE OF w SKIP LOCKED LIMIT 1`, [projectId, node.node_id, available, node.roles])).rows[0]
      let result = null
      if (candidate) {
        const lease = await this.runtime.claimLocked(c, { projectId, key: candidate.key, owner: nodeOwner(node.node_id, epoch), labels: available, leaseMs: this.leaseMs })
        if (!lease) fail('HEAD_CONFLICT', '执行目标已被认领')
        const project = (await this.control.projection(c, projectId)).get(projectId), old = project.sessions.get(lease.key)
        const resume = !!old && project.events.some(e => e.type === 'session.ready' && e.sessionId === old.sessionId && e.key === lease.key)
        const runId = randomUUID(), jobToken = token(), sessionId = resume ? old.sessionId : 'session-' + randomUUID()
        await c.query(`UPDATE ${this.s}.wake_targets SET execution_hold=$3 WHERE project_id=$1 AND key=$2`, [projectId, lease.key, runId])
        await c.query(`INSERT INTO ${this.s}.node_locations VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [projectId, lease.key, node.node_id])
        await c.query(`INSERT INTO ${this.s}.node_runs(run_id,node_id,epoch,project_id,key,fence,lease_owner,session_id,job_hash,job_token,resume,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'assigned')`, [runId, node.node_id, epoch, projectId, lease.key, lease.fence, lease.owner, sessionId, digest(jobToken), jobToken, resume])
        result = { runId, projectId, key: lease.key, fence: lease.fence, sessionId, jobToken, resume, nodeId: node.node_id, schema: this.runtime.schema }
        await this.event(c, node.node_id, { type: 'run.assigned', runId, projectId, key: lease.key, fence: lease.fence, epoch })
      }
      await c.query(`INSERT INTO ${this.s}.node_commands VALUES($1,$2,$3,$4,$5)`, [node.node_id, epoch, requestId, fingerprint, JSON.stringify(result)])
      return result
    })
    if (ticket) {
      const run = (await this.runtime.pool.query(`SELECT * FROM ${this.s}.node_runs WHERE run_id=$1`, [ticket.runId])).rows[0]
      if (run && ['assigned', 'running'].includes(run.state)) {
        await this.control.submit(run.project_id, { kind: 'host' }, { op: 'bindSession', sessionId: run.session_id }, { requestId: 'bind-remote-' + run.run_id, lease: this.lease(run) })
        await this.runtime.pool.query(`UPDATE ${this.s}.node_runs SET bound=true WHERE run_id=$1`, [run.run_id])
      }
    }
    return ticket
  }

  async assignment(c, entry) {
    const node = (await c.query(`SELECT *,connected_until>clock_timestamp() AS connected FROM ${this.s}.nodes WHERE node_id=$1 FOR UPDATE`, [entry.nodeId])).rows[0]
    const run = (await c.query(`SELECT * FROM ${this.s}.node_runs WHERE run_id=$1 FOR UPDATE`, [entry.runId])).rows[0]
    if (!node || node.status !== 'active' || !node.connected || !run || run.node_id !== node.node_id || String(run.epoch) !== String(node.epoch) || !run.bound || !['assigned', 'running'].includes(run.state)) fail('FORBIDDEN', '节点执行授权已失效')
    entry.lease = this.lease(run);entry.completed = run.turn ? JSON.parse(run.turn) : null
    return run
  }

  async resolveJob(credential) {
    const run = (await this.runtime.pool.query(`SELECT run_id,node_id,session_id,resume FROM ${this.s}.node_runs WHERE job_hash=$1 AND state IN('assigned','running')`, [digest(credential)])).rows[0]
    return run ? { runId: run.run_id, nodeId: run.node_id, sessionId: run.session_id, resume: run.resume, lease: {}, controllers: new Set(), revoked: false, completed: null, modelCalls: 0 } : null
  }

  async complete(entry, turn) {
    await this.runtime.transaction(async c => {
      const run = await this.assignment(c, entry)
      await this.runtime.head(c, run.project_id);await this.runtime.lockLease(c, entry.lease)
      if (run.turn && JSON.stringify(JSON.parse(run.turn)) !== JSON.stringify(turn)) fail('IDEMPOTENCY_CONFLICT', '完成意图已不同')
      await c.query(`UPDATE ${this.s}.node_runs SET turn=$2 WHERE run_id=$1`, [run.run_id, JSON.stringify(turn)])
    })
  }

  async chargeModel(entry, maxCalls) {
    return this.runtime.transaction(async c => {
      const run = await this.assignment(c, entry)
      await this.runtime.head(c, run.project_id);await this.runtime.lockLease(c, entry.lease)
      if (run.turn) fail('FORBIDDEN', '已结束的节点不能继续请求模型')
      if (run.model_calls >= maxCalls) fail('RATE_LIMIT', '本次节点执行已达到模型请求上限')
      await c.query(`UPDATE ${this.s}.node_runs SET model_calls=model_calls+1 WHERE run_id=$1`, [run.run_id])
    })
  }

  async started(credential, { epoch, runId, containerId }) {
    if (!/^[0-9a-f]{64}$/.test(containerId ?? '')) fail('INVALID_INPUT', '容器 id 无效')
    return this.runtime.transaction(async c => {
      const node = await this.auth(c, credential, { epoch, live: true })
      const run = (await c.query(`SELECT * FROM ${this.s}.node_runs WHERE run_id=$1 FOR UPDATE`, [runId])).rows[0]
      if (!run || run.node_id !== node.node_id || String(run.epoch) !== epoch || !['assigned', 'running'].includes(run.state)) fail('FORBIDDEN', '执行实例不属于此节点代际')
      if (run.container_id && run.container_id !== containerId) fail('IDEMPOTENCY_CONFLICT', '执行实例已绑定其他容器')
      await this.runtime.head(c, run.project_id);await this.runtime.lockLease(c, this.lease(run))
      await c.query(`UPDATE ${this.s}.node_runs SET container_id=$2,state='running' WHERE run_id=$1`, [runId, containerId])
      return { running: true }
    })
  }

  async stopped(credential, { runId, containerId = null, running, exitCode, neverStarted = false }) {
    if (running !== false || (!neverStarted && (!/^[0-9a-f]{64}$/.test(containerId ?? '') || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255))) fail('INVALID_INPUT', '需要明确的容器停止证明')
    return this.runtime.transaction(async c => {
      const node = await this.auth(c, credential, { allowRevoked: true })
      const run = (await c.query(`SELECT * FROM ${this.s}.node_runs WHERE run_id=$1 FOR UPDATE`, [runId])).rows[0]
      if (!run || run.node_id !== node.node_id) fail('FORBIDDEN', '执行实例不属于此节点')
      if (run.receipt) return JSON.parse(run.receipt)
      if (run.container_id && (neverStarted || run.container_id !== containerId)) fail('IDEMPOTENCY_CONFLICT', '停止证明不是已登记的容器')
      await this.runtime.head(c, run.project_id)
      const row = await this.runtime.lockTarget(c, run.project_id, run.key)
      if (row?.execution_hold !== run.run_id) fail('EXECUTION_HELD', '执行占用记录不匹配')
      await this.runtime.assertDeviceStopped(c,run.project_id,run.key)
      const active = node.status === 'active' && node.connected && String(node.epoch) === String(run.epoch)
        && row.lease_owner === run.lease_owner && String(row.fence) === String(run.fence) && await this.runtime.active(c, row)
      await c.query(`UPDATE ${this.s}.wake_targets SET execution_hold=NULL WHERE project_id=$1 AND key=$2`, [run.project_id, run.key])
      let result
      if (active && !neverStarted && exitCode === 0 && run.turn) {
        result = { state: 'complete', ...await this.runtime.finishLocked(c, this.lease(run), { turn: { sessionId: run.session_id, ...JSON.parse(run.turn) } }) }
      } else {
        await c.query(`UPDATE ${this.s}.wake_targets SET fence=fence+1,announced_through=cursor,due_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,claimed_through=NULL,read_through=NULL WHERE project_id=$1 AND key=$2`, [run.project_id, run.key])
        result = { state: 'failed', cursor: Number(row.cursor), requeued: true }
      }
      await c.query(`UPDATE ${this.s}.node_runs SET state=$2,receipt=$3 WHERE run_id=$1`, [run.run_id, result.state, JSON.stringify(result)])
      await this.event(c, node.node_id, { type: 'run.stopped', runId, containerId, exitCode, neverStarted, result })
      return result
    })
  }

  async recovery(credential) {
    return this.runtime.transaction(async c => {
      const node = await this.auth(c, credential, { allowRevoked: true })
      const runs = (await c.query(`SELECT run_id AS "runId",project_id AS "projectId",key,fence::text,container_id AS "containerId" FROM ${this.s}.node_runs WHERE node_id=$1 AND state IN('assigned','running') ORDER BY run_id`, [node.node_id])).rows
      return { nodeId: node.node_id, instanceId: node.instance_id, connected: node.connected, revoked: node.status === 'revoked', schema: this.runtime.schema, runs }
    })
  }

  async validate(credential, { epoch, runId }) {
    return this.runtime.transaction(async c => {
      const node = await this.auth(c, credential, { epoch, live: true })
      const run = (await c.query(`SELECT * FROM ${this.s}.node_runs WHERE run_id=$1 FOR UPDATE`, [runId])).rows[0]
      if (!run || run.node_id !== node.node_id || String(run.epoch) !== epoch || !['assigned', 'running'].includes(run.state)) fail('FORBIDDEN', '执行实例不属于当前节点')
      await this.runtime.head(c, run.project_id);await this.runtime.lockLease(c, this.lease(run))
      return { valid: true }
    })
  }

  async revoke(nodeId) {
    id(nodeId)
    await this.runtime.transaction(async c => {
      const row = (await c.query(`SELECT node_id FROM ${this.s}.nodes WHERE node_id=$1 FOR UPDATE`, [nodeId])).rows[0]
      if (!row) fail('NODE_NOT_FOUND', '没有此执行节点')
      await c.query(`UPDATE ${this.s}.nodes SET status='revoked',epoch=epoch+1,connected_until=NULL WHERE node_id=$1`, [nodeId])
      await this.event(c, nodeId, { type: 'node.revoked', by: 'owner' })
    })
  }
}
