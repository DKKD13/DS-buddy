/** Linux device executor. Only this trusted process can access its Docker daemon. */
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, realpath, open, readFile, writeFile, rename, rm, readdir, chmod, unlink } from 'node:fs/promises'
import { resolve, isAbsolute, dirname, join } from 'node:path'
import { DeviceError, DEVICE_PREPARATION_MS } from '../devices.js'
import { DockerNodes } from './containers.js'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (message, code = 'DEVICE_UNAVAILABLE') => { throw new DeviceError(message, code) }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const labelArgs = values => Object.entries(values).flatMap(([k, v]) => ['--label', k + '=' + v])
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
async function save(path, value, mode = 0o600) {
  const temp = path + '.' + randomUUID() + '.tmp';let fd
  try {
    fd = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode)
    await fd.writeFile(JSON.stringify(value));await fd.sync();await fd.close();fd = null
    await rename(temp, path)
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
    try { await directory.sync() } finally { await directory.close() }
  } finally { await fd?.close();await unlink(temp).catch(() => {}) }
}
async function read(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const info = await file.stat();if (!info.isFile() || info.size > 2 * 1024 * 1024) fail('设备记录无效，保留现场');return JSON.parse(await file.readFile('utf8')) }
  finally { await file.close() }
}

export class DeviceDockerHost {
  constructor({ stateRoot, deviceId, name, roots, image, uid = process.getuid(), gid = process.getgid(), onChange = () => {} }) {
    if (!validId(deviceId) || !Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1 || !Array.isArray(roots) || roots.length > 32) fail('设备配置无效')
    this.stateRoot = stateRoot;this.deviceId = deviceId;this.name = name;this.rootConfig = roots;this.uid = uid;this.gid = gid;this.onChange = onChange
    this.native = new DockerNodes({ stateRoot, schema: 'device_executor', image, uid, gid })
    this.owner = { 'mira-projects.owner': 'runtime-device-executor', 'mira-projects.state': stateRoot, 'mira-projects.device': deviceId }
    this.privateRoot = join(stateRoot, 'runtime-device-private', deviceId);this.jobs = new Map();this.tokens = new Map();this.queue = Promise.resolve();this.stopped = false
  }
  describe() { return { id: this.deviceId, name: String(this.name).slice(0, 100), roots: this.rootConfig.map(r => ({ id: r.id, label: String(r.label).slice(0, 100) })) } }
  containerName(requestId) { return 'mira-device-' + digest([this.stateRoot, this.deviceId, requestId]).slice(0, 32) }
  owned(value, requestId) {
    if (!value || Object.entries({ ...this.owner, 'mira-projects.device-request': digest(requestId) }).some(([k, v]) => value.Config?.Labels?.[k] !== v)) fail('同名设备执行不属于本请求，保持原样')
  }
  async initialize() {
    if (this.ready) return
    if (this.initializing) return this.initializing
    this.initializing = this.start().then(() => { this.ready = true })
    return this.initializing
  }
  async start() {
    if (process.platform !== 'linux') fail('设备隔离执行当前需要Linux；原生Mac执行尚未接入')
    await this.native.initialize()
    await mkdir(this.privateRoot, { recursive: true, mode: 0o700 })
    const info = await lstat(this.privateRoot)
    if (!info.isDirectory() || await realpath(this.privateRoot) !== this.privateRoot || info.uid !== this.uid || (info.mode & 0o077)) fail('设备状态目录不受保护')
    this.lockPath = join(this.privateRoot, 'host.lock')
    try { await mkdir(this.lockPath, { mode: 0o700 }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const old = await read(join(this.lockPath, 'owner.json'))
      try { process.kill(old.pid, 0);fail('本设备已有活跃监督进程') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await rm(this.lockPath, { recursive: true });await mkdir(this.lockPath, { mode: 0o700 })
    }
    this.instanceId = randomUUID()
    await save(join(this.lockPath, 'owner.json'), { pid: process.pid, instanceId: this.instanceId })
    try {
      await this.configureRoots()
      await this.recoverPending()
      const socketRoot = join(this.stateRoot, 'runtime-device-sockets');await mkdir(socketRoot, { recursive: true, mode: 0o700 })
      const socketInfo = await lstat(socketRoot)
      if (!socketInfo.isDirectory() || socketInfo.uid !== this.uid || (socketInfo.mode & 0o077) || await realpath(socketRoot) !== socketRoot) fail('设备socket目录不受保护')
      this.socketPath = join(socketRoot, digest(this.deviceId).slice(0, 20) + '.sock');await unlink(this.socketPath).catch(error => { if (error.code !== 'ENOENT') throw error })
      this.server = createServer(async (req, res) => {
        try {
          if (req.url !== '/health' || req.method !== 'POST') throw new Error('invalid')
          const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1], job = token ? this.tokens.get(digest(token)) : null
          if (!job || job.cancelled || this.stopped) throw new Error('cancelled')
          await job.assertCurrent()
          if (job.cancelled || this.stopped || Date.now() >= job.deadline) throw new Error('stopped')
          res.writeHead(200, { 'content-type': 'application/json' });res.end('{"valid":true}')
        } catch { req.resume();res.writeHead(403);res.end('{"valid":false}') }
      })
      this.server.requestTimeout = 2000;this.server.headersTimeout = 1000
      await new Promise((resolve, reject) => { this.server.once('error', reject);this.server.listen(this.socketPath, resolve) })
      // Parent directory is 0700. The root watchdog inside a bind mount needs
      // socket access; other host accounts cannot traverse its private parent.
      await chmod(this.socketPath, 0o666)
    } catch (error) { await this.unlock();throw error }
  }
  async recoverPending() {
    for (const filename of await readdir(this.privateRoot)) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue
      const path = join(this.privateRoot, filename), record = await read(path)
      if (!validId(record.requestId)) fail('设备意图身份无效，保留现场')
      if (record.stopped === true && ['completed', 'unknown'].includes(record.phase)) continue
      const value = await this.native.inspect('container', record.containerId ?? this.containerName(record.requestId))
      if (value) { this.owned(value, record.requestId);await this.stopContainer(value.Id, record.requestId) }
      await save(path, { ...record, phase: 'unknown', reason: 'RECOVERED_STOP', stopped: true })
      this.onChange({ state: 'recovered-stop', requestId: record.requestId })
    }
  }
  async assertStopped(requestIds) {
    await this.initialize()
    if (requestIds.some(id => this.jobs.has(id))) fail('设备操作仍在执行，不能确认本轮', 'EXECUTION_HELD')
    await this.recoverPending()
    for (const id of requestIds) {
      let record
      try { record = await read(join(this.privateRoot, digest(id) + '.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (record && record.stopped !== true) fail('设备操作尚未证实停止，不能确认本轮', 'EXECUTION_HELD')
    }
  }
  async bindControl(value) {
    await this.initialize()
    const path=join(this.privateRoot,'control.json');let previous
    try { previous=await read(path) } catch(error) { if(error.code!=='ENOENT') throw error }
    if(previous && JSON.stringify(previous)!==JSON.stringify(value)) fail('设备控制面已变化，需要明确迁移')
    if(!previous) await save(path,value)
  }
  async receipt(requestId) {
    await this.initialize()
    if(!validId(requestId)) fail('设备请求身份无效')
    try { const record=await read(join(this.privateRoot,digest(requestId)+'.json'));return {phase:record.phase,stopped:record.stopped===true,result:record.result??null} }
    catch(error) { if(error.code==='ENOENT') return null;throw error }
  }
  async executionState(intent) {
    if (!validId(intent.requestId)) fail('设备请求身份无效')
    const matches = body => body.projectId === intent.projectId && body.subject === intent.subject
      && body.grant?.id === intent.grantId && body.op === intent.op
    const job = this.jobs.get(intent.requestId)
    if (job) return matches(job.body)
      ? { phase: job.cancelled || this.stopped ? 'stopping' : job.phase ?? 'queued', stopped: false }
      : { phase: 'unconfirmed', stopped: false }
    // Validate the private directory without acquiring its execution lock or recovering containers.
    try {
      const info = await lstat(this.privateRoot)
      if (!info.isDirectory() || await realpath(this.privateRoot) !== this.privateRoot || info.uid !== this.uid || (info.mode & 0o077)) fail('设备状态尚未确认')
      const record = await read(join(this.privateRoot, digest(intent.requestId) + '.json'))
      if (record.requestId !== intent.requestId || record.projectId !== intent.projectId || record.subject !== intent.subject
        || record.grantId !== intent.grantId || record.op !== intent.op || record.stopped !== true) return { phase: 'unconfirmed', stopped: false }
      return { phase: 'stopped', stopped: true, outcome: record.phase === 'completed' && typeof record.result?.ok === 'boolean'
        ? record.result.ok ? 'ok' : 'error' : 'unknown' }
    } catch { return { phase: 'unconfirmed', stopped: false } }
  }
  async stopRequest(requestId) {
    await this.initialize()
    if(!validId(requestId)) fail('设备请求身份无效')
    const active=this.jobs.get(requestId)
    if(active){active.cancelled=true;await active.promise.catch(()=>{})}
    const path=join(this.privateRoot,digest(requestId)+'.json');let record
    try { record=await read(path) } catch(error) { if(error.code!=='ENOENT') throw error }
    const value=await this.native.inspect('container',record?.containerId??this.containerName(requestId))
    if(value){this.owned(value,requestId);await this.stopContainer(value.Id,requestId)}
    if(!record || record.stopped!==true){record={...(record??{requestId,fingerprint:null}),phase:'unknown',stopped:true,reason:'RECOVERED_STOP'};await save(path,record)}
    return {stopped:true}
  }
  async configureRoots() {
    const marker = join(this.privateRoot, 'roots.json');let old = { roots: [] }
    try { old = await read(marker) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const ids = new Set(), result = []
    for (const root of this.rootConfig) {
      if (!validId(root.id) || ids.has(root.id) || typeof root.path !== 'string' || !isAbsolute(root.path) || resolve(root.path) !== root.path || /[,\u0000-\u001f]/.test(root.path)) fail('设备目录配置无效')
      ids.add(root.id)
      const info = await lstat(root.path)
      if (!info.isDirectory() || await realpath(root.path) !== root.path || info.uid !== this.uid) fail('设备目录须为当前账户拥有的规范真实目录')
      let parent = dirname(root.path)
      while (true) {
        const p = await lstat(parent)
        if (!p.isDirectory() || p.isSymbolicLink() || (p.mode & 0o022)) fail('设备目录的父路径不能由其他账户改名')
        if (parent === '/') break
        parent = dirname(parent)
      }
      const previous = old.roots.find(r => r.id === root.id)
      if (previous && (previous.path !== root.path || previous.dev !== info.dev || previous.ino !== info.ino)) fail('已授权目录身份已变化，需要明确重新绑定新目录身份')
      result.push({ id: root.id, path: root.path, dev: info.dev, ino: info.ino })
    }
    for (const a of result) for (const b of result) if (a !== b && (a.path === b.path || a.path.startsWith(b.path + '/'))) fail('设备目录不能重叠')
    await save(marker, { roots: [...old.roots.filter(r => !ids.has(r.id)), ...result] });this.roots = new Map(result.map(r => [r.id, r]))
  }
  async root(grant) {
    const root = this.roots.get(grant.rootId)
    if (!root) fail('已授权设备目录不再可用')
    const info = await lstat(root.path)
    if (!info.isDirectory() || await realpath(root.path) !== root.path || info.dev !== root.dev || info.ino !== root.ino) fail('设备目录身份已变化')
    return root
  }
  async stopContainer(id, requestId) {
    const value = await this.native.inspect('container', id)
    if (!value) return { exists: false, running: false }
    this.owned(value, requestId)
    if (value.State.Running) {
      try { await this.native.docker(['kill', id]) } catch (error) { if ((await this.native.inspect('container', id))?.State.Running) throw error }
    }
    const stopped = await this.native.inspect('container', id)
    if (stopped?.State.Running) fail('设备执行尚未证实停止')
    return { exists: !!stopped, running: false, exitCode: stopped?.State.ExitCode ?? 137 }
  }
  async call({ projectId, subject, requestId, grant, op, args }, { assertCurrent } = {}) {
    if (!validId(requestId) || !validId(projectId) || typeof subject !== 'string' || !subject || typeof assertCurrent !== 'function' || !grant || grant.deviceId !== this.deviceId || !['fs.list','fs.read','fs.write','exec'].includes(op) || !args || typeof args !== 'object' || Array.isArray(args)) fail('设备操作身份无效', 'FORBIDDEN')
    const safeGrant = { id: grant.id, deviceId: grant.deviceId, rootId: grant.rootId, kind: grant.kind, access: grant.access, expiresAt: grant.expiresAt }
    if (!Number.isSafeInteger(grant.expiresAt) || (op === 'exec' ? grant.kind !== 'exec' : grant.kind !== 'folder') || (op === 'fs.write' && grant.access !== 'write')) fail('设备授权不允许这项操作', 'FORBIDDEN')
    if (grant.expiresAt <= Date.now()) fail('设备权限已过期', 'GRANT_EXPIRED')
    if (Buffer.byteLength(JSON.stringify(args)) > 256 * 1024) fail('设备操作请求过大', 'INVALID_INPUT')
    const timeout = args.timeoutMs ?? (op === 'exec' ? 10000 : 5000)
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60000) fail('设备操作超时上限无效', 'INVALID_INPUT')
    const body = { projectId, subject, requestId, grant: safeGrant, op, args }, fingerprint = digest(body)
    await this.initialize();await assertCurrent()
    if (this.stopped) fail('设备监督者正在停止')
    const active = this.jobs.get(requestId)
    if (active) { if (active.fingerprint !== fingerprint) fail('相同设备请求内容不同', 'IDEMPOTENCY_CONFLICT');return active.promise }
    const job = { body, requestId, fingerprint, assertCurrent, deadline: Math.min(Date.now() + DEVICE_PREPARATION_MS + timeout, grant.expiresAt), cancelled: false, id: null, phase: 'queued' }
    const task = this.queue.then(() => this.execute(job))
    job.promise = task.finally(() => this.jobs.delete(requestId));this.jobs.set(requestId, job);this.queue = job.promise.catch(() => {})
    return job.promise
  }
  async execute(job) {
    job.phase = 'starting'
    const { body, requestId } = job, recordFile = join(this.privateRoot, digest(requestId) + '.json')
    await job.assertCurrent()
    if (job.cancelled || this.stopped || Date.now() >= job.deadline) fail('设备请求在执行前已失效', 'GRANT_EXPIRED')
    let old
    try { old = await read(recordFile) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (old) {
      if (old.fingerprint !== job.fingerprint) fail('相同设备请求内容不同', 'IDEMPOTENCY_CONFLICT')
      if (old.phase !== 'completed') fail('设备操作结果未确认；不会自动重试，请先查看实际文件或任务状态', 'DEVICE_UNKNOWN')
      await job.assertCurrent()
      if (!old.result.ok) fail('设备操作未完成：' + old.result.code, old.result.code)
      return old.result.value
    }
    await this.recoverPending()
    const root = await this.root(body.grant)
    const record = { requestId, projectId: body.projectId, subject: body.subject, fingerprint: job.fingerprint, phase: 'prepared', at: Date.now(), grantId: body.grant.id, op: body.op }
    await save(recordFile, record)
    const healthToken = randomBytes(32).toString('base64url'), payload = join(this.privateRoot, digest(requestId) + '.request')
    this.tokens.set(digest(healthToken), job)
    let result, stopped = false, recorded = false
    try {
      await save(payload, { ...body, uid: this.uid, gid: this.gid, healthToken }, 0o444)
      await job.assertCurrent();await this.root(body.grant)
      const labels = { ...this.owner, 'mira-projects.device-request': digest(requestId) }, readonly = body.op === 'fs.list' || body.op === 'fs.read'
      job.id = await this.native.docker(['create', '--name', this.containerName(requestId), ...labelArgs(labels),
        '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges',
        '--memory', '512m', '--cpus', '0.5', '--pids-limit', '64', '--user', '0:0', '--workdir', '/tmp', '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864',
        '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2',
        '--mount', 'type=bind,src=' + root.path + ',dst=/device' + (readonly ? ',readonly' : ''),
        '--mount', 'type=bind,src=' + payload + ',dst=/request.json,readonly',
        '--mount', 'type=bind,src=' + this.socketPath + ',dst=/run/mira/control.sock,readonly',
        '--entrypoint', 'node', this.native.image, '/opt/mira/plugin/lib/runtime/device-guard.js'])
      if (!/^[0-9a-f]{64}$/.test(job.id)) fail('设备执行返回了无效身份')
      const created = await this.native.inspect('container', job.id);this.owned(created, requestId)
      if (created.HostConfig.NetworkMode !== 'none' || !created.HostConfig.ReadonlyRootfs || created.Config.User !== '0:0' || created.Mounts.length !== 3
        || created.Mounts.find(m => m.Destination === '/device')?.RW !== !readonly
        || created.Mounts.find(m => m.Destination === '/request.json')?.RW !== false
        || created.Mounts.find(m => m.Destination === '/run/mira/control.sock')?.RW !== false) fail('设备容器边界与请求不符')
      await this.root(body.grant);await job.assertCurrent()
      await save(recordFile, { ...record, phase: 'starting', containerId: job.id })
      await this.native.docker(['start', job.id])
      job.phase = 'running'
      this.onChange({ state: 'running', requestId, containerId: job.id, op: body.op })
      while (true) {
        await job.assertCurrent()
        if (job.cancelled || this.stopped || Date.now() >= job.deadline) fail('设备操作已取消或超时', 'DEVICE_CANCELLED')
        const value = await this.native.inspect('container', job.id)
        if (!value) fail('设备执行身份意外丢失', 'DEVICE_UNKNOWN')
        this.owned(value, requestId)
        if (!value.State.Running) {
          stopped = true
          if (value.State.ExitCode === 72) fail('设备命令已到执行时限', 'DEVICE_CANCELLED')
          if (value.State.ExitCode !== 0) fail('设备执行未正常结束', 'DEVICE_UNKNOWN')
          const raw = await this.native.docker(['logs', job.id])
          try { result = JSON.parse(raw) } catch { fail('设备执行没有可验证结果', 'DEVICE_UNKNOWN') }
          if (typeof result.ok !== 'boolean' || (result.ok && result.uid !== this.uid)) fail('设备执行身份或结果不符', 'DEVICE_UNKNOWN')
          break
        }
        await pause(100)
      }
      await job.assertCurrent()
      await save(recordFile, { ...record, phase: 'completed', stopped: true, containerId: job.id, result });recorded = true
      this.onChange({ state: 'complete', requestId, containerId: job.id, stopped: true })
      if (!result.ok) fail('设备操作未完成：' + result.code, result.code)
      return result.value
    } catch (error) {
      // The create response may have been lost. Find by stable name, verify
      // ownership, stop its immutable id, and retain an unknown outcome.
      const value = await this.native.inspect('container', job.id ?? this.containerName(requestId))
      if (value) { this.owned(value, requestId);job.id = value.Id;await this.stopContainer(job.id, requestId) }
      stopped = true
      const operation = /^Owned Docker operation failed: (create|start|container|logs|image)$/.exec(error?.message ?? '')?.[1]
      const failureCode = /^[A-Z][A-Z_]{1,64}$/.test(error?.code ?? '') ? error.code : undefined
      const failureSite = String(error?.stack ?? '').split('\n').map(line => /\/lib\/runtime\/([a-z-]+\.js):(\d+):/.exec(line)).find(Boolean)
      if (!recorded) await save(recordFile, { ...record, phase: 'unknown', stopped: true, ...(job.id ? { containerId: job.id } : {}),
        reason: error instanceof DeviceError ? error.code : 'DEVICE_IO', ...(operation ? { failedDockerOperation: operation } : {}),
        ...(failureCode ? { failureCode } : {}), ...(failureSite ? { failureSite: failureSite[1] + ':' + failureSite[2] } : {}) })
      this.onChange({ state: 'device-operation-stopped', requestId, stopped: true,
        code: error instanceof DeviceError ? error.code : 'DEVICE_IO', ...(operation ? { failedDockerOperation: operation } : {}) })
      throw error instanceof DeviceError ? error : new DeviceError('设备操作未确认，原请求不会自动重跑', 'DEVICE_UNKNOWN')
    } finally {
      this.tokens.delete(digest(healthToken));await unlink(payload).catch(() => {})
      if (job.id && stopped) await this.native.docker(['rm', job.id]).catch(() => {})
    }
  }
  async unlock() {
    if (!this.lockPath) return
    try { if ((await read(join(this.lockPath, 'owner.json'))).instanceId === this.instanceId) await rm(this.lockPath, { recursive: true }) } catch { /* preserve unknown ownership */ }
  }
  async close() {
    this.stopped = true
    for (const job of this.jobs.values()) job.cancelled = true
    await Promise.allSettled([...this.jobs.values()].map(j => j.promise))
    if (this.server) { this.server.closeAllConnections();await new Promise(resolve => this.server.close(resolve));await unlink(this.socketPath).catch(() => {}) }
    await this.unlock()
  }
}
