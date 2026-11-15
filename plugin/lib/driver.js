/**
 * Session driver: one ordinary DSH Session per (assistant, thread), woken
 * serially by a Raft-style notice.
 *
 * A wake is delivered only while nothing is running for that session key, and
 * only when the inbox holds an event newer than the last one already
 * announced, so an assistant that ignores its inbox is not woken in a loop.
 * Items read inside a woken turn are acknowledged when that turn ends; a turn
 * that crashes leaves them unread and the next wake announces them again.
 *
 * Project assistants are DSH Sessions with inboxes. A member may in turn use
 * DSH's own `subagent` tool; those children belong to the member's Session,
 * not to the project, and the driver only lists them for the card.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { COORDINATOR, MIRA, workerKey } from './store.js'
import { continuityNotice, NUDGE, rolePrompt, UNANSWERED, wakeText } from './protocol.js'
import { ThreadWorkspaces } from './worktrees.js'
import { RETURN_NOTICE } from './external-runtime.js'

const DEBOUNCE_MS = 250
const MAX_ROUNDS = 6
const CHILDREN_TTL_MS = 8_000

/** A folder name for the project's default workspace; its last segment is the sidebar title. */
export function folderName(project) {
  const name = (project.initialName ?? project.name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 60)
  return name === '' || name === '.' || name === '..' ? project.id : name
}

export class Driver {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with agents and sessions.
   * @param {import('./store.js').ProjectStore} store
   * @param {(content: object[]) => object} makeMessage - builds a UserMessage for followup.
   */
  constructor(ctx, store, makeMessage, text = {}) {
    this.ctx = ctx
    /** Prompt builders; the hub driver passes its own (see hub.js). */
    this.text = { rolePrompt, wakeText, continuityNotice, nudge: NUDGE, unanswered: UNANSWERED, ...text }
    this.store = store
    this.workspaces = new ThreadWorkspaces(store)
    this.makeMessage = makeMessage
    this.controller = undefined
    this.slots = new Map()
    /** agent id → active woken turn */
    this.turns = new Map()
    this.scoped = new WeakSet()
    this.watched = new WeakSet()
    this.stopped = false
    /** parent session id → { at, rows, pending } */
    this.children = new Map()
    /** session id → { provider, model } the session last sent a request with */
    this.models = new Map()
    this.installModelSelection = text.installModelSelection
    /** Replacement sessions made by opening the project conversation; their first wake still carries the continuity notice. */
    this.pendingContinuity = new Set()
  }

  setController(controller) {
    this.controller = controller
    if (controller !== undefined) this.recover()
  }

  stop() {
    this.stopped = true
    for (const slot of this.slots.values()) clearTimeout(slot.timer)
  }

  /** Runtime status per session key for the UI: running, queued or idle. */
  status(projectId, key) {
    const slot = this.slots.get(`${projectId}|${key}`)
    const binding = this.store.projects?.get(projectId)?.sessions.get(key)
    // DSH can resume a parent on a subagent completion without a Driver wake.
    if (slot?.running || (binding && this.ctx.agents.get(binding.sessionId)?.status === 'running')) return 'running'
    return slot && slot.timer !== null ? 'queued' : 'idle'
  }

  /** Re-announce unread inbox items after a Host restart (at-least-once). */
  recover() {
    for (const project of this.store.projects.values()) {
      const keys = new Set()
      for (const event of project.events) for (const key of event.to ?? []) keys.add(key)
      for (const key of keys) {
        if (this.store.unread(project, key).length > 0) this.schedule(project.id, key, 'recover')
      }
    }
  }

  schedule(projectId, key, reason) {
    if (this.stopped) return
    const id = `${projectId}|${key}`
    let slot = this.slots.get(id)
    if (slot === undefined) {
      slot = { timer: null, running: false, again: false, reason, wokenThrough: 0 }
      this.slots.set(id, slot)
    }
    slot.reason = reason
    if (slot.running) {
      slot.again = true
      return
    }
    clearTimeout(slot.timer)
    // A wake scheduled from inside another Agent's tool call must not inherit that Agent as its initiator.
    slot.timer = this.ctx.agents.withoutInitiator(() => setTimeout(() => {
      slot.timer = null
      this.ctx.agents.withoutInitiator(() => this.run(projectId, key, slot)).catch((error) => {
        this.ctx.logger.warn(`mira-projects: wake for ${key} failed`, error)
      })
    }, DEBOUNCE_MS))
    this.store.touch()
  }

  /** v4: the project assistant answered in text in its own conversation, so the woken turn needs no nudge. */
  replied(sessionId) {
    const turn = this.turns.get(sessionId)
    if (turn !== undefined) { turn.platform = true; turn.replied = true }
  }

  /** The woken turn an Agent is running now, if the driver started it. */
  turnOf(agentId) {
    return this.turns.get(agentId)
  }

  registerScoped(agent) {
    if (this.scoped.has(agent)) return
    const binding = this.store.bySession(agent.id)
    if (binding === undefined) return
    const project = this.store.get(binding.projectId)
    const member = project.members.find(m => m.id === this.assigneeOf(project, binding.key))
    if (binding.key.startsWith('w:')) this.retitleTask(agent, project, project.threads.get(binding.key.slice(2)))
    else this.retitleMember(agent, project, member)
    if (member?.active === false) throw new Error('这位成员已移出项目')
    if (member?.modelSelection && !this.installModelSelection) throw new Error('成员模型选择服务尚未就绪')
    if (this.installModelSelection) {
      // Outermost waterfalls override DSH's ordinary session default without changing the global default.
      // DSH reads `current` before every step, so a member's model change reaches a running session on its next step
      // (DSH notes the switch in the session); no model configured leaves the session on its own model.
      const driver = this, { projectId, key } = binding
      const selection = {
        assembled: undefined,
        get current() {
          const now = driver.store.projects.get(projectId)
          // A task's own pick wins over its member's.
          const own = key.startsWith('w:') ? now?.threads.get(key.slice(2))?.modelSelection : undefined
          const configured = own ?? now?.members.find(m => m.id === driver.assigneeOf(now, key))?.modelSelection
          return configured ? { provider: configured.provider, model: configured.model } : undefined
        },
      }
      this.installModelSelection({ on: (event, listener, options) => agent.ctx.on(event, listener, { ...options, prepend: true }) }, selection)
    }
    this.watchModel(agent)
    this.text.toolPolicy?.(agent)
    try {
      agent.ctx.systemPrompt.section({
        name: 'mira-projects:role',
        order: 10100,
        interpolate: false,
        // Frozen for the session so the prompt prefix stays cacheable; later changes arrive as wake text.
        text: this.text.rolePrompt(project, binding.key),
      })
      this.scoped.add(agent)
    } catch (error) {
      this.ctx.logger.warn(`mira-projects: could not add the role prompt to ${agent.id}`, error)
    }
    // Text that changes between turns (the hub's 关于你): DSH appends it as runtime context, never as the owner's message.
    if (this.text.liveContext && this.scoped.has(agent)) try {
      agent.ctx.systemPrompt.context?.({ name: 'mira-projects:live', order: 300, interpolate: false,
        text: () => { try { return this.text.liveContext(this.store.projects.get(binding.projectId) ?? project, binding.key) } catch { return '' } } })
    } catch (error) { this.ctx.logger.warn(`mira-projects: could not add the live context to ${agent.id}`, error) }
  }

  // ---------------------------------------------------------------- models

  /**
   * Remember which model a project session runs on, for the avatars. DSH has no
   * public `agent.model`: the routed provider/model shows on each request
   * (`agent/request` resolves to it, after model selection applies) and in the
   * session's last request header. Never throws; a miss leaves the default.
   */
  watchModel(agent) {
    if (this.watched.has(agent)) return
    this.watched.add(agent)
    const note = (route) => {
      if (route && typeof route.model === 'string' && route.model !== '') {
        const prev = this.models.get(agent.id)
        if (prev?.model === route.model && prev?.provider === route.provider) return
        this.models.set(agent.id, { provider: typeof route.provider === 'string' ? route.provider : null, model: route.model })
        this.store.touch()
      }
    }
    try { note(agent.session?.requestHeader?.()?.config) } catch { /* no header yet */ }
    try {
      agent.ctx?.on?.('agent/status', () => this.store.touch())
      agent.ctx?.on?.('agent/request', async (_payload, next) => {
        const resolved = await next()
        try { note(resolved) } catch { /* display only */ }
        return resolved
      }, { prepend: true })
    } catch (error) {
      this.ctx.logger.warn(`mira-projects: cannot watch the model of ${agent.id}`, error)
    }
  }

  /** The model a session last used, else DSH's current default for new agents. */
  modelOf(sessionId) {
    const seen = sessionId ? this.models.get(sessionId) : undefined
    if (seen !== undefined) return { ...seen, source: 'session' }
    return this.defaultModel()
  }

  defaultModel() {
    try {
      const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection && typeof selection.model === 'string' && selection.model !== '') {
        return { provider: selection.provider ?? null, model: selection.model, source: 'default' }
      }
    } catch { /* not available on this profile */ }
    return null
  }

  async modelCatalog() {
    if (!this.controller?.modelCatalog) throw new Error('DSH 模型列表尚未就绪')
    return this.controller.modelCatalog()
  }

  /** A member's model: the newest of its sessions that has one, else the default. */
  memberModel(project, memberId) {
    const member = project.members.find(m => m.id === memberId)
    if (member?.runtimeSelection?.provider === 'claude') return { provider: 'claude', model: 'Claude Code', source: 'runtime' }
    if (member?.runtimeSelection?.provider === 'codex') return { provider: 'codex', model: 'Codex', source: 'runtime' }
    let best
    for (const binding of project.sessions.values()) {
      if (binding.assignee !== memberId) continue
      const seen = this.models.get(binding.sessionId)
      if (seen !== undefined && (best === undefined || binding.boundAt > best.at)) best = { at: binding.boundAt, model: seen }
    }
    const selection = project.members.find(m => m.id === memberId)?.modelSelection
    return best !== undefined ? { ...best.model, source: 'session' } : selection ? { ...selection, source: 'member' } : this.defaultModel()
  }

  /**
   * The DSH Workspace that holds a project's sessions, so they group under the
   * project in the sidebar: the project's own folder when it has one, otherwise
   * a folder named after the project in its data directory.
   * @returns the Workspace id, or undefined when no registry is available.
   */
  async workspaceFor(project, thread) {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    try {
      const path = thread?.workspace?.cwd ?? project.cwd ?? join(this.store.root, project.id, folderName(project))
      if (project.cwd === undefined) mkdirSync(path, { recursive: true })
      return (await registry.create(path, thread?.workspace ? `${project.name} · ${thread.title}` : project.name)).id
    } catch (error) {
      this.ctx.logger.warn(`mira-projects: no workspace for project ${project.id}`, error)
      return undefined
    }
  }

  assigneeOf(project, key) {
    if (key === COORDINATOR) return 'coordinator'
    if (key === MIRA) return MIRA
    return project.threads.get(key.slice(2))?.assignee ?? 'worker'
  }

  async ensureAgent(project, key) {
    const controller = this.controller
    const thread = key.startsWith('w:') ? project.threads.get(key.slice(2)) : undefined
    if (thread !== undefined && !(this.repositories && await this.repositories.ensureThread(project, thread))) this.workspaces.ensure(project, thread)
    const binding = project.sessions.get(key)
    // v4 harness: the task was with Claude Code / Codex and comes back to DSH. Its own DSH session of this task is
    // picked up again while it still fits the project's settings, so going away and back does not cost it what it knew.
    if (binding !== undefined && (binding.runtime ?? 'dsh') !== 'dsh') {
      const earlier = project.events.findLast(e => e.type === 'session.bound' && e.key === key && (e.runtime ?? 'dsh') === 'dsh' && (e.node ?? 'local') === 'local')
      if (earlier !== undefined && (earlier.configRevision ?? 0) === (project.configRevision ?? 0)) {
        let agent = this.ctx.agents.get(earlier.sessionId)
        if (agent === undefined && controller !== undefined) {
          const resolved = await controller.resolveAgent(earlier.sessionId)
          if ('error' in resolved) this.ctx.logger.warn(`mira-projects: session ${earlier.sessionId} could not be picked up again (${String(resolved.error?.message ?? resolved.error)}); starting a new one`)
          else agent = resolved.agent
        }
        if (agent !== undefined) {
          this.store.append(project.id, {
            type: 'session.bound', key, sessionId: earlier.sessionId, node: 'local', assignee: this.assigneeOf(project, key),
            generation: (binding.generation ?? 0) + 1, continuity: false, configRevision: project.configRevision ?? 0,
          })
          return { agent, continuity: false, returning: true }
        }
      }
    } else if (binding !== undefined && (binding.configRevision ?? 0) === (project.configRevision ?? 0)) {
      const live = this.ctx.agents.get(binding.sessionId)
      if (live !== undefined) return { agent: live, continuity: false }
      if (controller !== undefined) {
        const resolved = await controller.resolveAgent(binding.sessionId)
        if (!('error' in resolved)) return { agent: resolved.agent, continuity: false }
        this.ctx.logger.warn(`mira-projects: session ${binding.sessionId} could not resume (${String(resolved.error?.message ?? resolved.error)}); starting a new one`)
      }
    }
    if (controller === undefined) throw new Error('DSH 会话服务还没就绪（需要 Web profile）')
    const assignee = this.assigneeOf(project, key)
    const member = project.members.find(m => m.id === assignee)
    const sessionId = `session-${randomUUID()}`
    // Bind before creation so the agent/created hook already knows this is a project session.
    this.store.append(project.id, {
      type: 'session.bound', key, sessionId, node: 'local', assignee,
      generation: (binding?.generation ?? 0) + 1, continuity: binding !== undefined,
      configRevision: project.configRevision ?? 0,
    })
    const workspaceId = await this.workspaceFor(project, thread)
    const created = await controller.create({
      sessionId,
      ...(workspaceId !== undefined ? { workspaceId } : thread?.workspace?.cwd || project.cwd ? { cwd: thread?.workspace?.cwd ?? project.cwd } : {}),
      ...(member?.preset ? { agentPreset: member.preset } : {}),
    })
    if (created.sessionId !== sessionId) {
      this.store.append(project.id, {
        type: 'session.bound', key, sessionId: created.sessionId, node: 'local', assignee,
        generation: (binding?.generation ?? 0) + 1, continuity: binding !== undefined,
        configRevision: project.configRevision ?? 0,
      })
    }
    const resolved = await controller.resolveAgent(created.sessionId)
    if ('error' in resolved) throw resolved.error
    this.nameSession(resolved.agent, project, thread, member)
    return { agent: resolved.agent, continuity: binding !== undefined }
  }

  /**
   * v4: a conversation the owner opens from the page is that assistant's own DSH Session: the project assistant's for a
   * project, Mira's for the hub. Returns that Session, making it when there is none yet or the configuration changed since.
   */
  async openChat(project, key = COORDINATOR) {
    const { agent, continuity } = await this.ensureAgent(project, key)
    this.registerScoped(agent)
    if (continuity) this.pendingContinuity.add(agent.id)
    return agent.id
  }

  nameSession(agent, project, thread, member) {
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) return
    try {
      // A task's title is the task alone: the page shows its project and member beside the title.
      titles.rename(agent.session, thread === undefined ? this.memberTitle(project, member) : thread.title)
    } catch (error) {
      this.ctx.logger.warn(`mira-projects: session ${agent.id} was not named`, error)
    }
  }

  /**
   * The project conversation (the project assistant's Session) is titled with the project's name alone; another member's
   * is `项目的成员`. The personal assistant's is its name alone, which is also the hub's. No separator dots in titles.
   */
  memberTitle(project, member) {
    if (project.hub || !member || member.id === COORDINATOR) return project.name
    return `${project.name}的${member.name}`
  }

  /**
   * Both assistants were called Mira until 2026-11, so their Sessions are titled `项目 · Mira` (the hub's `Mira 总管 · Mira`).
   * A title still in that shape gets today's name when its Session next comes up; any other title is the owner's and stays.
   */
  retitleMember(agent, project, member) {
    // Best effort, like retitleTask.
    try {
      const titles = this.ctx.get('sessionTitle'), current = titles?.get(agent.session)?.title
      if (typeof current !== 'string') return
      // Older shapes: `项目 · Mira` (both assistants were Mira until 2026-11) and `项目 · 成员` (until 2026-11-15).
      const old = current === `${project.name} · ${member?.name ?? '协调员'}` || (member?.id === MIRA && current.endsWith(' · Mira'))
      if (old && current !== this.memberTitle(project, member)) titles.rename(agent.session, this.memberTitle(project, member))
    } catch (error) {
      this.ctx.logger.warn(`mira-projects: session ${agent.id} kept its old title`, error)
    }
  }

  /**
   * Tasks used to be titled `项目 · 任务 · 成员`. A title still in that shape is cut down to the task when its Session
   * next comes up; any other title is one the owner gave it and stays. DSH cuts titles at 80 bytes, so the old title may
   * stop inside the task name, or carry whichever member held the task when it was named.
   */
  retitleTask(agent, project, thread) {
    // Best effort, and never in the way of the role prompt that registerScoped goes on to install.
    try {
      const current = thread && this.ctx.get('sessionTitle')?.get(agent.session)?.title
      if (typeof current !== 'string') return
      const clean = text => String(text).replace(/\s+/gu, ' ').trim()
      const task = clean(thread.title), old = `${clean(project.name)} · ${task}`
      if (task.startsWith(current) || !current.startsWith(`${clean(project.name)} ·`)) return
      if (old.startsWith(current) || current.startsWith(`${old} ·`)) this.ctx.get('sessionTitle').rename(agent.session, thread.title)
    } catch (error) {
      this.ctx.logger.warn(`mira-projects: session ${agent.id} kept its old title`, error)
    }
  }

  async run(projectId, key, slot) {
    slot.running = true
    this.store.touch()
    try {
      for (let round = 0; round < MAX_ROUNDS && !this.stopped; round++) {
        slot.again = false
        const project = this.store.get(projectId)
        // v4 harness: the owner is driving this task. Nothing is dispatched to an executor, and what arrives stays
        // unread, until the owner hands it back (which wakes this key again).
        if (key.startsWith('w:') && project.threads?.get(key.slice(2))?.heldAt) break
        let unread = this.store.unread(project, key)
        let newest = unread.at(-1)?.seq ?? 0
        if (unread.length === 0 || newest <= slot.wokenThrough) break
        if (this.external?.handles(project, key)) {
          // The task's DSH session may still be finishing a turn from before the switch (or one the owner typed into
          // it). Two executors never work on one task at once: wait, then look at everything again.
          const bound = project.sessions.get(key)
          const native = bound !== undefined && (bound.runtime ?? 'dsh') === 'dsh' ? this.ctx.agents.get(bound.sessionId) : undefined
          if (native?.status === 'running') {
            await native.whenIdle()
            if (this.stopped) break
            continue
          }
          slot.wokenThrough = newest
          const addressed = unread.some(e => e.type === 'message.posted' && e.author?.kind === 'human' && Array.isArray(e.to) && e.to.includes(key))
          const { binding, turn, unanswered } = await this.external.run({ project, key, unread, reason: slot.reason, notice: false, addressed })
          if (turn.readThrough > 0) this.store.append(projectId, { type: 'inbox.acked', key, cursor: turn.readThrough })
          this.store.append(projectId, { type: 'turn.ended', key, sessionId: binding.sessionId, silent: !turn.platform, nudged: false, ...(unanswered ? { unanswered: true } : {}) })
          continue
        }
        await this.devices?.assertStopped(projectId, key)
        const { agent, continuity, returning } = await this.ensureAgent(project, key)
        this.registerScoped(agent)
        if (agent.status === 'running') {
          // A native continuation owns its own tool calls until it settles.
          // It may itself consume inbox entries; recalculate after waiting.
          await agent.whenIdle()
          if (this.stopped) break
          unread = this.store.unread(project, key)
          newest = unread.at(-1)?.seq ?? 0
          if (unread.length === 0 || newest <= slot.wokenThrough) break
        }
        slot.wokenThrough = newest
        const turn = { projectId, key, platform: false, replied: false, readThrough: 0 }
        // A human message addressed to this member (an @, or a line in its thread) deserves a visible answer or an explicit no_reply.
        const addressed = unread.some(e => e.type === 'message.posted' && e.author?.kind === 'human' && Array.isArray(e.to) && e.to.includes(key)) || this.text.addressed?.(unread) === true
        this.turns.set(agent.id, turn)
        const notice = this.pendingContinuity.delete(agent.id) || continuity
        const text = this.text.wakeText(project, key, unread, slot.reason, returning ? RETURN_NOTICE : notice ? this.text.continuityNotice(project, key) : '')
        try {
          agent.followup(this.makeMessage([{ type: 'text', text }]))
          await this.ctx.sessions.flush(agent.session)
          await agent.whenIdle()
          let nudged = false
          let unanswered = false
          if (!turn.platform && !this.stopped) {
            nudged = true
            agent.followup(this.makeMessage([{ type: 'text', text: this.text.nudge }]))
            await agent.whenIdle()
          } else if (addressed && !turn.replied && !this.stopped) {
            // bug 19 (cloud-run-10 R6): 「@Mira 帮我记一句」 got a memory_write and no reply, so the owner saw nothing.
            // One follow-up asks for a line (or an explicit no_reply); the turn is recorded as unanswered either way.
            unanswered = true
            nudged = true
            agent.followup(this.makeMessage([{ type: 'text', text: this.text.unanswered }]))
            await agent.whenIdle()
          }
          await this.devices?.assertStopped(projectId, key)
          if (turn.readThrough > 0) this.store.append(projectId, { type: 'inbox.acked', key, cursor: turn.readThrough })
          this.store.append(projectId, { type: 'turn.ended', key, sessionId: agent.id, silent: !turn.platform, nudged, ...(unanswered ? { unanswered: true } : {}) })
        } finally {
          this.turns.delete(agent.id)
        }
      }
    } catch (error) {
      this.ctx.logger.warn(`mira-projects: delivering to ${key} failed`, error)
      try {
        this.store.append(projectId, { type: 'turn.failed', key, error: String(error?.message ?? error) })
      } catch { /* the project may be gone */ }
    } finally {
      slot.running = false
      this.store.touch()
      if (slot.again && !this.stopped) this.schedule(projectId, key, slot.reason)
    }
  }

  /** Wake every recipient of a committed event. */
  deliver(event, reason) {
    for (const key of event.to ?? []) this.schedule(event.projectId, key, reason)
  }

  // ---------------------------------------------------------------- sub-agents

  /**
   * Cached list of a member session's DSH sub-agents (children spawned with the
   * `subagent` tool). Sync for the snapshot; `refreshChildren` fills the cache.
   */
  childrenOf(sessionId) {
    if (!sessionId) return []
    return this.children.get(sessionId)?.rows ?? []
  }

  /** Descendants remain attached to their real parent, even when an intermediate agent is idle. */
  descendantsOf(sessionId) {
    const rows = [], seen = new Set([sessionId])
    const visit = (parentId, depth) => {
      for (const child of this.childrenOf(parentId)) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        rows.push({ ...child, parentId, rootSessionId: sessionId, depth })
        visit(child.id, depth + 1)
      }
    }
    visit(sessionId, 1)
    return rows
  }

  /** Refresh child lists for the given session ids when the cache is stale; never throws. */
  async refreshChildren(sessionIds, visited = new Set()) {
    const runtime = this.ctx.get('subagents')
    if (runtime === undefined || typeof runtime.listChildren !== 'function') return
    const now = Date.now()
    await Promise.all([...new Set(sessionIds.filter(Boolean))].map(async (sessionId) => {
      if (visited.has(sessionId)) return
      visited.add(sessionId)
      const cached = this.children.get(sessionId)
      if (cached !== undefined && (cached.pending || now - cached.at < CHILDREN_TTL_MS)) {
        if (!cached.pending) await this.refreshChildren(cached.rows.map(c => c.id), visited)
        return
      }
      const entry = { at: now, rows: cached?.rows ?? [], pending: true }
      this.children.set(sessionId, entry)
      try {
        const rows = await runtime.listChildren(sessionId)
        entry.rows = rows.map((row) => {
          const live = this.ctx.agents.get(row.id)
          return {
            id: row.id, label: row.label ?? '', mode: row.mode ?? 'unknown', createdAt: row.createdAt ?? null,
            running: live !== undefined && live.status !== 'idle',
            status: live?.status ?? 'not_loaded',
          }
        })
        if (JSON.stringify(entry.rows) !== JSON.stringify(cached?.rows ?? [])) this.store.touch()
      } catch (error) {
        // A session without a catalog is normal; keep what we had.
        if (!/catalog|not found|unavailable/i.test(String(error?.message ?? error))) {
          this.ctx.logger.warn(`mira-projects: listing sub-agents of ${sessionId} failed`, error)
        }
      } finally {
        entry.pending = false
        entry.at = Date.now()
      }
      await this.refreshChildren(entry.rows.map(c => c.id), visited)
    }))
  }
}

export { COORDINATOR, MIRA, workerKey }
