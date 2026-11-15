/** DSH host for the Postgres lab. Only project platform tools are executable. */
import { createHash, randomUUID } from 'node:crypto'
import { createTools, visibleTo } from '../tools.js'
import { rolePrompt, wakeText, continuityNotice, NUDGE, UNANSWERED } from '../protocol.js'

export class PostgresSessionHost {
  constructor(ctx, control, { defineTool, makeMessage, owner = 'dsh-' + randomUUID(), labels = ['os:linux'], leaseMs = 30000, concurrency = 4 } = {}) {
    this.ctx = ctx;this.control = control;this.runtime = control.runtime
    this.defineTool = defineTool;this.makeMessage = makeMessage;this.owner = owner;this.labels = labels
    this.leaseMs = leaseMs;this.concurrency = concurrency
    this.slots = new Map();this.tasks = new Set();this.targets = new Set();this.controller = null;this.stopped = false
    this.preset = 'mira-postgres-platform';this.presetReady = false
  }

  register(agent) {
    const slot = this.slots.get(agent.id)
    if (!slot || slot.registered) return
    const { store, lease } = slot, project = store.get(lease.projectId)
    const defs = createTools({ defineTool: d => d, store, driver: {}, actions: {}, files: this.control.blobs ? {} : null, devices: this.control.devices ? {} : null })
      .filter(t => visibleTo(store, t.role)({ agent }))
    const allowed = new Set(defs.map(t => t.definition.name))
    // Native tools could bypass the event log and fences. Until execution is
    // containerized, both their model visibility and actual dispatch are denied.
    const native = this.ctx.tools.schemas().map(t => t.name).filter(name => name !== 'run_code')
    if (native.length) agent.ctx.tools.restrict({ deny: native })
    agent.ctx.tools.presentAs('native')
    agent.ctx.tools.guard(exec => {
      const current = this.slots.get(agent.id)
      return current !== slot || slot.lost || this.stopped || !allowed.has(exec.name) ? '运行时会话只允许当前认领的项目平台工具' : undefined
    })
    for (const { definition } of defs) {
      agent.ctx.tools.register(this.defineTool({ ...definition, execute: async (args, exec) => {
        const requestId = 'tool-' + createHash('sha256').update(agent.id + '/' + exec.callId).digest('hex')
        if (definition.name === 'inbox_read') return (await this.control.inbox(slot.lease, agent.id, { ...args, requestId })).text
        const saved = await this.control.submit(lease.projectId, { kind: 'session', sessionId: agent.id },
          { op: 'tool', tool: definition.name, args }, { requestId, lease: slot.lease, signal: exec.signal })
        const value = saved.value
        slot.platform ||= value.platform;slot.replied ||= value.replied
        if (value.concluded) exec.concludeTurn?.()
        return value.result
      } }))
    }
    agent.ctx.systemPrompt.section({ name: 'mira-projects:postgres-role', order: 10100, interpolate: false, text: rolePrompt(project, lease.key) })
    agent.ctx.on('agent/error', ({ error }) => { slot.failed = error || new Error('DSH turn failed') })
    slot.allowed = allowed
    slot.registered = true
  }

  observe(session, event) {
    const slot = this.slots.get(session.id)
    if (slot && event.type === 'turn/end') slot.lastEnd = event.data.reason.kind
  }

  async poll() {
    if (this.polling || this.stopped || !this.controller || !this.presetReady) return
    this.polling = true
    try {
      while (!this.stopped && this.tasks.size < this.concurrency) {
        const lease = await this.runtime.claim({ owner: this.owner, labels: this.labels, leaseMs: this.leaseMs })
        if (!lease) break
        if (this.stopped) { await this.runtime.retry(lease);break }
        const target = lease.projectId + '/' + lease.key
        if (this.targets.has(target)) { await this.runtime.retry(lease, { delayMs: 1000 });break }
        this.targets.add(target)
        const task = this.run(lease).catch(error => this.ctx.logger.warn('mira runtime: host turn failed', error))
          .finally(() => { this.tasks.delete(task);this.targets.delete(target) })
        this.tasks.add(task)
      }
    } catch (error) { this.ctx.logger.warn('mira runtime: poll failed', error) }
    finally { this.polling = false }
  }

  async run(lease) {
    const sessionId = 'session-' + randomUUID(), slot = { lease, sessionId, lost: false, platform: false, replied: false, failed: null }
    this.slots.set(sessionId, slot)
    let timer, renewal = Promise.resolve(), agent
    const renew = () => {
      renewal = renewal.then(async () => {
        if (slot.lost) return
        try { slot.lease = await this.runtime.heartbeat(slot.lease, { leaseMs: this.leaseMs }) }
        catch (error) { slot.lost = true;slot.failed = error;agent?.cancel({ kind: 'hook', reason: 'runtime lease lost' }) }
      })
    }
    timer = setInterval(renew, Math.max(25, Math.floor(this.leaseMs / 3)))
    try {
      await this.control.submit(lease.projectId, { kind: 'host' }, { op: 'bindSession', sessionId }, { requestId: 'bind-' + randomUUID(), lease: slot.lease })
      slot.store = await this.control.snapshot(lease.projectId)
      const project = slot.store.get(lease.projectId)
      const created = await this.controller.create({ sessionId, agentPreset: this.preset })
      if (created.sessionId !== sessionId) throw new Error('DSH did not honor the prebound session id')
      const resolved = await this.controller.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error
      agent = slot.agent = resolved.agent
      this.register(agent)
      if (slot.allowed) {
        const unexpected = agent.ctx.tools.schemas().map(t => t.name).filter(name => !slot.allowed.has(name))
        if (unexpected.length) throw new Error('DSH preset exposes tools outside the project platform: ' + unexpected.join(', '))
      }
      if (slot.lost || this.stopped) throw new Error('Host stopped before delivery')
      const unread = slot.store.unread(project, lease.key)
      const addressed = unread.some(e => e.type === 'message.posted' && e.author?.kind === 'human' && e.to?.includes(lease.key))
      const continuity = project.sessions.get(lease.key)?.continuity ? continuityNotice(project, lease.key) : ''
      const deliver = async text => {
        slot.lastEnd = null
        agent.followup(this.makeMessage([{ type: 'text', text }]))
        await this.ctx.sessions.flush(agent.session)
        await agent.whenIdle()
        if (slot.failed || slot.lost || this.stopped) throw slot.failed || new Error('Host stopped during delivery')
        if (slot.lastEnd !== 'completed') throw new Error(`DSH turn did not complete normally: ${slot.lastEnd ?? 'missing end'}`)
      }
      await deliver(wakeText(project, lease.key, unread, lease.reason, continuity))
      let nudged = false, unanswered = false
      if (!slot.platform) { nudged = true;await deliver(NUDGE) }
      else if (addressed && !slot.replied) { nudged = true;unanswered = true;await deliver(UNANSWERED) }
      if (!slot.platform) throw new Error('No platform tool concluded this wake')
      clearInterval(timer);await renewal
      if (slot.lost || this.stopped) throw new Error('Lease lost before completion')
      await this.runtime.finish(slot.lease, { turn: { sessionId, silent: false, nudged, unanswered } })
    } catch (error) {
      agent?.cancel({ kind: 'hook', reason: 'runtime turn interrupted' })
      if (agent) await agent.whenIdle()
      // Failed or interrupted turns never advance the durable inbox cursor.
      try { await this.runtime.retry(slot.lease, { delayMs: 5000 }) } catch { /* expiry or an already committed finish owns recovery */ }
      throw error
    } finally {
      clearInterval(timer);await renewal
      this.slots.delete(sessionId)
    }
  }

  start() {
    this.timer = setInterval(() => {
      if (!this.polling) this.pollPromise = this.ctx.agents.withoutInitiator(() => this.poll())
    }, 500)
    return () => this.stop()
  }

  async stop() {
    this.stopped = true;clearInterval(this.timer)
    for (const slot of this.slots.values()) slot.agent?.cancel({ kind: 'hook', reason: 'runtime host stopped' })
    await this.pollPromise
    await Promise.allSettled([...this.tasks])
  }
}
