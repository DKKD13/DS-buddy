/** Outbound trusted node agent. Only this process has the node credential. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { DockerNodes } from './containers.js'
import { NodeEndpoint } from './node-endpoint.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export class RemoteContainerNode {
  constructor({ endpoint, ca, credential, nodeId, stateRoot, image, concurrency = 2, maxRunMs = 600000, onChange = () => {} }) {
    if (!/^n_[0-9a-f]{32}$/.test(nodeId)) throw new Error('Expected provisioned node identity')
    this.endpoint = new NodeEndpoint({ url: endpoint, ca, credential });this.nodeId = nodeId;this.stateRoot = stateRoot;this.image = image
    this.concurrency = concurrency;this.maxRunMs = maxRunMs;this.onChange = onChange
    this.instanceId = randomUUID();this.jobs = new Map();this.tasks = new Set();this.stopRequested = false;this.online = false
  }
  async lock() {
    this.privateRoot = this.stateRoot + '/runtime-node-private'
    await mkdir(this.privateRoot, { recursive: true, mode: 0o700 })
    this.lockPath = this.privateRoot + '/' + this.nodeId + '.lock'
    try { await mkdir(this.lockPath, { mode: 0o700 }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      let old
      try { old = JSON.parse(await readFile(this.lockPath + '/owner.json', 'utf8')) } catch { throw new Error('Node lock has no valid owner; kept unchanged') }
      try { process.kill(old.pid, 0);throw new Error('A local supervisor still owns this node') }
      catch (failure) { if (failure.code !== 'ESRCH') throw failure }
      await rm(this.lockPath, { recursive: true });await mkdir(this.lockPath, { mode: 0o700 })
    }
    await writeFile(this.lockPath + '/owner.json', JSON.stringify({ pid: process.pid, instanceId: this.instanceId }), { mode: 0o600 })
  }
  async unlock() {
    if (!this.lockPath) return
    try { if (JSON.parse(await readFile(this.lockPath + '/owner.json', 'utf8')).instanceId === this.instanceId) await rm(this.lockPath, { recursive: true }) } catch { /* another owner or an externally removed lock is preserved */ }
  }
  async configureDocker(schema) {
    if (this.docker) {
      if (this.schema !== schema) throw new Error('Control schema changed; explicit migration required')
      return
    }
    this.schema = schema
    this.docker = new DockerNodes({ stateRoot: this.stateRoot, schema, image: this.image, nodeId: this.nodeId })
    await this.docker.initialize()
  }
  async recover() {
    const recovery = await this.endpoint.rpc({ op: 'recovery' })
    if (recovery.nodeId !== this.nodeId) throw new Error('Node configuration identity does not match credential')
    if (recovery.connected && recovery.instanceId !== this.instanceId) throw Object.assign(new Error('Another supervisor connection is still active'), { code: 'NODE_BUSY' })
    await this.configureDocker(recovery.schema)
    for (const run of recovery.runs) {
      const execution = await this.docker.find(run, { allowOlderStopped: true })
      if (run.containerId && (!execution || execution.id !== run.containerId)) {
        // An absent immutable id is also a stop proof; never kill by a reused name.
        const old = await this.docker.inspect('container', run.containerId)
        if (old) throw new Error('Registered container differs from the target name; explicit recovery required')
      }
      if (execution) await this.docker.stop(execution, run)
      const proof = execution ? await this.docker.state(execution, run) : null
      if (proof?.running) throw new Error('Old node container is still running')
      await this.endpoint.rpc({ op: 'stopped', runId: run.runId, running: false,
        ...(execution ? { containerId: execution.id, exitCode: proof.exitCode } : run.containerId ? { containerId: run.containerId, exitCode: 137 } : { neverStarted: true }) })
      this.onChange({ state: 'recovered-stop', nodeId: this.nodeId, runId: run.runId, containerId: execution?.id ?? run.containerId })
    }
    if (recovery.revoked) throw Object.assign(new Error('Node authorization was revoked'), { code: 'FORBIDDEN' })
  }
  async runJob(ticket) {
    const job = { ticket, execution: null, relay: null, cancelled: false }
    this.jobs.set(ticket.runId, job)
    const safe = { nodeId: this.nodeId, runId: ticket.runId, projectId: ticket.projectId, key: ticket.key, sessionId: ticket.sessionId }
    try {
      job.relay = await this.endpoint.relay(this.privateRoot + '/r-' + randomUUID().slice(0, 8) + '.sock', ticket.jobToken)
      job.execution = await this.docker.start(ticket, { socketPath: job.relay.socketPath, token: ticket.jobToken, assertLease: async () => {
        if (!this.online || this.stopRequested || job.cancelled) throw new Error('Node connection is stopping')
        await this.endpoint.rpc({ op: 'validate', epoch: this.connection.epoch, runId: ticket.runId })
      } })
      await this.endpoint.rpc({ op: 'started', epoch: this.connection.epoch, runId: ticket.runId, containerId: job.execution.id })
      this.onChange({ state: 'running', ...safe, execution: job.execution })
      const deadline = Date.now() + this.maxRunMs
      let proof
      while (true) {
        if (!this.online || this.stopRequested || job.cancelled || Date.now() >= deadline) throw new Error('Node connection lost, execution cancelled, or deadline reached')
        proof = await this.docker.state(job.execution, ticket)
        if (!proof.exists || !proof.running) break
        await sleep(250)
      }
      const result = await this.endpoint.rpc({ op: 'stopped', runId: ticket.runId, containerId: job.execution.id, running: false, exitCode: proof.exitCode ?? 137 })
      this.onChange({ ...safe, state: result.state, execution: job.execution, stopProof: proof, cursor: result.cursor })
      return result
    } catch (error) {
      if(error.code==='EXECUTION_HELD')this.online=false
      // Close the only worker route, kill its immutable Docker id, then attempt
      // stop reporting. If reporting fails, the durable hold stays in control.
      if (job.relay) { await job.relay.close();job.relay = null }
      const execution = job.execution ?? await this.docker.find(ticket, { allowOlderStopped: true })
      if (execution) await this.docker.stop(execution, ticket)
      const proof = execution ? await this.docker.state(execution, ticket) : null
      try { await this.endpoint.rpc({ op: 'stopped', runId: ticket.runId, running: false,
        ...(execution ? { containerId: execution.id, exitCode: proof.exitCode } : { neverStarted: true }) }) } catch (failure) { if(failure.code==='EXECUTION_HELD')this.online=false;/* recovery must confirm this exact run before reassignment */ }
      this.onChange({ state: 'failed', ...safe, execution, stopProof: proof, error: error.message })
      throw error
    } finally {
      if (job.relay) await job.relay.close()
      this.jobs.delete(ticket.runId)
    }
  }
  async heartbeat() {
    if (this.heartbeating || !this.online) return
    this.heartbeating = true
    try {
      const reply = await this.endpoint.rpc({ op: 'heartbeat', epoch: this.connection.epoch })
      for (const runId of reply.lostRuns) { const job = this.jobs.get(runId);if (job) job.cancelled = true }
    } catch { this.online = false }
    finally { this.heartbeating = false }
  }
  async run() {
    await this.lock()
    try {
      while (!this.stopRequested) {
        try {
          await this.recover()
          this.connection = await this.endpoint.rpc({ op: 'connect', instanceId: this.instanceId })
        } catch (error) {
          if (!['NETWORK', 'NODE_BUSY', 'NODE_OFFLINE', 'RECOVERY_REQUIRED', 'EXECUTION_HELD'].includes(error.code)) throw error
          this.onChange({ state: 'waiting-connection', nodeId: this.nodeId, error: error.message })
          await sleep(1000);continue
        }
        await this.configureDocker(this.connection.schema)
        this.online = true
        this.onChange({ state: 'connected', nodeId: this.nodeId, epoch: this.connection.epoch })
        this.heartbeatTimer = setInterval(() => { if (!this.heartbeating) this.heartbeatPromise = this.heartbeat() }, Math.max(50, Math.floor(Math.min(this.connection.connectionMs, this.connection.leaseMs) / 3)))
        let index = 0
        try {
          while (this.online && !this.stopRequested) {
            if (this.tasks.size < this.concurrency && this.connection.projects.length) {
              const projectId = this.connection.projects[index++ % this.connection.projects.length]
              const ticket = await this.endpoint.rpc({ op: 'claim', epoch: this.connection.epoch, projectId, requestId: randomUUID() })
              if (ticket) {
                if (!this.online || this.stopRequested) { await this.endpoint.rpc({ op: 'stopped', runId: ticket.runId, running: false, neverStarted: true });break }
                const task = this.runJob(ticket).catch(() => {}).finally(() => this.tasks.delete(task))
                this.tasks.add(task)
              }
            }
            await sleep(250)
          }
        } catch (error) { this.online = false;this.onChange({ state: 'disconnected', nodeId: this.nodeId, error: error.message }) }
        finally {
          this.online = false;clearInterval(this.heartbeatTimer);await this.heartbeatPromise
          await Promise.allSettled([...this.tasks])
        }
        if (!this.stopRequested) await sleep(1000)
      }
    } finally { this.online = false;clearInterval(this.heartbeatTimer);await this.unlock() }
  }
  async stop() {
    this.stopRequested = true;this.online = false;clearInterval(this.heartbeatTimer)
    for (const job of this.jobs.values()) job.cancelled = true
    await Promise.allSettled([...this.tasks])
  }
}
