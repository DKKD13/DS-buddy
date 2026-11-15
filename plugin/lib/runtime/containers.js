/** Docker lifecycle boundary: no model gets this API or the Docker socket. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { realpath, stat, writeFile, unlink, mkdir } from 'node:fs/promises'

const exec = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 20)
const argsFor = labels => Object.entries(labels).flatMap(([key, value]) => ['--label', key + '=' + value])
const nativeError = message => { throw new Error(message) }

export class DockerNodes {
  constructor({ stateRoot, schema, image, uid = process.getuid(), gid = process.getgid(), nodeId }) {
    this.stateRoot = stateRoot;this.schema = schema;this.image = image;this.uid = uid;this.gid = gid
    this.owner = { 'mira-projects.owner': 'runtime-container-node', 'mira-projects.state': stateRoot, 'mira-projects.schema': schema }
    if (nodeId) this.owner['mira-projects.node-id'] = nodeId
    this.namespace = hash(stateRoot + '/' + schema + (nodeId ? '/' + nodeId : ''))
  }

  async docker(args, { timeout = 30000, missing = false } = {}) {
    try { return (await exec('docker', this.daemon ? ['--host', this.daemon, ...args] : args, { timeout, maxBuffer: 4 * 1024 * 1024,
      ...(this.daemon ? { env: { ...process.env, DOCKER_HOST: this.daemon, DOCKER_CONTEXT: '' } } : {}) })).stdout.trim() }
    catch (error) {
      if (missing && /no such|not found/i.test(error.stderr ?? '')) {
        await this.docker(['version', '--format', '{{.Server.Version}}'])
        return null
      }
      // Inspect and create commands may contain scoped credentials. Never
      // propagate execFile's command, stdout, stderr or environment in errors.
      throw new Error('Owned Docker operation failed: ' + args[0])
    }
  }

  async inspect(kind, name) {
    const result = await this.docker([kind, 'inspect', name], { missing: true })
    return result === null ? null : JSON.parse(result)[0]
  }

  owned(value, target, fence) {
    if (!value) nativeError('Expected Docker object is missing')
    const labels = (value.Config?.Labels ?? value.Labels) || {}
    const wanted = { ...this.owner, 'mira-projects.target': target, ...(fence ? { 'mira-projects.fence': fence } : {}) }
    if (Object.entries(wanted).some(([key, expected]) => labels[key] !== expected)) nativeError('Docker object ownership does not match; kept unchanged')
  }

  target(lease) { return hash(lease.projectId + '/' + lease.key) }
  volume(lease) { return 'mira-work-' + this.namespace + '-' + this.target(lease) }
  name(lease) { return 'mira-node-' + this.namespace + '-' + this.target(lease) }

  async initialize() {
    if (await realpath(this.stateRoot) !== this.stateRoot) nativeError('Runtime state path must be canonical')
    const endpoint = JSON.parse(await this.docker(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']))
    if (!endpoint.startsWith('unix://') || (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://'))) nativeError('Only a local Unix Docker daemon is supported')
    this.daemon = endpoint
    const image = await this.inspect('image', this.image)
    if (!image || image.Config?.Labels?.['mira-projects.owner'] !== 'k1-runtime-node' || image.Config?.Labels?.['mira-projects.state'] !== this.stateRoot || image.Config?.User !== `${this.uid}:${this.gid}`) nativeError('Runtime image is not the expected owned non-root image')
    this.image = image.Id
    this.privateRoot = this.stateRoot + '/runtime-node-private'
    await mkdir(this.privateRoot, { mode: 0o700, recursive: true })
  }

  async start(lease, { socketPath, token, assertLease }) {
    const target = this.target(lease), name = this.name(lease), volume = this.volume(lease)
    if (!/^[1-9]\d{0,18}$/.test(lease.fence)) nativeError('Invalid execution fence')
    if (await realpath(socketPath) !== socketPath || !(await stat(socketPath)).isSocket() || (await stat(socketPath)).uid !== this.uid) nativeError('Expected owned gateway socket')
    await assertLease()
    const old = await this.inspect('container', name)
    if (old) {
      this.owned(old, target)
      const oldFence = old.Config.Labels['mira-projects.fence']
      if (!/^[1-9]\d{0,18}$/.test(oldFence) || BigInt(oldFence) >= BigInt(lease.fence)) nativeError('Same or newer execution already owns this target')
      // Remove by immutable id, never by name: a delayed old supervisor cannot
      // accidentally stop a replacement that reuses the stable target name.
      await assertLease();await this.docker(['rm', '--force', old.Id])
    }
    let data = await this.inspect('volume', volume)
    if (data) this.owned(data, target)
    else {
      await this.docker(['volume', 'create', ...argsFor({ ...this.owner, 'mira-projects.target': target }), volume])
      data = await this.inspect('volume', volume);this.owned(data, target)
    }
    const envFile = this.privateRoot + '/' + randomUUID() + '.env'
    await writeFile(envFile, 'MIRA_NODE_CAPABILITY=' + token + '\nMIRA_NODE_SOCKET=/run/mira/control.sock\n', { mode: 0o600, flag: 'wx' })
    let id
    try {
      await assertLease()
      id = await this.docker(['create', '--name', name, ...argsFor({ ...this.owner, 'mira-projects.target': target, 'mira-projects.fence': lease.fence }),
        '--init', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--memory', '1g', '--cpus', '1', '--pids-limit', '128', '--shm-size', '16m', '--user', `${this.uid}:${this.gid}`,
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=134217728', '--env-file', envFile,
        '--mount', 'type=volume,src=' + volume + ',dst=/workspace',
        '--mount', 'type=bind,src=' + socketPath + ',dst=/run/mira/control.sock,readonly', this.image])
      if (!/^[0-9a-f]{64}$/.test(id)) nativeError('Docker returned an invalid container id')
      const created = await this.inspect('container', id);this.owned(created, target, lease.fence)
      if (created.HostConfig.NetworkMode !== 'none' || !created.HostConfig.ReadonlyRootfs || created.Config.User !== `${this.uid}:${this.gid}` || created.Mounts.length !== 2 || created.Mounts.find(m => m.Destination === '/run/mira/control.sock')?.RW !== false) nativeError('Container isolation differs from the requested boundary')
      await assertLease();await this.docker(['start', id]);await assertLease()
      return { id, name, volume, target, fence: lease.fence }
    } catch (error) {
      if (id && /^[0-9a-f]{64}$/.test(id)) await this.docker(['rm', '--force', id]).catch(() => {})
      throw error
    } finally { await unlink(envFile).catch(() => {}) }
  }

  async stop(execution, lease) {
    const value = await this.inspect('container', execution.id)
    if (!value) return
    this.owned(value, this.target(lease), lease.fence)
    if (value.State.Running) {
      try { await this.docker(['kill', execution.id]) }
      catch (error) { if ((await this.inspect('container', execution.id))?.State.Running) throw error }
    }
    const stopped = await this.inspect('container', execution.id)
    if (stopped?.State.Running) nativeError('Old container has not stopped')
  }

  async find(lease, { allowOlderStopped = false } = {}) {
    const value = await this.inspect('container', this.name(lease))
    if (!value) return null
    this.owned(value, this.target(lease))
    const fence = value.Config.Labels['mira-projects.fence']
    if (allowOlderStopped && /^[1-9]\d{0,18}$/.test(fence ?? '') && BigInt(fence) < BigInt(lease.fence) && !value.State.Running) return null
    this.owned(value, this.target(lease), lease.fence)
    return { id: value.Id, name: this.name(lease), target: this.target(lease), fence: lease.fence, volume: this.volume(lease) }
  }

  async state(execution, lease) {
    const value = await this.inspect('container', execution.id)
    if (!value) return { exists: false, running: false }
    this.owned(value, this.target(lease), lease.fence)
    return { exists: true, running: value.State.Running, exitCode: value.State.ExitCode, oomKilled: value.State.OOMKilled,
      network: value.HostConfig.NetworkMode, readOnlyRoot: value.HostConfig.ReadonlyRootfs, user: value.Config.User }
  }

  async readFile(lease, path) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) nativeError('Expected a relative workspace file path')
    const volume = await this.inspect('volume', this.volume(lease));this.owned(volume, this.target(lease))
    const script = `const f=require('node:fs'),p=require('node:path');const root='/workspace/project',file=f.realpathSync(p.resolve(root,process.argv[1]));if(!file.startsWith(root+'/'))throw Error('outside workspace');const s=f.statSync(file);if(!s.isFile()||s.size>1048576)throw Error('not a bounded regular file');process.stdout.write(f.readFileSync(file).toString('base64'))`
    return Buffer.from(await this.docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '0.25', '--pids-limit', '32',
      ...argsFor({ ...this.owner, 'mira-projects.target': this.target(lease), 'mira-projects.helper': 'read-file' }),
      '--mount', 'type=volume,src=' + this.volume(lease) + ',dst=/workspace,readonly', '--entrypoint', 'node', this.image, '-e', script, path], { timeout: 10000 }), 'base64')
  }
}
