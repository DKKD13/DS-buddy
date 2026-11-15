/**
 * v4: the developer view of the background workers. Read-only and computed from the hub log on every request, like the
 * day board: which fragments (a device's observations) each worker was given, what it wrote from them, and what is
 * still waiting or failed. It decides nothing: every state here is a worker's own condition read back, and the model
 * input shown is built by the worker's own `input()`.
 */
import { HISTORY_MINUTES, HISTORY_SYSTEM, firstPerson } from './computer-history.js'
import { FOLLOWUP_GRACE_MS, FOLLOWUP_MAX_AGE_MS, FOLLOWUP_RULES, FOLLOWUP_SYSTEM, waitingConversations } from './followups.js'
import { ATTENTION_DAILY_WAKES, ATTENTION_QUIET, attentionMode } from './attention.js'
import { dayBounds } from './today.js'
import { autoMemoryView } from './auto-memory.js'

const WINDOW_MS = HISTORY_MINUTES * 60_000
const KEY = 'mira'
/** What lands in the assistant's inbox and starts a turn. */
const INBOX = new Set(['message.posted', 'project.attention', 'feishu.attention', 'mira.requested', 'card.acted', 'card.dismissed'])
const clip = (text, n) => { const one = String(text ?? '').replace(/\s+/g, ' ').trim();return (one.length > n ? one.slice(0, n) + '…' : one).toWellFormed() }
const fail = message => { throw Error(message) }
const byTime = (a, b) => a.occurredAt - b.occurredAt || a.seq - b.seq
const count = (items, of) => { const out = {};for (const item of items) out[of(item)] = (out[of(item)] ?? 0) + 1;return out }

/** One observation as the page shows it; its text is whatever the retention setting still allows. */
function fragment(observations, e, length) {
  const view = observations.view(e)
  return { ref: view.ref, at: e.occurredAt, source: e.source, app: clip(e.app, 40), title: clip(view.title, 80), text: clip(view.text, length),
    own: firstPerson(e), mine: /:me$/.test(String(e.eventId ?? '')), important: e.important === true, expired: view.sourceState === 'expired' }
}
const accepted = observations => [...observations.records.values()].filter(e => e.type === 'observation.accepted')
const readable = (observations, e) => !e.sourceExpired && !observations.retention?.isExpired(e)

function sourcesView(observations, inDay, now) {
  const today = accepted(observations).filter(e => inDay(e.occurredAt))
  const hours = Array.from({ length: 24 }, () => ({}))
  for (const e of today) { const hour = hours[new Date(e.occurredAt).getHours()];hour[e.source] = (hour[e.source] ?? 0) + 1 }
  return { total: today.length, bySource: count(today, e => e.source), mine: today.filter(e => /:me$/.test(String(e.eventId ?? ''))).length,
    important: today.filter(e => e.important === true).length, lastAt: today.reduce((n, e) => Math.max(n, e.occurredAt), 0) || null, hours,
    devices: [...observations.devices.values()].map(d => ({ name: d.name, receivedAt: d.receivedAt, connection: now - d.receivedAt < 90_000 ? 'recent' : 'stale',
      enabled: observations.policy(d.deviceId).enabled === true, wakeMinutes: observations.policy(d.deviceId).importantWakeMinutes })) }
}

/** Every 10-minute window of the day that has observations or was written, newest first, with where the history worker stands on it. */
function historyView(hub, { history, observations }, inDay, now) {
  const windows = new Map()
  const slot = (deviceId, start) => {
    const key = `${deviceId}|${start}`
    if (!windows.has(key)) windows.set(key, { key, deviceId, start, end: start + WINDOW_MS, all: [], events: [], received: 0 })
    return windows.get(key)
  }
  for (const e of accepted(observations)) {
    const start = Math.floor(e.occurredAt / WINDOW_MS) * WINDOW_MS
    if (!inDay(start)) continue
    const w = slot(e.deviceId, start)
    w.all.push(e)
    if (readable(observations, e)) { w.events.push(e);w.received = Math.max(w.received, e.receivedAt ?? 0) }
  }
  for (const done of hub.activities.values()) if (inDay(done.start)) slot(done.deviceId, done.start)
  const queued = new Set(history.ready().map(w => w.key))
  const rows = [...windows.values()].sort((a, b) => b.start - a.start || a.key.localeCompare(b.key)).map(w => {
    const done = hub.activities.get(w.key), failed = history.failures.get(w.key), own = w.events.filter(firstPerson).length
    const state = queued.has(w.key) ? (failed ? 'retrying' : done ? 'rewrite' : 'queued')
      : done ? 'written'
      : failed ? (failed.attempts >= history.maxAttempts ? 'gave-up' : 'retrying')
      : now < w.end ? 'open'
      : now < w.end + history.settleMs || now < w.received + history.settleMs ? 'settling'
      : w.events.length ? 'skipped' : 'expired'
    return { key: w.key, start: w.start, end: w.end, deviceName: observations.devices.get(w.deviceId)?.name || w.deviceId, fragments: w.all.length,
      bySource: count(w.all, e => e.source), own, state, attempts: failed?.attempts ?? 0, retryAt: failed?.retryAt ?? null,
      writtenAt: done?.at ?? null, version: done?.version ?? 0, asked: !done ? null : done.activities.length ? true : w.events.length ? own > 0 : null,
      activities: (done?.activities ?? []).map(a => ({ title: a.title, detail: a.detail, apps: a.apps, refs: a.refs })) }
  })
  return { minutes: HISTORY_MINUTES, settleMinutes: history.settleMs / 60_000, perTick: history.perTick, states: count(rows, r => r.state), windows: rows }
}

/** One window in full: the observations in it, the exact text the worker hands the model for them now, and what was written. */
export function historyWindowDetail(hub, { history, observations }, key) {
  const text = String(key ?? ''), cut = text.lastIndexOf('|'), deviceId = text.slice(0, cut), start = Number(text.slice(cut + 1))
  if (cut < 1 || !Number.isSafeInteger(start) || start % WINDOW_MS !== 0) fail('窗口标识无效')
  const all = accepted(observations).filter(e => e.deviceId === deviceId && e.occurredAt >= start && e.occurredAt < start + WINDOW_MS).sort(byTime)
  const done = hub.activities.get(text)
  if (!all.length && !done) fail('没有这个窗口')
  const events = all.filter(e => readable(observations, e)), own = events.filter(firstPerson).length
  const cited = new Set((done?.activities ?? []).flatMap(a => a.refs))
  return { key: text, start, end: start + WINDOW_MS, deviceName: observations.devices.get(deviceId)?.name || deviceId, asked: own > 0, readable: events.length,
    system: HISTORY_SYSTEM, input: own ? history.input({ key: text, deviceId, start, end: start + WINDOW_MS, events }) : '',
    fragments: all.map(e => ({ ...fragment(observations, e, 600), cited: cited.has(`hub#${e.seq}`) })),
    written: done ? { at: done.at, version: done.version, rules: done.rules, activities: done.activities } : null }
}

function followupView(hub, { followups }, inDay, now) {
  const judged = new Map(), titles = new Map()
  for (const e of hub.events) if (e.type === 'followup.judged') judged.set(e.conversation, e)
  const waiting = waitingConversations(hub)
  for (const chat of waiting) titles.set(chat.id, chat.title)
  const rows = waiting.map(chat => {
    const j = judged.get(chat.id), current = j?.fingerprint === chat.fingerprint && j.rules === FOLLOWUP_RULES, failed = followups.failures.get(chat.id)
    const since = chat.asks[0].occurredAt, at = chat.asks.at(-1).occurredAt, failing = failed?.fingerprint === chat.fingerprint
    const state = now - at > FOLLOWUP_MAX_AGE_MS ? 'too-old' : now - since < FOLLOWUP_GRACE_MS ? 'grace'
      : current ? (j.needsReply ? 'owed' : 'no-reply') : failing ? (failed.attempts >= followups.maxAttempts ? 'gave-up' : 'retrying') : 'queued'
    return { id: chat.id, title: clip(chat.title, 60) || '飞书会话', asks: chat.asks.length, since, at, state, ask: current ? j.ask : '', judgedAt: current ? j.at : null }
  }).sort((a, b) => b.at - a.at)
  return { graceMinutes: FOLLOWUP_GRACE_MS / 60_000, maxAgeHours: FOLLOWUP_MAX_AGE_MS / 3600_000, states: count(rows, r => r.state),
    conversations: rows.filter(r => r.state !== 'too-old'),
    judgments: hub.events.filter(e => e.type === 'followup.judged' && inDay(e.at)).reverse()
      .map(e => ({ at: e.at, id: e.conversation, title: clip(titles.get(e.conversation), 60), needsReply: e.needsReply, ask: e.ask, refs: e.refs })) }
}

/** One Feishu conversation: its last messages, and the exact text the owed-reply worker hands the model while it still waits. */
export function conversationDetail(hub, { followups, observations }, id) {
  if (typeof id !== 'string' || !id || id.length > 200) fail('会话标识无效')
  const chat = waitingConversations(hub).find(c => c.id === id)
  const messages = chat?.messages ?? accepted(observations).filter(e => e.source === 'lark' && e.correlationId === id).sort(byTime)
  if (!messages.length) fail('没有这个会话')
  const asks = new Set(chat?.asks ?? []), judged = hub.events.filter(e => e.type === 'followup.judged' && e.conversation === id).at(-1)
  const shown = [...new Set([...messages.slice(-12), ...asks])].sort(byTime)
  return { id, title: clip(messages.at(-1).title, 60) || '飞书会话', waiting: Boolean(chat), system: FOLLOWUP_SYSTEM,
    input: chat && shown.every(e => readable(observations, e)) ? followups.input(chat) : '',
    fragments: shown.map(e => ({ ...fragment(observations, e, 600), ask: asks.has(e), cited: judged?.refs?.includes(`hub#${e.seq}`) ?? false })),
    judged: judged ? { at: judged.at, needsReply: judged.needsReply, ask: judged.ask, refs: judged.refs, current: Boolean(chat) && judged.fingerprint === chat.fingerprint && judged.rules === FOLLOWUP_RULES } : null }
}

function attentionView(hub, inDay, now) {
  const hour = new Date(now).getHours(), dayStart = new Date(now).setHours(0, 0, 0, 0)
  return { mode: attentionMode(hub), quiet: ATTENTION_QUIET, quietNow: hour >= ATTENTION_QUIET.from || hour < ATTENTION_QUIET.to, dailyWakes: ATTENTION_DAILY_WAKES,
    wokeToday: hub.events.filter(e => e.type === 'feishu.attention' && e.woke && e.raisedAt >= dayStart).length,
    items: hub.events.filter(e => (e.type === 'feishu.attention' || e.type === 'feishu.attention.observed') && inDay(e.raisedAt)).reverse()
      .map(e => ({ at: e.raisedAt, raised: e.type === 'feishu.attention', woke: e.woke === true, id: e.conversation, title: clip(e.title, 60), who: clip(e.who, 30), ask: e.ask, count: e.count })) }
}

/** The assistant's turns of the day, newest first: what was new in its inbox when it read it, and the tools it then called. */
function turnsView(hub, inDay) {
  const out = []
  let waiting = [], tools = [], cursor = 0, read = 0
  for (const e of hub.events) {
    if (INBOX.has(e.type) && (e.type !== 'message.posted' || e.author?.kind === 'human')) waiting.push(e)
    if (e.key !== KEY) continue
    if (e.type === 'tool.called') tools.push({ tool: e.tool, ok: e.ok !== false, ms: e.ms ?? null })
    else if (e.type === 'inbox.acked') read = Math.max(read, e.cursor)
    else if (e.type === 'turn.ended') {
      cursor = Math.max(cursor, read)
      const seen = waiting.filter(x => x.seq <= cursor)
      waiting = waiting.filter(x => x.seq > cursor)
      if (inDay(e.at)) out.push({ at: e.at, silent: e.silent === true, tools,
        inbox: Object.entries(count(seen, x => x.type === 'mira.requested' ? `request:${x.observationRef ? 'important' : x.reason}` : x.type)).map(([kind, n]) => ({ kind, n })) })
      tools = []
    }
  }
  return out.reverse()
}

export function workersView(hub, parts, { day, now = Date.now() } = {}) {
  const bounds = dayBounds(day, now), inDay = at => at >= bounds.start && at < bounds.end
  return { day: bounds.day, today: dayBounds(undefined, now).day, now, tickSeconds: 60,
    sources: sourcesView(parts.observations, inDay, now), history: historyView(hub, parts, inDay, now),
    followups: followupView(hub, parts, inDay, now), attention: attentionView(hub, inDay, now), turns: turnsView(hub, inDay),
    memory: parts.autoMemory ? autoMemoryView(hub, parts.autoMemory, inDay) : null }
}
