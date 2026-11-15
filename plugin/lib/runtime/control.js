/**
 * Trusted single-owner control plane. Authentication belongs at the transport:
 * owner and host capabilities must never be constructed from model arguments.
 * Sessions receive only role-checked platform tools, never raw event append.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { ProjectStore, COORDINATOR, MIRA, DEFAULT_MEMBERS } from '../store.js'
import { Actions } from '../actions.js'
import { createTools, visibleTo } from '../tools.js'
import { renderItem } from '../protocol.js'
import { planMiraWake } from '../mira.js'
import { RuntimeError, inputBatch } from './postgres.js'
import { ProjectFiles, decodeFileChunk } from '../files.js'
import { ProjectRepositories } from '../repositories.js'
import { DEVICE_TOOL_NAMES } from '../devices.js'

const deny = message => { throw new RuntimeError('FORBIDDEN', message) }
function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f]/.test(value) || !value.isWellFormed()) throw new RuntimeError('INVALID_INPUT', `${label} 无效`)
  return value
}
function json(value) {
  try {
    const serialized = JSON.stringify(value)
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new Error('too large')
    return JSON.parse(serialized)
  } catch { throw new RuntimeError('INVALID_INPUT', '命令须为不超过 2 MB 的 JSON') }
}

/** A disposable projection. append stages events in memory; it never writes JSONL. */
class CommandStore extends ProjectStore {
  constructor(projectId, events, at) {
    super('', { warn() {} });this.projectId = projectId;this.at = at;this.pending = []
    for (const event of events) this.apply(event)
  }
  append(projectId, event) {
    if (projectId !== this.projectId) deny('命令不能跨项目写入')
    const seq = (this.projects.get(projectId)?.seq ?? 0) + 1
    const committed = json({ ...event, projectId, seq, at: this.at })
    this.apply(committed);this.pending.push(committed)
    return committed
  }
  createProject({ name, instructions, members = DEFAULT_MEMBERS }) {
    return this.append(this.projectId, {
      type: 'project.created', name, instructions, nonce: randomBytes(4).toString('hex'),
      members: [{ id: 'owner', kind: 'human', name: '我' }, ...members],
    })
  }
}

export class ProjectControl {
  constructor(runtime, { blobs } = {}) { this.runtime = runtime;this.blobs = blobs }

  async projection(c, projectId, at = Date.now()) {
    const rows = await c.query(`SELECT data FROM ${this.runtime.s}.events WHERE project_id=$1 ORDER BY seq`, [projectId])
    return new CommandStore(projectId, rows.rows.map(row => JSON.parse(row.data)), at)
  }

  session(store, lease, sessionId) {
    identifier(sessionId, 'sessionId')
    const binding = store.bySession(sessionId), project = store.get(lease.projectId)
    const event = project.events.findLast(e => e.type === 'session.bound' && e.key === lease.key)
    if (binding?.projectId !== lease.projectId || binding.key !== lease.key || event?.sessionId !== sessionId || event.fence !== lease.fence || event.node !== lease.owner) deny('会话与当前认领不匹配')
    const assignee = lease.key === COORDINATOR || lease.key === MIRA ? lease.key : project.threads.get(lease.key.slice(2))?.assignee
    if (!project.members.some(m => m.id === assignee && m.kind === 'assistant' && m.active !== false)) deny('成员不存在或已移出项目')
    return project
  }

  /** Called only by the authenticated owner transport or the trusted host. */
  async submit(projectId, principal, command, { requestId, expectedSeq, lease, authorize, uploadedArtifact, signal } = {}) {
    identifier(projectId, 'projectId');identifier(requestId, 'requestId')
    if (requestId.startsWith('sys:')) throw new RuntimeError('INVALID_INPUT', 'requestId 使用保留前缀')
    if (expectedSeq !== undefined && (!Number.isSafeInteger(expectedSeq) || expectedSeq < 0)) throw new RuntimeError('INVALID_INPUT', 'expectedSeq 无效')
    if (!['owner', 'session', 'host'].includes(principal?.kind)) deny('不支持的命令主体')
    const actor = principal.kind === 'session' ? { kind: 'session', sessionId: identifier(principal.sessionId, 'sessionId') } : { kind: principal.kind }
    const input = json(command)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeError('INVALID_INPUT', '命令须为对象')
    if (actor.kind !== 'owner' && (!lease || lease.projectId !== projectId)) deny('需要本项目的执行租约')
    if (this.devices && actor.kind === 'owner' && ['grantDevice', 'revokeDevice'].includes(input.op)) return this.devices.owner(projectId, input, { requestId, expectedSeq })
    if (this.devices && input.op === 'tool' && DEVICE_TOOL_NAMES.has(input.tool)) {
      if (actor.kind !== 'session') deny('设备工具需要当前项目会话')
      return this.devices.tool(projectId, lease, actor.sessionId, input.tool, input.args, { requestId, authorize, signal })
    }
    if (uploadedArtifact && (input.op !== 'tool' || input.tool !== 'artifact_publish' || !/^[a-f0-9]{64}$/.test(uploadedArtifact.sha256 ?? ''))) deny('文件传输元数据不能用于此命令')
    const fingerprint = { kind: 'domain-v1', actor, command: input, ...(uploadedArtifact ? { uploadedArtifact: { sha256: uploadedArtifact.sha256 } } : {}),
      ...(lease ? { lease: { key: lease.key, owner: lease.owner, fence: lease.fence } } : {}) }
    const rt = this.runtime
    return rt.transaction(async c => {
      if (authorize) await authorize(c)
      const head = await rt.head(c, projectId, actor.kind === 'owner' && input.op === 'createProject')
      if (lease) await rt.lockLease(c, lease)
      const at = Number((await c.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS at')).rows[0].at)
      const store = await this.projection(c, projectId, at)
      if (actor.kind === 'session') this.session(store, lease, actor.sessionId)
      // Replays precede fresh domain validation, which may no longer hold after
      // successful execution (e.g. the decision has already been answered).
      const replay = await rt.command(c, projectId, requestId, fingerprint)
      if (replay) return replay
      if (expectedSeq !== undefined && head !== expectedSeq) throw new RuntimeError('HEAD_CONFLICT', '项目已变化，请刷新后重试')
      const turn = { platform: false, replied: false, concluded: false }
      const driver = { deliver() {}, turnOf: () => turn, status: () => 'idle' }
      const files = this.blobs ? new ProjectFiles(store, driver, { blobs: this.blobs, uploadedArtifact }) : null
      const actions = new Actions(store, driver, { files })
      let value
      if (actor.kind === 'owner') {
        switch (input.op) {
          case 'createProject':
            if (head !== 0) throw new RuntimeError('INVALID_INPUT', '项目已存在')
            if (Object.keys(input).some(k => !['op', 'name', 'instructions'].includes(k))) throw new RuntimeError('UNSUPPORTED', '运行时试验入口目前仅创建独立的空工作区项目')
            value = actions.createProject({ name: input.name, instructions: input.instructions, workspaceMode: 'shared' });break
          case 'post': value = actions.ownerPost({ ...input, projectId });break
          case 'answer': value = actions.answerDecision({ ...input, projectId });break
          case 'updateThread': value = actions.ownerUpdateThread({ ...input, projectId });break
          case 'miraRun': value = actions.miraRun({ ...input, projectId });break
          case 'cardAction': value = actions.cardAction({ ...input, projectId });break
          case 'fileWrite':
          case 'fileCommit': {
            if (!files) throw new RuntimeError('UNSUPPORTED', '项目文件服务尚未就绪')
            value = input.op === 'fileWrite' ? await files.writeText(projectId, 'owner', input) : await files.commitUpload(projectId, 'owner', input)
            break
          }
          case 'importRepository': {
            if (!files) throw new RuntimeError('UNSUPPORTED', '项目文件服务尚未就绪')
            value = await new ProjectRepositories(files).import(projectId, input);break
          }
          case 'forgetMemory': value = actions.memoryForget({ ...input, projectId });break
          default: throw new RuntimeError('UNSUPPORTED', '此运行时尚不支持该 owner 操作')
        }
      } else if (actor.kind === 'host') {
        if (input.op === 'sessionReady') {
          this.session(store, lease, input.sessionId)
          store.append(projectId, { type: 'session.ready', key: lease.key, sessionId: input.sessionId })
          value = { ready: true }
        } else if (input.op === 'executionCall') {
          this.session(store, lease, input.sessionId)
          if (!lease.key.startsWith('w:') || !['read', 'read_image', 'write', 'edit', 'bash', 'grep', 'glob'].includes(input.tool)) deny('当前目标没有此原生执行能力')
          identifier(input.callId, 'callId')
          if (!['started', 'finished'].includes(input.stage) || !/^[0-9a-f]{64}$/.test(input.fingerprint) || (input.stage === 'finished' && typeof input.ok !== 'boolean')) throw new RuntimeError('INVALID_INPUT', '原生执行记录无效')
          store.append(projectId, { type: 'execution.tool.' + input.stage, key: lease.key, sessionId: input.sessionId, callId: input.callId, tool: input.tool, fingerprint: input.fingerprint,
            ...(input.stage === 'finished' ? { ok: input.ok } : {}) })
          value = { recorded: true }
        } else {
        if (input.op !== 'bindSession') deny('不支持的宿主操作')
        identifier(input.sessionId, 'sessionId')
        const project = store.get(projectId), key = lease.key
        const assignee = [COORDINATOR, MIRA].includes(key) ? key : key.startsWith('w:') ? project.threads.get(key.slice(2))?.assignee : null
        if (!project.members.some(m => m.id === assignee && m.kind === 'assistant' && m.active !== false)) deny('不能为未知目标绑定会话')
        const collision = store.bySession(input.sessionId)
        if (collision && collision.key !== key) deny('会话已经绑定其他角色')
        const old = project.sessions.get(key)
        if (key.startsWith('w:')) {
          const thread = project.threads.get(key.slice(2))
          if (!thread.repositoryBound) store.append(projectId, { type: 'thread.repository.bound', threadId: thread.id, repository: old ? null : project.repository })
        }
        store.append(projectId, { type: 'session.bound', key, sessionId: input.sessionId, node: lease.owner, fence: lease.fence,
          assignee, generation: old?.sessionId === input.sessionId ? old.generation : (old?.generation ?? 0) + 1,
          continuity: !!old && old.sessionId !== input.sessionId, configRevision: project.configRevision ?? 0 })
        value = { sessionId: input.sessionId, key }
        }
      } else {
        if (input.op !== 'tool' || input.tool === 'inbox_read') deny('只允许受控平台工具；收件箱有独立的读取接口')
        const definitions = createTools({ defineTool: d => d, store, driver, actions, files })
        const selected = definitions.find(t => t.definition.name === input.tool)
        const agent = { id: actor.sessionId }
        if (!selected || !visibleTo(store, selected.role)({ agent })) deny('当前角色不能调用这个工具')
        if (input.tool === 'update_card' && input.args?.state === 'done') deny('线程完成需要用户验收')
        const result = await selected.definition.execute(input.args ?? {}, { agent, concludeTurn: () => { turn.concluded = true } })
        value = { result, platform: turn.platform, replied: turn.replied, concluded: turn.concluded }
      }
      if (!store.pending.length) store.append(projectId, { type: 'command.completed', actor: actor.kind, op: input.op })
      const wakes = []
      for (const event of store.pending) {
        for (const key of event.to ?? []) wakes.push({ key, reason: 'event' })
        const wake = planMiraWake(store, event)
        if (wake) wakes.push({ key: MIRA, ...wake })
      }
      const events = store.pending.map(({ seq, at, projectId, ...event }) => event)
      const clean = inputBatch(events, wakes)
      // Validate the lease again after an async reducer before committing its
      // effects; a held row lock does not make an expired deadline valid.
      if (lease) await rt.lockLease(c, lease)
      if (authorize) await authorize(c)
      const saved = await rt.persist(c, projectId, head, clean.events, requestId, fingerprint, { value })
      for (const wake of clean.wakes) await rt.queue(c, projectId, wake.key, saved.headSeq, wake.delayMs, wake.reason)
      return saved
    })
  }

  /** Session identity is checked before read progress can change, in one tx. */
  async inbox(lease, sessionId, { limit = 30, peek = false, requestId = randomUUID(), authorize } = {}) {
    identifier(requestId, 'requestId')
    if (requestId.startsWith('sys:')) throw new RuntimeError('INVALID_INPUT', 'requestId 使用保留前缀')
    const fingerprint = { kind: 'inbox-v1', sessionId, limit, peek, lease: { key: lease.key, owner: lease.owner, fence: lease.fence } }
    const rt = this.runtime
    return rt.transaction(async c => {
      if (authorize) await authorize(c)
      const head = await rt.head(c, lease.projectId);await rt.lockLease(c, lease)
      const store = await this.projection(c, lease.projectId), project = this.session(store, lease, sessionId)
      const replay = await rt.command(c, lease.projectId, requestId, fingerprint)
      if (replay) return replay.value
      const batch = await rt.readInboxLocked(c, lease, { limit, peek })
      const value = { ...batch, text: batch.events.length ? batch.events.map(e => renderItem(project, e)).join('\n') + '\n需要时继续 inbox_read；正常结束回合后才确认。' : '收件箱没有未读条目。' }
      if (authorize) await authorize(c)
      await rt.persist(c, lease.projectId, head, [{ type: 'tool.called', key: lease.key, tool: 'inbox_read', ok: true, ms: 0 }], requestId, fingerprint, { value })
      return value
    })
  }

  async snapshot(projectId) {
    const rt = this.runtime
    return rt.transaction(async c => { await rt.head(c, projectId);return this.projection(c, projectId) })
  }
  async fileTransfer(lease, sessionId, input, { authorize } = {}) {
    if (!this.blobs) throw new RuntimeError('UNSUPPORTED', '项目文件服务尚未就绪')
    const rt = this.runtime
    return rt.transaction(async c => {
      if (authorize) await authorize(c)
      await rt.head(c, lease.projectId);await rt.lockLease(c, lease)
      const store = await this.projection(c, lease.projectId);this.session(store, lease, sessionId)
      const files = new ProjectFiles(store, null, { blobs: this.blobs })
      let result
      if (input.op === 'fileChunk') {
        files.writer(lease.projectId, lease.key)
        result = { sha256: await this.blobs.put(lease.projectId, decodeFileChunk(input.data)) }
      } else if (input.op === 'fileAssemble') {
        files.writer(lease.projectId, lease.key)
        result = { sha256: await this.blobs.assemble(lease.projectId, input.chunks, input.sha256, input.size) }
      } else if (input.op === 'fileReadChunk') result = await files.readChunk(lease.projectId, input)
      else throw new RuntimeError('FORBIDDEN', '不支持的文件操作')
      await rt.lockLease(c, lease)
      if (authorize) await authorize(c)
      return result
    })
  }
}
