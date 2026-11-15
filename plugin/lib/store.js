/**
 * Event-sourced project store.
 *
 * Every project is one append-only `events.jsonl` under `<root>/<projectId>/`.
 * Cards, checklists, inboxes, memory and Mira's cards are projections of that
 * log, so a restart replays the file and lands in the same state. Recipients
 * of an event are decided once, when it is appended, and stored on the event
 * as `to`: an inbox is the log filtered by `to`, read past the session's
 * cursor. Mira's inbox is different: it is every observable event, because
 * Mira watches the project instead of being addressed.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const COORDINATOR = 'coordinator'
/** At most this many input paths are kept per task. */
export const THREAD_INPUTS_MAX = 60
export const MIRA = 'mira'
export const workerKey = threadId => `w:${threadId}`

export const THREAD_STATES = ['working', 'blocked', 'review_ready', 'done', 'failed']
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3']
export const CARD_KINDS = ['next_step', 'reminder', 'open_loop', 'recap', 'capture', 'morning']
export const CARD_ACTIONS = ['open_thread', 'reply', 'save_memory', 'copy_text']
export const MEMORY_SECTIONS = ['now', 'decisions', 'openLoops', 'facts']

/** Event types Mira watches. Bookkeeping events (acks, turns, tool calls, sessions) are not among them. */
export const OBSERVABLE = new Set([
  'message.posted', 'thread.opened', 'thread.updated', 'decision.requested', 'decision.answered', 'decision.withdrawn',
  'relay.sent', 'card.acted', 'card.dismissed', 'mira.requested', 'turn.failed',
  // The hub log only (see hub.js): something in a project needs the steward's eye.
  'project.attention',
  // Feishu messages that reached the owner and wait for them, routed to Mira in auto mode (attention.js).
  'feishu.attention',
  'mr.published', 'mr.publish.failed', 'mr.merge.failed', 'mr.merged',
  'mr.close.failed', 'mr.closed',
  'project.configured',
  'automation.triggered',
  'external.received',
  'file.published',
  'repository.imported',
])

/** Default roster for a new project: one coordinator, three workers, and Mira. */
/** What the project assistant is told it is. Projects made before 2026-11-13 store the older wording; the prompt uses this one. */
export const COORDINATOR_PERSONA = '接住项目对话里的每句话，判断要不要开任务；要动手时开成任务交给执行者；自己不做具体的活。'
export const OLD_COORDINATOR_PERSONA = '接住项目对话里的每句话，判断要不要开任务；要动手时按需新建执行者并派给它；自己不做具体的活。'
export const MIRA_MEMBER = { id: MIRA, kind: 'assistant', role: 'memory', name: '记忆助理', persona: '不接活。安静地看项目里发生的事，整理成记忆，在合适的时候递一张卡：下一步、提醒、回顾。' }
export const DEFAULT_MEMBERS = [
  { id: 'coordinator', kind: 'assistant', role: 'coordinator', name: '协调员', persona: '接住群聊里的每句话，判断要不要开线程、派给谁；自己不做具体的活。' },
  { id: 'engineer', kind: 'assistant', role: 'worker', name: '工程师', persona: '写代码、查代码、跑命令，交付能运行的结果。' },
  { id: 'designer', kind: 'assistant', role: 'worker', name: '设计师', persona: '出界面、文案和样式方案，给出可选版本和推荐。' },
  { id: 'researcher', kind: 'assistant', role: 'worker', name: '研究员', persona: '查资料、读文档、做对比，结论带来源。' },
  MIRA_MEMBER,
]
/** The owner's own assistant, above every project. Internally it is the hub's member with id `mira`. */
export const PERSONAL_NAME = '个人助理'
/** Both assistants were called this until 2026-11; logs written before then still carry it, and the owner may still say it. */
const LEGACY_NAME = 'Mira'
const currentNames = (members, hub) => members.map(m => m.id === MIRA && m.name === LEGACY_NAME ? { ...m, name: hub ? PERSONAL_NAME : MIRA_MEMBER.name } : m)
/**
 * v4: what the owner gets from 新建项目 (the page or Mira). No preset executors: the project assistant answers the chat and
 * adds an executor when a task needs a role nobody has. It keeps the coordinator role; only its name is the owner's word for it.
 */
export const STARTER_MEMBERS = [
  { id: 'coordinator', kind: 'assistant', role: 'coordinator', name: '项目助理', persona: COORDINATOR_PERSONA },
  MIRA_MEMBER,
]
/**
 * 2026-11-13: the owner sees tasks and the model doing them, not roles. Every task the project assistant opens goes to one
 * executor per project, made on first need; it runs on the project's default model unless the owner picks another for a
 * task. Executors made before (工程师, 标注员…) keep working for their own tasks.
 */
export const EXECUTOR_ID = 'executor'
export const EXECUTOR_MEMBER = { id: EXECUTOR_ID, kind: 'assistant', role: 'worker', name: '执行者', persona: '接手一件任务，按任务说明和用户原话把它做完、交付；要用户拍板时问他。', modelSelection: null, runtimeSelection: null, active: true }

const id = prefix => `${prefix}_${randomBytes(5).toString('hex')}`

/** Local calendar day of a timestamp, used for the morning card and the daily card budget. */
export function dayKey(at) {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function emptyMemory() {
  return { now: [], decisions: [], openLoops: [], facts: [], updatedAt: 0 }
}

/**
 * bug ㉓ (cloud-run-16 #193): 「Mira，你四栏记忆现在都写的啥？」 opens with the member's name and a pause — that is an address,
 * @ or not. Only the start of the line counts, and only with a pause mark (or 你/您) right after the name: 「工程师那条线程我验收了」
 * talks about the engineer, it does not call him.
 */
function addressedByName(member, text) {
  const head = text.trimStart().slice(0, 40)
  for (const name of [member.name, member.id]) {
    if (!name || !head.toLowerCase().startsWith(String(name).toLowerCase())) continue
    if (/^\s*(?:[，,：:、！!]|你|您)/.test(head.slice(String(name).length))) return true
  }
  return false
}

export class ProjectStore {
  /**
   * @param {string} root - directory holding one folder per project.
   * @param {{ warn: (...args: unknown[]) => void }} logger
   */
  constructor(root, logger) {
    this.root = root
    this.logger = logger
    /** @type {Map<string, any>} */
    this.projects = new Map()
    /** Deleted projects: out of every list, their logs still on disk, so one can be restored whole. */
    this.trash = new Map()
    /** sessionId → { projectId, key } */
    this.sessionIndex = new Map()
    /** sessionId → { projectId, key } of a Session that once ran a key and was replaced (the task changed executor). */
    this.formerIndex = new Map()
    this.rev = 0
    this.listeners = new Set()
    /** Logs whose last line has no end: a write broke off half-way (full disk, crash). The next event starts a new line. */
    this.torn = new Set()
  }

  load() {
    mkdirSync(this.root, { recursive: true })
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(this.root, entry.name, 'events.jsonl')
      if (!existsSync(file)) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      if (lines.at(-1) !== '') this.torn.add(entry.name)
      for (const line of lines) {
        if (line.trim() === '') continue
        let event
        try { event = JSON.parse(line) } catch {
          this.logger.warn(`mira-projects: skipped a malformed line in ${file}`)
          continue
        }
        this.apply(event)
      }
    }
    this.rev = 1
  }

  /** Subscribe to every committed change; returns the unsubscribe function. */
  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Announce a runtime-only change (a session started or stopped running) without writing the log. */
  touch() {
    this.rev++
    for (const listener of this.listeners) {
      try { listener(undefined) } catch (error) { this.logger.warn('mira-projects: change listener failed', error) }
    }
  }

  /**
   * Append one event to a project log, project it, and notify listeners.
   * @returns the committed event (with seq and at).
   */
  append(projectId, event) {
    // A deleted project takes one more event only: the one that restores it.
    const project = event.type === 'project.created' ? undefined : event.type === 'project.restored' ? this.trashed(projectId) : this.get(projectId)
    const seq = project === undefined ? 1 : project.seq + 1
    const committed = { seq, at: Date.now(), projectId, ...event }
    const dir = join(this.root, projectId)
    mkdirSync(dir, { recursive: true })
    // After a broken-off line the event starts on a new line; glued to it, both would be unreadable and this one lost.
    const lead = this.torn.delete(projectId) ? '\n' : ''
    try { appendFileSync(join(dir, 'events.jsonl'), lead + JSON.stringify(committed) + '\n') } catch (error) { this.torn.add(projectId);throw error }
    this.apply(committed)
    this.rev++
    for (const listener of this.listeners) {
      try { listener(committed) } catch (error) { this.logger.warn('mira-projects: change listener failed', error) }
    }
    return committed
  }

  get(projectId) {
    const project = this.projects.get(projectId)
    if (project === undefined) throw new Error(`没有这个项目：${projectId}`)
    return project
  }

  /** A deleted project, by id. */
  trashed(projectId) {
    const project = this.trash.get(projectId)
    if (project === undefined) throw new Error(`回收站里没有这个项目：${projectId}`)
    return project
  }

  /** Session binding for a DSH session id, or undefined when it is not a project session. */
  bySession(sessionId) {
    return this.sessionIndex.get(sessionId)
  }

  /** The key a Session ran before another Session took it over, while that other one still has it. */
  formerSession(sessionId) {
    return this.formerIndex.get(sessionId)
  }

  // ---------------------------------------------------------------- commands

  createProject({ name, instructions = '', cwd, members = DEFAULT_MEMBERS, workspace, gitlab }) {
    const projectId = id('p')
    return this.append(projectId, {
      type: 'project.created',
      name, instructions, cwd: cwd || undefined,
      workspace,
      gitlab,
      nonce: randomBytes(4).toString('hex'),
      members: [{ id: 'owner', kind: 'human', name: '我' }, ...members],
    })
  }

  newMessageId() { return id('m') }
  newThreadId() { return id('t') }
  newDecisionId() { return id('d') }
  newCardId() { return id('c') }

  // ---------------------------------------------------------------- queries

  member(project, memberId) {
    return project.members.find(m => m.id === memberId)
  }

  memberByName(project, name) {
    const wanted = String(name).replace(/^@/, '').trim()
    return project.members.find(m => m.kind === 'assistant' && m.active !== false && (m.name === wanted || m.id === wanted))
  }

  /** Mentioned assistant ids found as `@名字` in a text. */
  mentions(project, text) {
    const found = []
    for (const m of project.members) {
      if (m.kind !== 'assistant' || m.active === false) continue
      if (text.includes(`@${m.name}`) || text.includes(`@${m.id}`) || addressedByName(m, text) || (m.id === MIRA && text.includes(`@${LEGACY_NAME}`))) found.push(m.id)
    }
    return found
  }

  /**
   * Unacknowledged inbox events for one session key, oldest first. Mira's inbox
   * is the stream of observable events it has not looked at yet.
   */
  unread(project, key) {
    const cursor = project.cursors.get(key) ?? 0
    if (key === MIRA) {
      return project.events.filter(e => e.seq > cursor && OBSERVABLE.has(e.type) && !(e.type === 'message.posted' && e.author?.id === MIRA))
    }
    return project.events.filter(e => e.seq > cursor && Array.isArray(e.to) && e.to.includes(key))
  }

  threadOf(project, key) {
    return key.startsWith('w:') ? project.threads.get(key.slice(2)) : undefined
  }

  /** Mira's cards that still wait for the owner, newest first. */
  openCards(project) {
    return project.cardOrder.map(cardId => project.cards.get(cardId)).filter(card => card.state === 'open').reverse()
  }

  /** Decisions still waiting for the owner, oldest first; one thread's only when `threadId` is given. */
  pendingDecisions(project, threadId) {
    return [...project.decisions.values()].filter(d => d.chosen === null && !d.withdrawn && (threadId === undefined || d.threadId === threadId))
  }

  // ---------------------------------------------------------------- projection

  apply(event) {
    if (event.type === 'project.created') {
      const members = currentNames(event.members, event.hub === true)
      // Projects created before Mira existed get her too; she is a service, not a roster choice.
      if (!members.some(m => m.id === MIRA)) members.push(MIRA_MEMBER)
      this.projects.set(event.projectId, {
        id: event.projectId,
        name: event.hub === true && event.name === `${LEGACY_NAME} 总管` ? PERSONAL_NAME : event.name,
        initialName: event.name,
        instructions: event.instructions ?? '',
        cwd: event.cwd,
        workspace: event.workspace ?? { mode: 'shared' },
        gitlab: event.gitlab ?? null,
        nonce: event.nonce,
        members,
        configRevision: 0,
        automations: new Map(),
        courierSessionId: null,
        createdAt: event.at,
        updatedAt: event.at,
        seq: event.seq,
        events: [event],
        messages: new Map(),
        files: new Map(),
        repository: null,
        chat: [],
        threads: new Map(),
        threadOrder: [],
        decisions: new Map(),
        sessions: new Map(),
        cursors: new Map(),
        turns: new Map(),
        activity: new Map(),
        toolCalls: new Map(),
        memory: emptyMemory(),
        cards: new Map(),
        cardOrder: [],
        morningDay: null,
        // Mira speaks in the chat only to answer an @Mira the owner wrote and she has not answered yet (bug 17).
        miraAskSeq: 0,
        miraReplySeq: 0,
        // The hub (Mira's cross-project log, see hub.js) keeps a few more projections.
        hub: event.hub === true,
        recaps: [],
        hubMemory: null,
        // 关于你: what the owner told the assistant about themself (hub.js). Forgotten items stay in the log, hidden.
        about: new Map(),
        aboutOrder: [],
        // Global-memory lines the owner told the assistant to forget; she may not write them back.
        hubForgotten: [],
        pc: [],
        pcIds: new Set(),
        // The computer's history: the latest written version of each device's 10-minute window (computer-history.js).
        activities: new Map(),
        eveningDay: null,
      })
      return
    }
    const project = this.projects.get(event.projectId) ?? this.trash.get(event.projectId)
    if (project === undefined) return
    project.seq = Math.max(project.seq, event.seq)
    project.updatedAt = event.at
    project.events.push(event)
    switch (event.type) {
      case 'personal.protocol': project.personalVersion = event.version;project.configRevision = event.seq;break
      case 'repository.imported': project.repository = event.repository;break
      case 'thread.repository.bound': {
        const thread = project.threads.get(event.threadId)
        if (thread) { thread.repository = event.repository;thread.repositoryBound = true }
        break
      }
      case 'file.published': {
        const file = project.files.get(event.path) ?? { id: event.fileId, path: event.path, versions: [] }
        file.versions.push({ id: event.fileId, path: event.path, revision: event.revision, sha256: event.sha256, size: event.size,
          mime: event.mime, by: event.by, at: event.at, seq: event.seq })
        project.files.set(event.path, file)
        break
      }
      case 'project.updated': {
        if (typeof event.name === 'string') project.name = event.name
        if (typeof event.instructions === 'string') project.instructions = event.instructions
        // How the owner wants models picked in this project (or by the personal assistant), in their own words.
        if (typeof event.modelStrategy === 'string') project.modelStrategy = event.modelStrategy
        break
      }
      case 'message.posted': {
        const message = {
          id: event.messageId, seq: event.seq, at: event.at,
          threadId: event.threadId ?? null,
          author: event.author, trust: event.trust,
          text: event.text, mentions: event.mentions ?? [],
          card: event.card, reactions: {},
          attachments: event.attachments ?? [],
          ...(event.refs ? { refs: event.refs } : {}), ...(event.replyTo ? { replyTo: event.replyTo } : {}),
          ...(event.handoff ? { handoff: event.handoff } : {}), ...(event.via ? { via: event.via } : {}),
          // The part the owner typed themself when a page added a prefix (the 随手问 ball adds where they were looking).
          ...(event.typed ? { typed: event.typed } : {}),
          // Typed straight into the DSH session (already on screen there as the owner's own message).
          ...(event.native ? { native: true } : {}),
        }
        project.messages.set(message.id, message)
        if (message.threadId === null) project.chat.push(message.id)
        else project.threads.get(message.threadId)?.messageIds.push(message.id)
        if (message.author?.kind === 'human' && message.mentions.includes(MIRA)) project.miraAskSeq = message.seq
        if (message.author?.id === MIRA) project.miraReplySeq = message.seq
        break
      }
      case 'thread.opened': {
        project.threads.set(event.threadId, {
          id: event.threadId,
          title: event.title,
          brief: event.brief ?? '',
          note: event.note ?? '',
          assignee: event.assignee,
          repository: event.repository ?? null, repositoryBound: event.repositoryBound === true,
          priority: event.priority ?? 'P2',
          state: 'working',
          summary: '',
          checklist: [],
          resolved: false,
          openedBy: event.openedBy,
          openedAt: event.at,
          updatedAt: event.at,
          cited: event.cited ?? [],
          inputs: [],
          cardMessageId: event.cardMessageId,
          relatedThreadId: event.relatedThreadId ?? null,
          messageIds: [],
          decisionIds: [],
          blockedFrom: null,
          relays: [],
          // v4 harness: this task's own executor (null = the member's default), whether the owner is driving it, and the last handoff.
          runner: null,
          // The model this task's DSH rounds use (null = its member's model, else DSH's default).
          modelSelection: null,
          heldAt: null,
          handoff: null,
        })
        project.threadOrder.push(event.threadId)
        break
      }
      case 'automation.host.bound':
        project.courierSessionId = event.sessionId
        break
      case 'automation.created':
        project.automations.set(event.automationId, { id: event.automationId, requestId: event.requestId, title: event.title, prompt: event.prompt, target: event.target, rule: event.rule, epoch: event.epoch, enabled: true, status: 'creating', createdAt: event.at, occurrences: new Set(), nativeId: null })
        break
      case 'automation.resumed': {
        const task = project.automations.get(event.automationId)
        if (task) Object.assign(task, { epoch: event.epoch, enabled: true, status: 'creating', nativeId: null, schedule: null, error: null })
        break
      }
      case 'automation.bound':
      case 'automation.observed': {
        const task = project.automations.get(event.automationId)
        if (task) Object.assign(task, { status: 'active', schedule: event.schedule, ...(event.nativeId ? { nativeId: event.nativeId, sessionId: event.sessionId } : {}), error: null })
        break
      }
      case 'automation.failed': {
        const task = project.automations.get(event.automationId)
        if (task) Object.assign(task, { status: 'error', error: event.error })
        break
      }
      case 'automation.stop.requested': {
        const task = project.automations.get(event.automationId)
        if (task) Object.assign(task, { enabled: false, status: 'stopping', deleteWanted: event.deleted })
        break
      }
      case 'automation.stopped':
      case 'automation.completed':
      case 'automation.missing': {
        const task = project.automations.get(event.automationId)
        if (task) Object.assign(task, { enabled: false, status: event.type === 'automation.missing' ? 'missing' : event.type === 'automation.completed' ? 'complete' : event.deleted ? 'deleted' : 'paused', error: null })
        break
      }
      case 'automation.triggered': {
        const task = project.automations.get(event.automationId)
        if (task) { task.occurrences.add(event.occurrenceId);task.lastRun = { at: event.at, scheduledAt: event.scheduledAt, receiptMessageId: event.receiptMessageId, coalesced: event.coalesced, earlierUnavailable: event.earlierUnavailable } }
        break
      }
      case 'project.deleted': {
        // Out of every list, and its Sessions are ordinary DSH Sessions from here on. Nothing is erased: the log stays
        // on disk and the Session bindings are kept aside, so a restore puts the project back whole.
        this.projects.delete(project.id)
        this.trash.set(project.id, project)
        project.deletedAt = event.at
        project.unbound = [...this.sessionIndex].filter(([, bound]) => bound.projectId === project.id)
        for (const [sessionId] of project.unbound) this.sessionIndex.delete(sessionId)
        break
      }
      case 'project.restored':
        this.trash.delete(project.id)
        this.projects.set(project.id, project)
        project.deletedAt = null
        for (const [sessionId, bound] of project.unbound ?? []) this.sessionIndex.set(sessionId, bound)
        project.unbound = []
        break
      case 'project.icon':
        // What the project wears in lists: one emoji and a colour (project-icons.js). Owner's or model's, last one wins.
        project.icon = event.icon
        project.color = event.color
        project.iconBy = event.by?.kind === 'human' ? 'human' : 'assistant'
        break
      case 'project.configured': {
        project.name = event.name
        project.instructions = event.instructions
        project.members = currentNames(event.members, project.hub === true)
        project.configRevision = event.seq
        for (const binding of project.sessions.values()) {
          if (project.members.find(m => m.id === binding.assignee)?.active === false) this.sessionIndex.delete(binding.sessionId)
        }
        break
      }
      // A model-only change: sessions keep running and switch on their next step, so the config revision stays.
      case 'member.model':
        project.members = project.members.map(m => m.id === event.memberId ? { ...m, modelSelection: event.modelSelection ?? null } : m)
        break
      // A new 做事说明 for one assistant (技能自迭代, or the owner going back to an older version). Like member.model it
      // changes no config revision: a task's session reads it when it starts, so it holds from the next new task.
      case 'member.persona':
        project.members = project.members.map(m => m.id === event.memberId ? { ...m, persona: event.persona } : m)
        break
      // An executor added for a task: like member.model, it changes no config revision, so running sessions keep running.
      case 'member.added':
        project.members = [...project.members, event.member]
        break
      case 'thread.updated': {
        const thread = project.threads.get(event.threadId)
        if (thread === undefined) break
        // Remember when a delivered thread went back to work: a later delivery only retires cards from after this.
        if (event.patch?.state !== undefined && event.patch.state !== 'review_ready' && thread.state === 'review_ready') thread.leftReviewAt = event.at
        // Remember what a thread was doing before it blocked, so a dropped question can put it back there (bug 14).
        if (event.patch?.state !== undefined && event.patch.state !== thread.state) thread.blockedFrom = event.patch.state === 'blocked' ? thread.state : null
        for (const field of ['title', 'summary', 'state', 'priority', 'checklist', 'resolved', 'assignee']) {
          if (event.patch?.[field] !== undefined) thread[field] = event.patch[field]
        }
        if (thread.gitlab && thread.gitlab.status !== 'merged' && (event.patch?.resolved === true || (event.patch?.state !== undefined && !['review_ready', 'done'].includes(event.patch.state)))) {
          thread.gitlab = { ...thread.gitlab, approvedSha: null, approvalSeq: null }
        }
        thread.updatedAt = event.at
        break
      }
      case 'thread.runner': {
        const thread = project.threads.get(event.threadId)
        if (thread === undefined) break
        thread.runner = event.provider
        thread.handoff = { kind: 'switch', at: event.at, from: event.from ?? null, to: event.provider, facts: event.facts ?? null }
        break
      }
      // Files the task's own session pointed its tools at, first seen first; capped so a long task cannot grow the log.
      case 'thread.read': {
        const thread = project.threads.get(event.threadId)
        if (thread) {
          const seen = new Set(thread.inputs ?? [])
          for (const path of event.paths ?? []) if (typeof path === 'string' && path && seen.size < THREAD_INPUTS_MAX) seen.add(path)
          thread.inputs = [...seen]
        }
        break
      }
      case 'thread.model': {
        const thread = project.threads.get(event.threadId)
        if (thread !== undefined) thread.modelSelection = event.modelSelection ?? null
        break
      }
      case 'thread.held': {
        const thread = project.threads.get(event.threadId)
        if (thread !== undefined) thread.heldAt = event.at
        break
      }
      case 'thread.released': {
        const thread = project.threads.get(event.threadId)
        if (thread === undefined) break
        thread.handoff = { kind: 'return', at: event.at, from: 'owner', to: event.runner ?? null, heldAt: thread.heldAt, facts: event.facts ?? null }
        thread.heldAt = null
        break
      }
      case 'thread.workspace.preparing':
      case 'thread.workspace.ready':
      case 'thread.workspace.failed': {
        const thread = project.threads.get(event.threadId)
        if (thread) thread.workspace = { ...event.workspace, updatedAt: event.at }
        break
      }
      case 'thread.workspace.landed': {
        const thread = project.threads.get(event.threadId)
        if (thread?.workspace) thread.workspace = { ...thread.workspace, landed: { ...event.landed, at: event.at } }
        break
      }
      case 'mr.publish.requested':
      case 'mr.publish.started':
      case 'mr.published':
      case 'mr.publish.failed':
      case 'mr.accept.requested':
      case 'mr.merge.failed':
      case 'mr.merged': {
        const thread = project.threads.get(event.threadId)
        if (!thread) break
        const status = { 'mr.publish.requested': 'publishing', 'mr.publish.started': 'publishing', 'mr.published': 'ready', 'mr.publish.failed': 'publish_error', 'mr.accept.requested': 'merging', 'mr.merge.failed': 'merge_error', 'mr.merged': 'merged' }[event.type]
        const previous = thread.gitlab ?? {}
        thread.gitlab = { ...previous, status, updatedAt: event.at, error: event.error ?? null }
        for (const field of ['sha', 'iid', 'url', 'branch', 'targetBranch']) if (event[field] !== undefined) thread.gitlab[field] = event[field]
        if (event.type === 'mr.accept.requested') { thread.gitlab.approvedSha = event.sha; thread.gitlab.approvalSeq = event.seq; thread.gitlab.approvalResolved = event.resolved ?? true }
        if (event.type === 'mr.published' && previous.approvedSha !== event.sha) { thread.gitlab.approvedSha = null; thread.gitlab.approvalSeq = null }
        break
      }
      case 'mr.close.requested':
      case 'mr.close.failed':
      case 'mr.closed': {
        const thread = project.threads.get(event.threadId)
        if (thread) thread.gitlab = { ...thread.gitlab, status: event.type === 'mr.closed' ? event.notCreated ? 'cancelled' : 'closed' : event.type === 'mr.close.failed' ? 'close_error' : 'closing', error: event.error ?? null, approvedSha: null, approvalSeq: null, updatedAt: event.at }
        break
      }
      case 'decision.requested': {
        project.decisions.set(event.decisionId, {
          id: event.decisionId, threadId: event.threadId, question: event.question,
          options: event.options, recommended: event.recommended,
          chosen: null, chosenBy: null, at: event.at, seq: event.seq, messageId: event.messageId,
          withdrawn: false, withdrawnAt: null, withdrawReason: null, withdrawnBy: null,
        })
        const thread = project.threads.get(event.threadId)
        if (thread !== undefined) {
          thread.decisionIds.push(event.decisionId)
          if (thread.state === 'review_ready') thread.leftReviewAt = event.at
          if (thread.gitlab && thread.gitlab.status !== 'merged') thread.gitlab = { ...thread.gitlab, approvedSha: null, approvalSeq: null }
          if (thread.state !== 'blocked') thread.blockedFrom = thread.state
          thread.state = 'blocked'
          thread.updatedAt = event.at
        }
        break
      }
      case 'decision.answered': {
        const decision = project.decisions.get(event.decisionId)
        if (decision === undefined || decision.withdrawn) break
        decision.chosen = event.chosen
        decision.chosenBy = event.by
        decision.answeredAt = event.at
        const thread = project.threads.get(decision.threadId)
        // The worker acts on the answer, so the thread works again — unless another question still waits (bug 15).
        if (thread !== undefined && thread.state === 'blocked' && this.pendingDecisions(project, thread.id).length === 0) {
          thread.state = 'working'
          thread.blockedFrom = null
          thread.updatedAt = event.at
        }
        break
      }
      case 'decision.withdrawn': {
        const decision = project.decisions.get(event.decisionId)
        if (decision === undefined || decision.chosen !== null || decision.withdrawn) break
        decision.withdrawn = true
        decision.withdrawnAt = event.at
        decision.withdrawReason = event.reason ?? ''
        decision.withdrawnBy = event.by ?? null
        const thread = project.threads.get(decision.threadId)
        // The thread waited only for this; with nothing else pending it goes back to what it was doing before the
        // question. A delivered thread is still delivered (cloud-run-03 #166 bounced one to working; bug 14).
        if (thread !== undefined && thread.state === 'blocked' && this.pendingDecisions(project, thread.id).length === 0) {
          thread.state = thread.blockedFrom ?? 'working'
          thread.blockedFrom = null
          thread.updatedAt = event.at
        }
        break
      }
      case 'relay.sent': {
        const target = event.toThreadId ? project.threads.get(event.toThreadId) : undefined
        const source = event.fromThreadId ? project.threads.get(event.fromThreadId) : undefined
        const relay = { id: event.relayId, seq: event.seq, at: event.at, from: event.from, fromThreadId: event.fromThreadId, toThreadId: event.toThreadId, text: event.text, cited: event.cited ?? [] }
        target?.relays.push(relay)
        if (source !== undefined && source !== target) source.relays.push(relay)
        break
      }
      case 'reaction.added': {
        const message = project.messages.get(event.messageId)
        if (message !== undefined) message.reactions[event.emoji] = (message.reactions[event.emoji] ?? 0) + 1
        break
      }
      case 'session.bound': {
        const previous = project.sessions.get(event.key)
        if (previous !== undefined) this.sessionIndex.delete(previous.sessionId)
        if (previous !== undefined && previous.sessionId !== event.sessionId) this.formerIndex.set(previous.sessionId, { projectId: project.id, key: event.key })
        this.formerIndex.delete(event.sessionId)
        project.sessions.set(event.key, {
          sessionId: event.sessionId, node: event.node ?? 'local', boundAt: event.at,
          generation: event.generation ?? 1, assignee: event.assignee, continuity: event.continuity === true,
          configRevision: event.configRevision ?? 0, runtime: event.runtime ?? 'dsh',
          externalSessionId: event.externalSessionId ?? null, takeoverCommand: event.takeoverCommand ?? null,
        })
        this.sessionIndex.set(event.sessionId, { projectId: project.id, key: event.key })
        break
      }
      case 'runtime.session': {
        const binding = project.sessions.get(event.key)
        if (binding?.sessionId === event.sessionId) {
          binding.externalSessionId = event.externalSessionId
          binding.takeoverCommand = event.takeoverCommand ?? null
        }
        break
      }
      case 'inbox.acked': {
        const current = project.cursors.get(event.key) ?? 0
        project.cursors.set(event.key, Math.max(current, event.cursor))
        break
      }
      case 'tool.called': {
        project.activity.set(event.key, { tool: event.tool, ok: event.ok !== false, at: event.at, ms: event.ms ?? 0, error: event.error })
        const count = project.toolCalls.get(event.key) ?? new Map()
        count.set(event.tool, (count.get(event.tool) ?? 0) + 1)
        project.toolCalls.set(event.key, count)
        break
      }
      case 'turn.ended': {
        project.turns.set(event.key, {
          at: event.at, silent: event.silent === true, nudged: event.nudged === true, unanswered: event.unanswered === true,
          failed: event.failed === true, error: event.error,
        })
        break
      }
      case 'turn.failed': {
        // A failed wake, recorded separately so Mira can see it as an observation.
        project.turns.set(event.key, { at: event.at, silent: false, nudged: false, failed: true, error: event.error })
        break
      }
      case 'memory.updated': {
        const next = emptyMemory()
        for (const section of MEMORY_SECTIONS) {
          next[section] = Array.isArray(event.memory?.[section]) ? event.memory[section].map(item => ({ text: item.text, evidence: item.evidence ?? [], at: item.at ?? event.at })) : []
        }
        next.updatedAt = event.at
        project.memory = next
        break
      }
      case 'memory.fact.added': {
        project.memory.facts.push({ text: event.text, evidence: event.evidence ?? [], at: event.at })
        project.memory.updatedAt = event.at
        break
      }
      case 'memory.item.removed': {
        const list = project.memory[event.section]
        if (Array.isArray(list) && Number.isInteger(event.index) && event.index >= 0 && event.index < list.length) {
          list.splice(event.index, 1)
          project.memory.updatedAt = event.at
        }
        break
      }
      case 'card.proposed': {
        if (event.supersedes !== undefined) {
          const old = project.cards.get(event.supersedes)
          if (old !== undefined && old.state === 'open') { old.state = 'superseded'; old.closedAt = event.at }
        }
        project.cards.set(event.cardId, {
          id: event.cardId, kind: event.kind, title: event.title, body: event.body ?? '',
          threadId: event.threadId ?? null, actions: event.actions ?? [], evidence: event.evidence ?? [],
          confidence: event.confidence ?? null, at: event.at, state: 'open', actedWith: null, closedAt: null, closedNote: null,
          // Hub cards point into a project and carry cross-project evidence refs ("p_x#12").
          ...(event.target !== undefined ? { target: event.target, refs: event.refs ?? [], level: event.level ?? 'board' } : {}),
        })
        project.cardOrder.push(event.cardId)
        break
      }
      case 'card.acted': {
        const card = project.cards.get(event.cardId)
        if (card !== undefined && card.state === 'open') { card.state = 'acted'; card.actedWith = event.actionId; card.closedAt = event.at }
        break
      }
      case 'card.dismissed': {
        const card = project.cards.get(event.cardId)
        if (card !== undefined && card.state === 'open') { card.state = 'dismissed'; card.closedAt = event.at }
        break
      }
      case 'card.withdrawn': {
        const card = project.cards.get(event.cardId)
        if (card !== undefined && card.state === 'open') {
          card.state = event.reason === 'expired' ? 'expired' : event.reason === 'stale' ? 'stale' : 'withdrawn'
          card.closedAt = event.at
          // r29: Mira's own reason (cloud-run-26 #321 「用户已验收卡片样式，不用再提醒」) is the note; stale / expired carry the host's.
          card.closedNote = event.note ?? (card.state === 'withdrawn' && event.reason ? String(event.reason) : null)
        }
        break
      }
      case 'mira.requested': {
        if (event.reason === 'morning') project.morningDay = dayKey(event.at)
        if (event.reason === 'evening') project.eveningDay = dayKey(event.at)
        break
      }
      case 'recap.written': {
        project.recaps.push({ seq: event.seq, at: event.at, day: event.day, kind: event.kind, headline: event.headline, sections: event.sections ?? {} })
        break
      }
      case 'hub.memory.updated': {
        project.hubMemory = { ...event.memory, updatedAt: event.at }
        break
      }
      case 'hub.memory.forgotten': {
        const list = project.hubMemory?.[event.section]
        if (list) project.hubMemory = { ...project.hubMemory, [event.section]: list.filter(item => item.text !== event.text) }
        project.hubForgotten.push({ section: event.section, text: event.text, refs: event.refs ?? [], at: event.at })
        break
      }
      case 'hub.memory.restored': {
        const index = project.hubForgotten.findIndex(f => f.section === event.section && f.text === event.text)
        if (index < 0) break
        const [back] = project.hubForgotten.splice(index, 1)
        const list = project.hubMemory?.[event.section] ?? []
        if (!list.some(item => item.text === back.text)) project.hubMemory = { ...(project.hubMemory ?? {}), [event.section]: [...list, { text: back.text, refs: back.refs }] }
        break
      }
      case 'about.added': {
        project.about.set(event.itemId, { id: event.itemId, seq: event.seq, at: event.at, text: event.text, source: event.source ?? { kind: 'typed' }, history: [], forgottenAt: null, ackedAt: null })
        project.aboutOrder.push(event.itemId)
        break
      }
      case 'about.edited': {
        const item = project.about.get(event.itemId)
        if (item === undefined) break
        item.history.push({ text: item.text, until: event.at })
        item.text = event.text
        break
      }
      case 'about.forgotten': {
        const item = project.about.get(event.itemId)
        if (item) Object.assign(item, { forgottenAt: event.at, forgottenWhy: event.reason ?? null, replacedBy: event.replacedBy ?? null, ackedAt: null })
        break
      }
      case 'about.restored': {
        const item = project.about.get(event.itemId)
        if (item) Object.assign(item, { forgottenAt: null, forgottenWhy: null, replacedBy: null, kept: true, ackedAt: event.at })
        break
      }
      case 'assistant.look':
        project.assistantLook = event.look ?? null
        break
      case 'about.acked': {
        for (const id of event.itemIds ?? []) { const item = project.about.get(id); if (item) item.ackedAt = event.at }
        break
      }
      case 'pc.activity':
        project.activities.set(event.windowKey, event)
        break
      case 'pc.window':
      case 'pc.signal': {
        project.pc.push(event)
        if (event.deviceId && event.eventId) project.pcIds.add(`${event.deviceId}|${event.eventId}`)
        break
      }
      default:
        break
    }
  }
}
