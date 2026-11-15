/** Scoped, outbound node protocol. Database and model credentials stay here. */
import { createServer } from 'node:http'
import { chmod, unlink } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { RuntimeError } from './postgres.js'
import { once } from 'node:events'
import { FileError } from '../files.js'
import { DeviceError } from '../devices.js'

const MAX_BODY = 2 * 1024 * 1024
const bad = (code, message) => { throw new RuntimeError(code, message) }
const hash = value => createHash('sha256').update(value).digest('hex')
async function body(req) {
  const chunks = [];let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) bad('INVALID_INPUT', '请求超过 2 MB')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { bad('INVALID_INPUT', '请求须为 JSON') }
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
function turnValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['silent', 'nudged', 'unanswered'].includes(k)) || Object.values(value).some(v => typeof v !== 'boolean')) bad('INVALID_INPUT', '无效的完成信息')
  return { silent: value.silent ?? false, nudged: value.nudged ?? false, unanswered: value.unanswered ?? false }
}

export class NodeGateway {
  constructor(control, { modelURL, modelKey, model, leaseMs = 30000, maxModelCalls = 32, resolveCapability, authorizeAssignment, completeAssignment, chargeModel } = {}) {
    this.control = control;this.runtime = control.runtime
    this.modelURL = modelURL;this.modelKey = modelKey;this.model = model
    this.leaseMs = leaseMs;this.maxModelCalls = maxModelCalls;this.capabilities = new Map()
    this.resolveCapability = resolveCapability;this.authorizeAssignment = authorizeAssignment;this.completeAssignment = completeAssignment;this.chargeModel = chargeModel
  }

  /** Called only by the supervisor after it has bound this exact session. */
  issue(lease, sessionId, { resume = false } = {}) {
    const token = randomBytes(32).toString('base64url')
    const entry = { lease, sessionId, resume, completed: null, modelCalls: 0, revoked: false, controllers: new Set() }
    entry.tokenHash = hash(token);this.capabilities.set(entry.tokenHash, entry)
    return { token, entry }
  }

  revoke(entry) {
    entry.revoked = true
    this.capabilities.delete(entry.tokenHash)
    for (const controller of entry.controllers) controller.abort()
  }

  async authorize(entry) {
    if (!entry || entry.revoked) bad('FORBIDDEN', '节点能力已失效')
    const rt = this.runtime
    return rt.transaction(async c => {
      if (this.authorizeAssignment) await this.authorizeAssignment(c, entry)
      await rt.head(c, entry.lease.projectId);await rt.lockLease(c, entry.lease)
      const store = await this.control.projection(c, entry.lease.projectId)
      this.control.session(store, entry.lease, entry.sessionId)
      return store
    })
  }

  async rpc(entry, input, { signal } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) bad('INVALID_INPUT', '无效的节点请求')
    if (input.op === 'health') { await this.authorize(entry);return { valid: true, completed: !!entry.completed } }
    if (entry.completed) {
      if (input.op === 'complete' && JSON.stringify(turnValue(input.turn)) === JSON.stringify(entry.completed)) return { accepted: true, awaitingContainerStop: true }
      bad('FORBIDDEN', '已结束的节点不能继续执行')
    }
    const store = await this.authorize(entry), lease = entry.lease, project = store.get(lease.projectId)
    const authorize = async c => {
      if (entry.revoked || entry.completed) bad('FORBIDDEN', '节点执行授权已结束')
      if (this.authorizeAssignment) { await this.authorizeAssignment(c, entry);if (entry.completed) bad('FORBIDDEN', '节点执行已结束') }
    }
    if (entry.completed && input.op !== 'complete') bad('FORBIDDEN', '已结束的节点不能继续执行')
    switch (input.op) {
      case 'hello': return { projectId: lease.projectId, key: lease.key, sessionId: entry.sessionId, resume: entry.resume, throughSeq: project.seq, nativeExecution: lease.key.startsWith('w:'), model: this.model, projectFiles: !!this.control.blobs, projectDevices: !!this.control.devices,
        repository: lease.key.startsWith('w:') ? project.threads.get(lease.key.slice(2))?.repository ?? null : null }
      case 'fileChunk':
      case 'fileAssemble':
      case 'fileReadChunk': return this.control.fileTransfer(lease, entry.sessionId, input, { authorize })
      case 'events': {
        const { after = 0, through = project.seq, limit = 500 } = input
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(through) || through < 0 || through > project.seq || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) bad('INVALID_INPUT', '无效的事件分页范围')
        const events = project.events.filter(e => e.seq > after && e.seq <= through).slice(0, limit)
        const readThrough = events.at(-1)?.seq ?? Math.min(after, through)
        return { events, throughSeq: through, readThrough, hasMore: readThrough < through }
      }
      case 'inbox': return this.control.inbox(lease, entry.sessionId, { requestId: input.requestId, limit: input.limit, peek: input.peek, authorize })
      case 'ready': return this.control.submit(lease.projectId, { kind: 'host' }, { op: 'sessionReady', sessionId: entry.sessionId },
        { requestId: 'ready-' + hash(entry.sessionId + '/' + lease.fence), lease, authorize })
      case 'tool': return this.control.submit(lease.projectId, { kind: 'session', sessionId: entry.sessionId },
        { op: 'tool', tool: input.tool, args: input.args }, { requestId: input.requestId, lease, authorize, signal })
      case 'publishArtifact': return this.control.submit(lease.projectId, { kind: 'session', sessionId: entry.sessionId },
        { op: 'tool', tool: 'artifact_publish', args: input.args }, { requestId: input.requestId, lease, authorize, uploadedArtifact: { sha256: input.blobSha } })
      case 'native': return this.control.submit(lease.projectId, { kind: 'host' },
        { op: 'executionCall', sessionId: entry.sessionId, callId: input.callId, tool: input.tool, stage: input.stage, fingerprint: input.fingerprint, ...(input.stage === 'finished' ? { ok: input.ok } : {}) },
        { requestId: input.requestId, lease, authorize, signal })
      case 'complete': {
        const turn = turnValue(input.turn)
        if (this.completeAssignment) await this.completeAssignment(entry, turn)
        entry.completed = { ...turn }
        return { accepted: true, awaitingContainerStop: true }
      }
      default: bad('FORBIDDEN', '节点不具备此操作能力')
    }
  }

  async modelRequest(entry, req, res) {
    if (entry.completed) bad('FORBIDDEN', '已结束的节点不能继续请求模型')
    await this.authorize(entry)
    if (!this.modelURL || !this.modelKey || !this.model) bad('UNAVAILABLE', '未配置模型出口')
    if (entry.modelCalls >= this.maxModelCalls) bad('RATE_LIMIT', '本次节点执行已达到模型请求上限')
    const input = await body(req)
    await this.authorize(entry)
    if (entry.completed || entry.revoked) bad('FORBIDDEN', '节点执行已结束')
    if (input.model !== this.model || !Array.isArray(input.messages) || !input.messages.length) bad('FORBIDDEN', '节点只能使用已分配的模型')
    const limit = input.max_tokens ?? 16384
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16384) bad('INVALID_INPUT', '模型输出上限无效')
    // No arbitrary routes, provider headers, redirects, or credentials from a node.
    const payload = { model: this.model, messages: input.messages, max_tokens: limit, stream: input.stream === true,
      ...(input.tools ? { tools: input.tools } : {}), ...(input.tool_choice ? { tool_choice: input.tool_choice } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}) }
    if (this.chargeModel) await this.chargeModel(entry, this.maxModelCalls)
    if (entry.completed || entry.revoked) bad('FORBIDDEN', '节点执行已结束')
    entry.modelCalls++
    const controller = new AbortController();entry.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 180000)
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    try {
      const upstream = await fetch(this.modelURL, { method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + this.modelKey, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal })
      if (!upstream.ok) {
        await upstream.body?.cancel()
        json(res, upstream.status === 429 ? 429 : 502, { error: { message: '模型出口暂未完成请求', type: 'upstream_error' } })
        return
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
      if (upstream.body) for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal })
      }
      res.end()
    } finally { clearTimeout(timeout);entry.controllers.delete(controller) }
  }

  async handle(req, res) {
      try {
        const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1]
        let entry = token ? this.capabilities.get(hash(token)) : null
        if (!entry && token && this.resolveCapability) {
          entry = await this.resolveCapability(token)
          if (entry) { entry.tokenHash = hash(token);this.capabilities.set(entry.tokenHash, entry) }
        }
        if (!entry || entry.revoked) bad('FORBIDDEN', '没有有效的节点能力')
        if (req.method !== 'POST') bad('FORBIDDEN', '不支持此节点方法')
        if (req.url === '/rpc') {
          const controller=new AbortController();entry.controllers.add(controller)
          res.on('close',()=>{if(!res.writableEnded)controller.abort()})
          try { json(res,200,await this.rpc(entry,await body(req),{signal:controller.signal})) }
          finally { entry.controllers.delete(controller) }
        }
        else if (req.url === '/model') await this.modelRequest(entry, req, res)
        else bad('FORBIDDEN', '不支持此节点路径')
      } catch (error) {
        if (res.headersSent) { res.destroy();return }
        req.resume();res.setHeader('connection', 'close')
        // Never publish provider failures, connection strings or request headers.
        const known = error instanceof RuntimeError || error instanceof FileError || error instanceof DeviceError
        json(res, known && ['FORBIDDEN', 'STALE_LEASE'].includes(error.code) ? 403 : 400,
          { error: known ? error.message : '节点请求未完成', code: known ? error.code : 'UNAVAILABLE' })
      }
  }

  async listen(socketPath) {
    this.server = createServer((req, res) => this.handle(req, res))
    this.server.requestTimeout = 30000;this.server.headersTimeout = 5000
    await new Promise((resolve, reject) => { this.server.once('error', reject);this.server.listen(socketPath, resolve) })
    await chmod(socketPath, 0o600);this.socketPath = socketPath
  }

  async close() {
    for (const entry of this.capabilities.values()) this.revoke(entry)
    if (this.server) { this.server.closeAllConnections();await new Promise(resolve => this.server.close(resolve)) }
    if (this.socketPath) await unlink(this.socketPath).catch(() => {})
  }
}
export { body as readNodeBody, json as nodeJSON }
