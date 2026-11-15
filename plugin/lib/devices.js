/** Owner-approved device capabilities, shared by local and cloud transports. */
import { createHash } from 'node:crypto'
import { deviceRequestState } from './device-state.js'

// Container preparation is bounded separately from the worker's command timeout.
export const DEVICE_PREPARATION_MS = 10_000

export class DeviceError extends Error {
  constructor(message, code = 'INVALID_DEVICE') { super(message);this.name = 'DeviceError';this.code = code }
}
const fail = (message, code) => { throw new DeviceError(message, code) }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validId = (value, name) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) fail(name + '无效')
  return value
}
const revision = value => { if (!Number.isSafeInteger(value) || value < 0) fail('授权版本无效');return value }
const inputKeys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('授权包含不支持的字段')
}

/** No device credential, root path or self-reported approval enters events. */
export class DeviceGrants {
  constructor(store, { devices = () => [], now = Date.now } = {}) { this.store = store;this.devices = devices;this.now = now }
  view(projectId) {
    const project = this.store.get(projectId), grants = new Map(), receipts = new Map();let rev = 0
    for (const event of project.events) {
      if (event.type === 'device.granted') {
        for (const id of event.revokedIds) if (grants.has(id)) grants.set(id, { ...grants.get(id), revokedAt: event.at })
        grants.set(event.grant.id, event.grant);rev = event.revision
        receipts.set(event.requestId, { fingerprint: event.fingerprint, result: event.grant })
      } else if (event.type === 'device.revoked') {
        if (grants.has(event.grantId)) grants.set(event.grantId, { ...grants.get(event.grantId), revokedAt: event.at })
        rev = event.revision;receipts.set(event.requestId, { fingerprint: event.fingerprint, result: event.result })
      }
    }
    return { grants, receipts, revision: rev }
  }
  descriptors(projectId) {
    return this.devices(projectId).map(d => ({ id: validId(d.id, '设备身份'), name: String(d.name).slice(0, 100),
      roots: d.roots.map(r => ({ id: validId(r.id, '目录身份'), label: String(r.label).slice(0, 100) })), ...(typeof d.online==='boolean'?{online:d.online}:{}) }))
  }
  configured(projectId, deviceId, rootId) {
    const d = this.descriptors(projectId).find(d => d.id === deviceId)
    if (!d?.roots.some(r => r.id === rootId)) fail('设备或已配置目录不可用', 'DEVICE_UNAVAILABLE')
    return d
  }
  snapshot(projectId) {
    const view = this.view(projectId), now = this.now()
    return { revision: view.revision, devices: this.descriptors(projectId), grants: [...view.grants.values()].map(g => ({ ...g,
      state: g.revokedAt ? 'revoked' : g.expiresAt <= now ? 'expired' : 'active' })) }
  }
  replay(view, requestId, fingerprint) {
    const old = view.receipts.get(requestId)
    if (!old) return null
    if (old.fingerprint !== fingerprint) fail('同一授权请求的内容不同', 'IDEMPOTENCY_CONFLICT')
    return old.result
  }
  /** Trusted owner route only. There is deliberately no agent grant tool. */
  grant(projectId, input) {
    inputKeys(input, ['requestId', 'expectedRevision', 'deviceId', 'rootId', 'kind', 'access', 'expiresAt'])
    const requestId = validId(input.requestId, '请求身份'), deviceId = validId(input.deviceId, '设备身份'), rootId = validId(input.rootId, '目录身份')
    const expectedRevision = revision(input.expectedRevision), kind = input.kind, access = input.access
    if (!['folder', 'exec'].includes(kind) || (kind === 'folder' ? !['read', 'write'].includes(access) : access !== undefined)) fail('目录访问和执行需分别授权')
    if (!Number.isSafeInteger(input.expiresAt)) fail('授权有效期无效')
    const fingerprint = hash({ op: 'grant', deviceId, rootId, kind, access, expiresAt: input.expiresAt, expectedRevision })
    const view = this.view(projectId), replay = this.replay(view, requestId, fingerprint)
    if (replay) return replay
    if (view.revision !== expectedRevision) fail('设备授权已变化，请刷新后重试', 'GRANT_CONFLICT')
    const now = this.now()
    if (input.expiresAt <= now || input.expiresAt > now + 30 * 86400000) fail('有效期需在未来30天内')
    this.configured(projectId, deviceId, rootId)
    const same = [...view.grants.values()].filter(g => g.deviceId === deviceId && !g.revokedAt)
    if (kind === 'folder' && same.some(g => g.kind === 'exec' && g.expiresAt > now)) fail('先撤销该设备的执行权限，再开启目录访问', 'EXEC_ACTIVE')
    const revokedIds = same.filter(g => kind === 'exec' || (g.kind === 'folder' && g.rootId === rootId)).map(g => g.id)
    const grant = { id: 'dg_' + hash([projectId, requestId]).slice(0, 32), deviceId, rootId, kind,
      ...(kind === 'folder' ? { access } : {}), approvedBy: 'owner', approvedAt: now, expiresAt: input.expiresAt }
    this.store.append(projectId, { type: 'device.granted', grant, revokedIds, revision: view.revision + 1, requestId, fingerprint })
    return grant
  }
  revoke(projectId, input) {
    inputKeys(input, ['requestId', 'expectedRevision', 'grantId'])
    const requestId = validId(input.requestId, '请求身份'), grantId = validId(input.grantId, '授权身份'), expectedRevision = revision(input.expectedRevision)
    const fingerprint = hash({ op: 'revoke', grantId, expectedRevision }), view = this.view(projectId)
    const replay = this.replay(view, requestId, fingerprint)
    if (replay) return replay
    if (view.revision !== expectedRevision) fail('设备授权已变化，请刷新后重试', 'GRANT_CONFLICT')
    if (!view.grants.has(grantId)) fail('授权不属于本项目', 'FORBIDDEN')
    const result = { grantId, state: 'revoked' }
    this.store.append(projectId, { type: 'device.revoked', grantId, result, revision: view.revision + 1, requestId, fingerprint })
    return result
  }
  resolve(projectId, grantId, operation) {
    const grant = this.view(projectId).grants.get(grantId)
    if (!grant) fail('授权不属于本项目', 'FORBIDDEN')
    if (grant.revokedAt) fail('设备权限已撤销', 'GRANT_REVOKED')
    if (grant.expiresAt <= this.now()) fail('设备权限已过期', 'GRANT_EXPIRED')
    this.configured(projectId, grant.deviceId, grant.rootId)
    if (!['fs.list', 'fs.read', 'fs.write', 'exec'].includes(operation)
      || (operation === 'exec' ? grant.kind !== 'exec' : grant.kind !== 'folder')
      || (operation === 'fs.write' && grant.access !== 'write')) fail('设备授权不允许这项操作', 'FORBIDDEN')
    return grant
  }
}

/** Same tool surface; local execution below, durable cloud broker plugs in later. */
export class ProjectDeviceBridge {
  constructor(store, driver, host, options = {}) {
    this.store = store;this.driver = driver;this.host = host
    this.grants = new DeviceGrants(store, { devices: () => [host.describe()], ...options })
  }
  snapshot(projectId) { return this.grants.snapshot(projectId) }
  grant(projectId, input) { return this.grants.grant(projectId, input) }
  revoke(projectId, input) { return this.grants.revoke(projectId, input) }
  authorize(projectId, key, sessionId, grantId, op) {
    const binding = this.store.bySession(sessionId), project = this.store.get(projectId)
    if (binding?.projectId !== projectId || binding.key !== key) fail('设备操作需要本项目的当前会话', 'FORBIDDEN')
    if (key.startsWith('w:')) {
      const thread = project.threads.get(key.slice(2))
      if (!thread || thread.resolved || ['done', 'failed'].includes(thread.state)) fail('线程已结束，不能继续操作设备', 'FORBIDDEN')
    } else if (op === 'exec' || op === 'fs.write') fail('只有执行线程可以写设备文件或执行命令', 'FORBIDDEN')
    return this.grants.resolve(projectId, grantId, op)
  }
  async call(projectId, key, { grantId, op, args, requestId, sessionId }) {
    const assertCurrent = async () => this.authorize(projectId, key, sessionId, grantId, op)
    const grant = await assertCurrent(), project = this.store.get(projectId)
    validId(requestId, '设备请求身份')
    const subject = sessionId, fingerprint = hash({ grantId, op, args, subject, key })
    const old = project.events.find(e => e.type === 'device.requested' && e.requestId === requestId)
    if (old && old.fingerprint !== fingerprint) fail('相同设备请求内容不同', 'IDEMPOTENCY_CONFLICT')
    if (!old) this.store.append(projectId, { type: 'device.requested', requestId, fingerprint, grantId, key, subject, op })
    try {
      const value = await this.host.call({ projectId, subject, requestId, grant, op, args }, { assertCurrent })
      await assertCurrent()
      if (!project.events.some(e => e.type === 'device.finished' && e.requestId === requestId)) this.store.append(projectId, { type: 'device.finished', requestId, key, grantId, op, ok: true })
      return value
    } catch (error) {
      // A tool error is not a stop proof. Driver must call assertStopped before
      // acknowledging this turn or starting a replacement session.
      if (!project.events.some(e => e.type === 'device.failed' && e.requestId === requestId)) this.store.append(projectId, { type: 'device.failed', requestId, key, grantId, op, code: error instanceof DeviceError ? error.code : 'DEVICE_UNKNOWN' })
      throw error instanceof DeviceError ? error : new DeviceError('设备操作结果未确认，请先查看实际文件或任务状态', 'DEVICE_UNKNOWN')
    }
  }
  async assertStopped(projectId, key) {
    const project = this.store.get(projectId)
    const intents = project.events.filter(e => e.type === 'device.requested' && e.key === key)
    const requests = intents.map(e => e.requestId)
    if (requests.length) {
      try { await this.host.assertStopped(requests) }
      catch (error) { throw error instanceof DeviceError ? error : new DeviceError('设备操作尚未证实停止，不能确认本轮', 'EXECUTION_HELD') }
      for (const intent of intents) {
        if (project.events.some(e => e.type === 'device.stopped' && e.requestId === intent.requestId)) continue
        let outcome = project.events.some(e => e.type === 'device.finished' && e.requestId === intent.requestId) ? 'ok' : 'unknown'
        if (outcome !== 'ok') {
          try {
            const state = await this.host.executionState?.(intent)
            if (state?.stopped === true && ['ok', 'error', 'unknown'].includes(state.outcome)) outcome = state.outcome
          } catch { /* The proven stop is retained; unavailable outcome remains unknown. */ }
        }
        this.store.append(projectId, { type: 'device.stopped', requestId: intent.requestId, key,
          grantId: intent.grantId, op: intent.op, stopped: true, outcome })
      }
    }
  }
  /** Observe receipts only. Reading progress never initializes, recovers, cancels or retries a device. */
  async executionStates(projects) {
    const result = new Map()
    for (const project of projects) {
      const requests = new Map()
      const grants = this.grants.view(project.id).grants
      for (const event of project.events) {
        if (event.type === 'device.requested') requests.set(event.requestId, { intent: event, pending: true })
        else if (event.type === 'device.finished' && requests.has(event.requestId)) requests.get(event.requestId).finished = true
        else if (event.type === 'device.failed' && requests.has(event.requestId)) requests.get(event.requestId).pending = false
        else if (event.type === 'device.stopped' && requests.has(event.requestId)) requests.get(event.requestId).stop = event
      }
      for (const { intent, pending, finished, stop } of requests.values()) {
        if (finished || stop && (stop.outcome === 'ok' || stop.outcome === 'error' || stop.ok === true)) continue
        const deviceId = grants.get(intent.grantId)?.deviceId
        let state = { phase: 'unconfirmed', stopped: false }
        if (stop) state = { phase: 'stopped', stopped: true, outcome: 'unknown' }
        else {
          try { state = await this.host.executionState?.(intent) ?? state }
          catch { /* A failed observation is not a stopped device and exposes no private IO error. */ }
        }
        if (state.stopped && ['ok', 'error'].includes(state.outcome)) continue
        const id = project.id + '|' + intent.key, rows = result.get(id) ?? []
        rows.push(deviceRequestState({ ...state, requestId: intent.requestId, deviceId, pending: pending && !stop }))
        result.set(id, rows)
      }
    }
    return result
  }
}

export const DEVICE_TOOL_NAMES = new Set(['list_devices', 'device_fs_list', 'device_fs_read', 'device_fs_write', 'device_exec'])
/** Transport-neutral public arguments; identities and grants are server-derived. */
export function deviceOperation(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('设备工具参数无效', 'INVALID_INPUT')
  if (tool === 'list_devices') return null
  const grantId = validId(input.grant_id, '授权身份')
  switch (tool) {
    case 'device_fs_list': return { grantId, op: 'fs.list', args: { path: input.path ?? '.' } }
    case 'device_fs_read': {
      const offset = input.offset ?? 0, limit = input.limit ?? 32000
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32000) fail('设备读取范围无效', 'INVALID_INPUT')
      return { grantId, op: 'fs.read', args: { path: input.path, offset, limit } }
    }
    case 'device_fs_write': return { grantId, op: 'fs.write', args: { path: input.path, text: input.text, expectedSha256: input.expected_sha256 === '' ? null : input.expected_sha256 } }
    case 'device_exec': {
      const timeoutMs = input.timeout_ms ?? 10000
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) fail('设备命令时限无效', 'INVALID_INPUT')
      return { grantId, op: 'exec', args: { command: input.command, cwd: input.cwd ?? '.', timeoutMs } }
    }
    default: fail('不支持的设备工具', 'FORBIDDEN')
  }
}
