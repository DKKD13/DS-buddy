/** Project inbox bridge over DSH's durable native Schedule service. */
import { randomUUID } from 'node:crypto'
import { COORDINATOR, MIRA } from './store.js'

export function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('需要选择自动任务时间')
  if (raw.kind === 'after' && Number.isInteger(raw.seconds) && raw.seconds >= 1 && raw.seconds <= 30 * 86400) return { kind: 'after', seconds: raw.seconds }
  if (raw.kind === 'every' && Number.isInteger(raw.minutes) && raw.minutes >= 1 && raw.minutes <= 30 * 1440) return { kind: 'every', minutes: raw.minutes }
  if (raw.kind === 'daily' && typeof raw.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.time)) {
    const timeZone = raw.timeZone || 'Asia/Shanghai'
    try { new Intl.DateTimeFormat('en', { timeZone }).format() } catch { throw new Error('无效时区') }
    return { kind: 'daily', time: raw.time, timeZone }
  }
  throw new Error('一次任务需 1 秒–30 天；重复任务最短 1 分钟；每天任务需要 HH:mm')
}

const selector = rule => rule.kind === 'after' ? { after_seconds: rule.seconds }
  : rule.kind === 'every' ? { every_seconds: rule.minutes * 60 }
    : { daily: { time: rule.time, time_zone: rule.timeZone } }
const marker = task => `MIRA_PROJECTS_TIMER:${task.id}:${task.epoch}\nTransport only. Project inbox delivery is handled by Mira Projects.`

export class ProjectAutomations {
  constructor(ctx, store, driver) {
    this.ctx = ctx;this.store = store;this.driver = driver
    this.native = null;this.chain = Promise.resolve();this.stopped = false
    this.couriers = new WeakSet()
  }

  serial(work) {
    const result = this.chain.catch(() => {}).then(() => { if (this.stopped) throw new Error('调度桥已停止');return work() })
    this.chain = result.catch(() => {})
    return result
  }

  record(project, type, fields) {
    if (this.stopped) throw new Error('调度桥已停止')
    return this.store.append(project.id, { type, ...fields })
  }

  task(projectId, id) {
    const project = this.store.get(projectId), task = project.automations.get(id)
    if (!task) throw new Error('没有这个自动任务')
    return { project, task }
  }

  registerCourier(agent) {
    if (this.couriers.has(agent) || ![...this.store.projects.values()].some(p => p.courierSessionId === agent.id)) return
    this.couriers.add(agent)
    // The native scheduler only needs a durable inbox receipt. No model or project tool runs here.
    agent.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }), { prepend: true })
  }

  async courier(project) {
    const controller = this.driver.controller
    if (!controller) throw new Error('DSH 会话服务尚未就绪')
    if (!project.courierSessionId) this.record(project, 'automation.host.bound', { sessionId: 'session-' + randomUUID() })
    let resolved = await controller.resolveAgent(project.courierSessionId)
    if ('error' in resolved) {
      if (resolved.error?.code && resolved.error.code !== 'session/not-found') throw new Error('自动任务投递会话暂时无法恢复，请稍后重试')
      const workspaceId = await this.driver.workspaceFor(project)
      const created = await controller.create({ sessionId: project.courierSessionId, ...(workspaceId ? { workspaceId } : {}) })
      if (created.sessionId !== project.courierSessionId) this.record(project, 'automation.host.bound', { sessionId: created.sessionId })
      resolved = await controller.resolveAgent(created.sessionId)
    }
    if ('error' in resolved) throw new Error('无法恢复自动任务投递会话')
    this.registerCourier(resolved.agent)
    try { this.ctx.get('sessionTitle')?.rename(resolved.agent.session, `${project.name} · 定时投递`) } catch { /* title only */ }
    return project.courierSessionId
  }

  requireNative() { if (!this.native) throw new Error('DSH 持久调度服务尚未就绪') }

  async bind(project, task) {
    this.requireNative()
    const sessionId = await this.courier(project)
    const rows = await this.native.catalog()
    let record = rows.find(row => row.sessionId === sessionId && row.prompt === marker(task))
    if (!record) record = await this.native.create(sessionId, { title: `项目定时 · ${task.title}`, prompt: marker(task), ...selector(task.rule) })
    if (!record?.id) throw new Error('DSH 未返回有效定时任务')
    this.record(project, 'automation.bound', { automationId: task.id, nativeId: record.id, sessionId, schedule: record })
  }

  fail(project, task, error) {
    this.record(project, 'automation.failed', { automationId: task.id, error: String(error?.message ?? error).slice(0, 300) })
  }

  create({ projectId, title, prompt, target = COORDINATOR, rule, requestId }) {
    return this.serial(async () => {
      this.requireNative()
      const project = this.store.get(projectId)
      if (typeof title !== 'string' || !title.trim() || title.length > 80 || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('任务名需要 1–80 字，任务说明需要 1–4000 字')
      if (![COORDINATOR, MIRA].includes(target)) throw new Error('自动任务只能唤醒协调员或记忆助理')
      const cleanRule = normalizeRule(rule)
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId))) throw new Error('自动任务请求 id 无效')
      const previous = requestId && [...project.automations.values()].find(t => t.requestId === requestId)
      if (previous) {
        if (previous.title !== title.trim() || previous.prompt !== prompt.trim() || previous.target !== target || JSON.stringify(previous.rule) !== JSON.stringify(cleanRule)) throw new Error('该请求 id 已用于另一份自动任务，请重新创建')
        return { ok: true, automationId: previous.id, status: previous.status }
      }
      if ([...project.automations.values()].filter(t => t.enabled).length >= 10) throw new Error('每项目最多启用 10 个自动任务')
      const id = 'auto-' + randomUUID()
      this.record(project, 'automation.created', { automationId: id, requestId, title: title.trim(), prompt: prompt.trim(), target, rule: cleanRule, epoch: 1, by: { kind: 'human', id: 'owner' } })
      const task = project.automations.get(id)
      try { await this.bind(project, task) } catch (error) { this.fail(project, task, error) }
      return { ok: true, automationId: id, status: task.status }
    })
  }

  async stopNative(project, task) {
    this.requireNative()
    const rows = await this.native.catalog()
    const owned = rows.filter(row => row.sessionId === project.courierSessionId && (row.id === task.nativeId || row.prompt === marker(task)))
    for (const row of owned) await this.native.delete({ sessionId: row.sessionId, id: row.id })
    this.record(project, 'automation.stopped', { automationId: task.id, deleted: task.deleteWanted === true })
  }

  pause({ projectId, automationId, deleted = false }) {
    return this.serial(async () => {
      const { project, task } = this.task(projectId, automationId)
      this.record(project, 'automation.stop.requested', { automationId, deleted })
      try { await this.stopNative(project, task) } catch (error) { this.fail(project, task, error);throw error }
      return { ok: true }
    })
  }

  resume({ projectId, automationId }) {
    return this.serial(async () => {
      const { project, task } = this.task(projectId, automationId)
      if (task.status === 'deleted') throw new Error('自动任务已删除，请重新创建')
      if (!task.enabled && task.deleteWanted) throw new Error('该任务已有删除意图，请重试删除，不能作为恢复任务启用')
      if (task.enabled && task.status === 'active') return { ok: true }
      if (!task.enabled && [...project.automations.values()].filter(t => t.enabled).length >= 10) throw new Error('每项目最多启用 10 个自动任务')
      if (!task.enabled && ['error', 'stopping'].includes(task.status)) {
        try { await this.stopNative(project, task) } catch (error) { this.fail(project, task, error);throw error }
      }
      if (!task.enabled || task.status === 'complete') this.record(project, 'automation.resumed', { automationId, epoch: task.epoch + 1, by: { kind: 'human', id: 'owner' } })
      try { await this.bind(project, task) } catch (error) { this.fail(project, task, error);throw error }
      return { ok: true }
    })
  }

  async receipts(project, task, row) {
    if (!row.lastDelivery) return
    const occurrenceId = `${row.id}|${row.lastDelivery.scheduledAt}`
    if (task.occurrences.has(occurrenceId)) return
    const history = await this.native.history({ sessionId: row.sessionId, id: row.id, limit: 100 })
    if (!Array.isArray(history.records)) throw new Error('DSH 投递回执暂不可读')
    const pending = history.records.filter(r => !task.occurrences.has(`${row.id}|${r.scheduledAt}`) && (!task.lastRun || Date.parse(r.scheduledAt) > Date.parse(task.lastRun.scheduledAt)))
    if (!pending.length) return
    const latest = pending[0]
    const event = this.record(project, 'automation.triggered', {
      automationId: task.id, occurrenceId: `${row.id}|${latest.scheduledAt}`, scheduledAt: latest.scheduledAt,
      nativeId: row.id, receiptMessageId: latest.messageId, target: task.target, prompt: task.prompt, title: task.title,
      coalesced: pending.length - 1, earlierUnavailable: Boolean(history.nextBefore || history.earlierRecordsUnavailable),
      to: [task.target], by: { kind: 'system', id: 'schedule' },
    })
    this.driver.deliver(event, 'automation')
  }

  reconcile() {
    return this.serial(async () => {
      if (!this.native || !this.driver.controller) return
      let rows = await this.native.catalog()
      for (const project of this.store.projects.values()) {
        for (const task of project.automations.values()) {
          if (['deleted', 'paused', 'complete', 'missing'].includes(task.status)) continue
          try {
            if (!task.enabled) { await this.stopNative(project, task);continue }
            if (!task.nativeId) { await this.bind(project, task);rows = await this.native.catalog() }
            const row = rows.find(r => r.id === task.nativeId && r.sessionId === project.courierSessionId)
            if (!row) { this.record(project, 'automation.missing', { automationId: task.id });continue }
            if (task.status === 'error' || JSON.stringify(task.schedule) !== JSON.stringify(row)) this.record(project, 'automation.observed', { automationId: task.id, schedule: row })
            await this.receipts(project, task, row)
            if (row.status === 'inactive') this.record(project, 'automation.completed', { automationId: task.id })
          } catch (error) { if (!this.stopped) this.fail(project, task, error) }
        }
      }
    })
  }

  start() {
    const off = this.ctx.on('schedule/changed', () => { this.reconcile().catch(() => {}) })
    const timer = setInterval(() => { this.reconcile().catch(() => {}) }, 30000);timer.unref?.()
    this.reconcile().catch(() => {})
    return () => { this.stopped = true;off();clearInterval(timer) }
  }
}
