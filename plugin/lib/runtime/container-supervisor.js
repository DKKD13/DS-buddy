/** Trusted node supervisor: container stop proof precedes cursor confirmation. */
import { randomUUID } from 'node:crypto'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export class ContainerSupervisor {
  constructor(control, gateway, docker, { owner = 'docker-' + randomUUID(), labels = ['os:linux'], leaseMs = 30000, maxRunMs = 600000, concurrency = 2, onChange = () => {} } = {}) {
    this.control = control;this.runtime = control.runtime;this.gateway = gateway;this.docker = docker
    this.owner = owner;this.labels = labels;this.leaseMs = leaseMs;this.maxRunMs = maxRunMs;this.concurrency = concurrency;this.onChange = onChange
    this.tasks = new Set();this.active = new Set();this.stopped = false
  }

  async run(lease) {
    const project = (await this.control.snapshot(lease.projectId)).get(lease.projectId), old = project.sessions.get(lease.key)
    const resume = !!old && project.events.some(e => e.type === 'session.ready' && e.sessionId === old.sessionId && e.key === lease.key)
    const sessionId = resume ? old.sessionId : 'session-' + randomUUID()
    await this.control.submit(lease.projectId, { kind: 'host' }, { op: 'bindSession', sessionId }, { requestId: 'bind-' + randomUUID(), lease })
    const { token, entry } = this.gateway.issue(lease, sessionId, { resume })
    const job = { lease, sessionId, entry, execution: null, lost: false, stopping: false }
    this.active.add(job)
    let renewal = Promise.resolve(), timer
    const renew = () => {
      renewal = renewal.then(async () => {
        if (job.lost || job.stopping) return
        try { entry.lease = job.lease = await this.runtime.heartbeat(job.lease, { leaseMs: this.leaseMs }) }
        catch { job.lost = true;this.gateway.revoke(entry) }
      })
    }
    timer = setInterval(renew, Math.max(25, Math.floor(this.leaseMs / 3)))
    try {
      if (this.stopped) throw new Error('Container supervisor is stopping')
      job.execution = await this.docker.start(lease, { token, socketPath: this.gateway.socketPath, assertLease: () => this.gateway.authorize(entry) })
      this.onChange({ state: 'running', projectId: lease.projectId, key: lease.key, sessionId, execution: job.execution })
      const deadline = Date.now() + this.maxRunMs
      let state
      while (true) {
        if (this.stopped || job.lost) throw new Error('Container execution stopped or lost its lease')
        state = await this.docker.state(job.execution, lease)
        if (!state.exists || !state.running) break
        if (Date.now() >= deadline) throw new Error('Container execution reached its deadline')
        await sleep(250)
      }
      if (!state.exists || state.exitCode !== 0 || state.oomKilled || !entry.completed) throw new Error('Container did not complete a normal DSH wake')
      // Revoke first, await all renewal work, and only then atomically ack. A
      // reply or a node's /complete response alone is not stop confirmation.
      this.gateway.revoke(entry);job.stopping = true;clearInterval(timer);await renewal
      if (job.lost || this.stopped) throw new Error('Lease lost before container completion')
      const result = await this.runtime.finish(job.lease, { turn: { sessionId, ...entry.completed } })
      this.onChange({ state: 'complete', projectId: lease.projectId, key: lease.key, sessionId, execution: job.execution, stopProof: state, cursor: result.cursor })
      return { ...result, execution: job.execution, stopProof: state }
    } catch (error) {
      this.gateway.revoke(entry);job.stopping = true;clearInterval(timer);await renewal
      // Never release a live target before Docker confirms its processes died.
      if (job.execution) await this.docker.stop(job.execution, lease)
      try { await this.runtime.retry(job.lease, { delayMs: 5000 }) } catch { /* an expired fence or committed completion owns recovery */ }
      this.onChange({ state: 'failed', projectId: lease.projectId, key: lease.key, sessionId, execution: job.execution,
        stopProof: job.execution ? await this.docker.state(job.execution, lease) : null, modelCalls: entry.modelCalls, error: error.message })
      throw error
    } finally { clearInterval(timer);this.active.delete(job) }
  }

  async tick() {
    if (this.stopped || this.polling) return
    this.polling = true
    try {
      while (!this.stopped && this.tasks.size < this.concurrency) {
        const lease = await this.runtime.claim({ owner: this.owner, labels: this.labels, leaseMs: this.leaseMs })
        if (!lease) break
        if (this.stopped) { await this.runtime.retry(lease);break }
        const task = this.run(lease).catch(() => {}).finally(() => this.tasks.delete(task))
        this.tasks.add(task)
      }
    } finally { this.polling = false }
  }

  start() {
    this.timer = setInterval(() => {
      if (!this.polling) this.pollPromise = this.tick().catch(error => this.onChange({ state: 'poll-failed', error: error.message }))
    }, 250)
  }

  async stop() {
    this.stopped = true;clearInterval(this.timer)
    for (const job of this.active) this.gateway.revoke(job.entry)
    await this.pollPromise;await Promise.allSettled([...this.tasks])
  }
}
