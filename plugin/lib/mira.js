/**
 * Mira's wake policy. Mira is not addressed by messages; she watches the
 * project and is woken when enough happened, when something needs the owner,
 * when the owner asks, or once a day for the morning card. The policy lives
 * here so the driver stays a plain inbox deliverer.
 */

import { MIRA, OBSERVABLE, dayKey } from './store.js'

export const URGENT_MS = 15_000
export const BUSY_MS = 45_000
export const QUIET_MS = 3 * 60_000
export const BUSY_COUNT = 8
const MORNING_HOUR = 6
const LOOKBACK_MS = 36 * 60 * 60_000
const TICK_MS = 10 * 60_000
const MIN_AGE_MS = 30 * 60_000
const MIN_EVENTS = 3

/** Events that should reach Mira soon: the owner is being asked for something, or asked for Mira. */
function urgent(event) {
  if (event.type === 'decision.requested' || event.type === 'mira.requested' || event.type === 'turn.failed') return true
  if (['mr.publish.failed', 'mr.merge.failed', 'mr.close.failed'].includes(event.type)) return true
  if (event.type === 'thread.updated' && ['review_ready', 'failed'].includes(event.patch?.state)) return true
  if (event.type === 'message.posted' && event.author?.kind === 'human' && Array.isArray(event.mentions) && event.mentions.includes(MIRA)) return true
  return false
}

/** Shared policy for the local timer and transactional cloud wake planning. */
export function planMiraWake(store, event) {
  if (event === undefined || event.projectId === undefined || !OBSERVABLE.has(event.type)) return null
  if (event.type === 'message.posted' && event.author?.id === MIRA) return null
  const project = store.projects.get(event.projectId)
  if (project === undefined || event.to?.includes(MIRA)) return null
  if (urgent(event)) return { delayMs: URGENT_MS, reason: 'attention' }
  return store.unread(project, MIRA).length >= BUSY_COUNT
    ? { delayMs: BUSY_MS, reason: 'activity' }
    : { delayMs: QUIET_MS, reason: 'quiet' }
}

export class MiraService {
  /**
   * @param {import('./store.js').ProjectStore} store
   * @param {import('./driver.js').Driver} driver
   * @param {import('./actions.js').Actions} actions
   * @param {{ now?: () => number, setTimer?: Function, clearTimer?: Function }} [clock] - injectable for tests.
   */
  constructor(store, driver, actions, clock = {}, options = {}) {
    this.store = store
    /** With the hub running, the morning recap is one card across all projects (hub.js), not one per project. */
    this.morning = options.morning !== false
    this.driver = driver
    this.actions = actions
    this.now = clock.now ?? (() => Date.now())
    // Unref'd: Mira's timers must never keep a host (or a test) alive on their own.
    this.setTimer = clock.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
    this.clearTimer = clock.clearTimer ?? (timer => clearTimeout(timer))
    /** projectId → { timer, due } */
    this.timers = new Map()
    this.off = undefined
    this.interval = undefined
  }

  start() {
    this.off = this.store.onChange(event => this.consider(event))
    this.interval = this.setTimer(() => this.tick(), TICK_MS)
    // After a restart, anything Mira has not seen yet is worth one quiet pass.
    for (const project of this.store.projects.values()) {
      if (this.store.unread(project, MIRA).length > 0) this.arm(project.id, QUIET_MS, 'recover')
    }
    return () => this.stop()
  }

  stop() {
    this.off?.()
    this.off = undefined
    if (this.interval !== undefined) this.clearTimer(this.interval)
    for (const entry of this.timers.values()) this.clearTimer(entry.timer)
    this.timers.clear()
  }

  /** One committed event: decide whether, and how soon, Mira should look. */
  consider(event) {
    const wake = planMiraWake(this.store, event)
    if (wake) this.arm(event.projectId, wake.delayMs, wake.reason)
  }

  /** Schedule a wake `delay` from now unless an earlier one is already pending. */
  arm(projectId, delay, reason) {
    const due = this.now() + delay
    const existing = this.timers.get(projectId)
    if (existing !== undefined) {
      if (existing.due <= due) return
      this.clearTimer(existing.timer)
    }
    const timer = this.setTimer(() => this.fire(projectId, reason), delay)
    this.timers.set(projectId, { timer, due, reason })
  }

  fire(projectId, reason) {
    this.timers.delete(projectId)
    const project = this.store.projects.get(projectId)
    if (project === undefined) return
    if (this.store.unread(project, MIRA).length === 0) return
    this.driver.schedule(projectId, MIRA, reason)
  }

  /** Periodic: the morning card, once per local day, for projects that had activity. */
  tick() {
    this.interval = this.setTimer(() => this.tick(), TICK_MS)
    for (const project of this.store.projects.values()) this.maybeMorning(project)
  }

  maybeMorning(project) {
    if (!this.morning) return false
    const now = this.now()
    const today = dayKey(now)
    if (project.morningDay === today) return false
    if (new Date(now).getHours() < MORNING_HOUR) return false
    // A project that just started has nothing to recap: wait until it is half an hour old and has a few settled events.
    const born = project.events[0]?.at ?? project.createdAt ?? now
    if (now - born < MIN_AGE_MS) return false
    const recent = project.events.filter(e => OBSERVABLE.has(e.type) && e.type !== 'mira.requested' && e.at > now - LOOKBACK_MS && e.at < now - 60_000)
    if (recent.length < MIN_EVENTS) return false
    try {
      return this.actions.miraRun({ projectId: project.id, reason: 'morning' }).skipped === undefined
    } catch {
      return false
    }
  }
}
