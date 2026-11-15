/**
 * v4: Mira watching Feishu around the clock, shaped like DeepSeek's Super-agent. Every minute the owed-reply check
 * (followups.js) is the fast path: code has already decided which messages reached the owner directly and are still
 * unanswered, and a one-off model call has said something is asked. This module routes what is new to Mira (the
 * router): it lands in her inbox as `feishu.attention` and wakes her with reason "attention", and she decides, with
 * the owner's tasks in view, whether it is a card, an interruption or nothing. Mode is off, observe (the default:
 * only record what would have been raised) or auto; quiet hours and a daily cap hold the wake, never the item.
 */
import { owedReplies } from './followups.js'

const HUB_ID = 'hub'
export const ATTENTION_MODES = ['off', 'observe', 'auto']
export const ATTENTION_DAILY_WAKES = 8
/** Local hours when Mira is not woken for Feishu: from 23:00 to 08:00. */
export const ATTENTION_QUIET = { from: 23, to: 8 }

export function attentionMode(hub) {
  const set = (hub?.events ?? []).filter(e => e.type === 'attention.mode').at(-1)
  return ATTENTION_MODES.includes(set?.mode) ? set.mode : 'observe'
}

/** How many of today's raised items woke the assistant: the number the daily cap counts and the settings page shows. */
export function attentionWokeToday(hub, now = Date.now()) {
  const dayStart = new Date(now).setHours(0, 0, 0, 0)
  return (hub?.events ?? []).filter(e => e.type === 'feishu.attention' && e.woke && e.raisedAt >= dayStart).length
}

const keyOf = e => `${e.conversation}|${e.through}`

export class FeishuAttention {
  constructor({ hubStore, request, now = Date.now, owed = owedReplies, dailyWakes = ATTENTION_DAILY_WAKES, quiet = ATTENTION_QUIET }) {
    Object.assign(this, { hubStore, request, now, owed, dailyWakes, quiet })
  }

  /** The owner's own switch on the settings page; asking the assistant (hub_attention_mode) is the other way. */
  setMode(mode) {
    if (!ATTENTION_MODES.includes(mode)) throw new Error('档位只能是 off、observe、auto')
    if (!this.hubStore.get(HUB_ID)) throw new Error('个人助理还没有启用')
    this.hubStore.append(HUB_ID, { type: 'attention.mode', mode, by: 'owner' })
    return { mode }
  }

  tick() {
    const hub = this.hubStore.get(HUB_ID), mode = attentionMode(hub)
    if (!hub || mode === 'off') return { mode, added: 0, woke: false }
    const now = this.now(), seen = new Set(hub.events.filter(e => e.type.startsWith('feishu.attention')).map(keyOf))
    const fresh = this.owed(hub, now).filter(item => !seen.has(keyOf(item)))
    if (!fresh.length) return { mode, added: 0, woke: false }
    const hour = new Date(now).getHours(), quiet = hour >= this.quiet.from || hour < this.quiet.to
    const wokeToday = attentionWokeToday(hub, now)
    const woke = mode === 'auto' && !quiet && wokeToday < this.dailyWakes
    for (const item of fresh) {
      this.hubStore.append(HUB_ID, { type: mode === 'auto' ? 'feishu.attention' : 'feishu.attention.observed',
        conversation: item.conversation, through: item.through, title: item.title, who: item.who, ask: item.ask, text: item.text,
        since: item.since, count: item.count, ref: item.ref, refs: item.refs, raisedAt: now, woke })
    }
    if (woke) try { this.request('attention') } catch { /* the hub may be gone; the item waits in her inbox */ }
    return { mode, added: fresh.length, woke }
  }
}
