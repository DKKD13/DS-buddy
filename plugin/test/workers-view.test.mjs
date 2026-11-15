import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../lib/store.js'
import { ensureHub } from '../lib/hub.js'
import { Observations } from '../lib/observations.js'
import { ComputerHistory, HISTORY_SYSTEM } from '../lib/computer-history.js'
import { Followups, FOLLOWUP_SYSTEM } from '../lib/followups.js'
import { FeishuAttention } from '../lib/attention.js'
import { workersView, historyWindowDetail, conversationDetail } from '../lib/workers-view.js'
import { workersHtml } from '../lib/workers-page.js'

// The owner's day and clock are China time, as on the machine that runs this.
process.env.TZ = 'Asia/Shanghai'
const T = text => Date.parse(`2026-11-07T${text}:00+08:00`)
const hm = at => new Date(at).toTimeString().slice(0, 5)
const DM = 'lark-chat.oc_dm'
const waitingRefs = input => [...input.matchAll(/\[(hub#\d+)\][^\n]*（待回）/g)].map(m => m[1])

/** The real workers over one hub log, with the clock (the store's included) in the test's hands. */
async function setup(t, { wakeMinutes = 0 } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: T('10:00') })
  const root = mkdtempSync(join(tmpdir(), 'mira-workers-'));t.after(() => rmSync(root, { recursive: true, force: true }))
  const hub = new ProjectStore(join(root, 'hub-store'), { warn() {} });hub.load();ensureHub(hub)
  const projects = new ProjectStore(join(root, 'projects'), { warn() {} });projects.load()
  const wakes = []
  const observations = new Observations(hub, projects, { root: join(root, 'images'), notify: event => wakes.push(event) })
  t.after(() => observations.close())
  observations.hello('mac-1', '我的 Mac')
  const { revision } = await observations.configure({ deviceId: 'mac-1', policy: { enabled: true, importantWakeMinutes: wakeMinutes }, expectedRevision: 0, requestId: 'on' })
  let n = 0
  const observe = async (at, extra) => {
    const event = { eventId: 'e' + ++n, localSeq: n, source: 'screen', occurredAt: at, app: 'Code', title: 'gateway.js', text: '屏幕文字', ...extra }
    const { receipts } = await observations.ingest('mac-1', { revision, events: [event] })
    assert.equal(receipts[0].status, 'accepted')
    return receipts[0].ref
  }
  const lark = (at, text, { id, me = false, chat = DM, title = '单聊', toMe = !me }) =>
    observe(at, { eventId: `lark:${id}:${at}${me ? ':me' : ''}`, source: 'lark', app: '飞书', title, text, correlationId: chat, important: toMe })
  const calls = [], asked = []
  let answer = () => '{"activities":[]}'
  const history = new ComputerHistory({ hubStore: hub, observations, projects, timeZone: 'Asia/Shanghai', logger: { warn() {} },
    complete: async request => { calls.push(request);return answer(request) } })
  const followups = new Followups({ hubStore: hub, logger: { warn() {} },
    complete: async request => { asked.push(request);return JSON.stringify({ needsReply: true, ask: '确认明天部署的时间', refs: waitingRefs(request.input) }) } })
  const attention = new FeishuAttention({ hubStore: hub, request: reason => wakes.push(reason) })
  const parts = { history, followups, observations }, log = () => hub.get('hub')
  return { hub, log, parts, observe, lark, history, followups, attention, calls, asked, wakes,
    answer: fn => { answer = fn }, at: text => t.mock.timers.setTime(T(text)), view: day => workersView(log(), parts, { day }) }
}

test('every 10-minute window shows where the history worker stands on it, and its detail is the worker\'s own input with the cited fragments marked', async t => {
  const f = await setup(t)
  f.at('10:02');const screen = await f.observe(T('10:01'), { text: '正在写 gateway' })
  f.at('10:05');const ask = await f.lark(T('10:04'), '张三：明天的部署你几点方便？', { id: 'om_1' })
  f.at('10:12');await f.observe(T('10:11'), { title: 'history.js' })

  let v = f.view()
  assert.equal(v.day, '2026-11-07');assert.equal(v.today, '2026-11-07')
  assert.deepEqual([v.sources.total, v.sources.bySource, v.sources.important, v.sources.mine, v.sources.hours[10]], [3, { screen: 2, lark: 1 }, 1, 0, { screen: 2, lark: 1 }])
  assert.deepEqual(v.sources.devices.map(d => [d.name, d.enabled, d.wakeMinutes]), [['我的 Mac', true, 0]])
  assert.deepEqual(v.history.windows.map(w => [hm(w.start), w.state, w.fragments, w.own, w.asked]), [['10:10', 'open', 1, 1, null], ['10:00', 'settling', 2, 1, null]])

  f.at('10:14')
  assert.equal(f.view().history.windows[1].state, 'queued', 'closed and settled: the worker takes it on its next pass')
  f.answer(() => JSON.stringify({ activities: [{ title: '改设备接入', detail: '写设备入口', apps: ['Code'], project: '', refs: [screen] }] }))
  await f.history.tick()
  assert.equal(f.calls.length, 1)
  v = f.view()
  assert.deepEqual(v.history.windows.map(w => [hm(w.start), w.state, w.asked, w.activities.map(a => a.title)]), [['10:10', 'open', null, []], ['10:00', 'written', true, ['改设备接入']]])
  assert.deepEqual(v.history.states, { open: 1, written: 1 })

  const key = 'mac-1|' + T('10:00'), detail = historyWindowDetail(f.log(), f.parts, key)
  assert.equal(detail.input, f.calls[0].input, 'the text shown is what the worker hands the model')
  assert.equal(detail.system, HISTORY_SYSTEM)
  assert.deepEqual(detail.fragments.map(x => [x.ref, x.source, x.own, x.important, x.cited]), [[screen, 'screen', true, false, true], [ask, 'lark', false, true, false]])
  assert.deepEqual([detail.asked, detail.readable, detail.written.version, detail.written.activities.map(a => a.refs)], [true, 2, 1, [[screen]]])
  for (const bad of ['', 'nope', 'mac-1|123', '|' + T('10:00')]) assert.throws(() => historyWindowDetail(f.log(), f.parts, bad), /窗口标识无效/)
  assert.throws(() => historyWindowDetail(f.log(), f.parts, 'mac-1|' + T('08:00')), /没有这个窗口/)

  // A window holding only other people's messages is recorded as empty without a model call.
  f.at('10:21');await f.lark(T('10:20'), '李四：大家看下新字段', { id: 'om_g', chat: 'lark-chat.oc_group', title: '达标讨论群', toMe: false })
  f.at('10:34');await f.history.tick()
  assert.equal(f.calls.length, 2, 'the 10:10 window went to the model; the 10:20 one did not')
  v = f.view()
  assert.deepEqual(v.history.windows.map(w => [hm(w.start), w.state, w.own, w.asked]), [['10:20', 'written', 0, false], ['10:10', 'written', 1, true], ['10:00', 'written', 1, true]])
  const quiet = historyWindowDetail(f.log(), f.parts, 'mac-1|' + T('10:20'))
  assert.deepEqual([quiet.asked, quiet.input, quiet.written.activities], [false, '', []])

  // A window the model failed on waits for its retry.
  f.at('10:32');await f.observe(T('10:31'), { title: 'retry.js' })
  f.answer(() => { throw new Error('模型超时') })
  f.at('10:44');await f.history.tick()
  const failed = f.view().history.windows[0]
  assert.deepEqual([hm(failed.start), failed.state, failed.attempts], ['10:30', 'retrying', 1])
  assert.ok(failed.retryAt > T('10:44'))

  // Another day has none of it.
  const before = f.view('2026-11-06')
  assert.deepEqual([before.day, before.today, before.sources.total, before.history.windows, before.turns], ['2026-11-06', '2026-11-07', 0, [], []])
})

test('a conversation that waits for the owner moves from grace to queued to judged, and the attention router\'s record shows beside it', async t => {
  const f = await setup(t)
  f.at('10:05');const ask = await f.lark(T('10:04'), '张三：明天的部署你几点方便？', { id: 'om_1' })
  f.at('10:14')
  assert.deepEqual(f.view().followups.conversations.map(c => [c.id, c.title, c.asks, c.state, c.ask]), [[DM, '单聊', 1, 'grace', '']])
  f.at('10:35')
  assert.equal(f.view().followups.conversations[0].state, 'queued')
  await f.followups.tick()
  assert.equal(f.asked.length, 1)
  let v = f.view()
  assert.deepEqual(v.followups.conversations.map(c => [c.state, c.ask]), [['owed', '确认明天部署的时间']])
  assert.deepEqual(v.followups.judgments.map(j => [j.id, j.title, j.needsReply, j.refs]), [[DM, '单聊', true, [ask]]])

  let detail = conversationDetail(f.log(), f.parts, DM)
  assert.equal(detail.input, f.asked[0].input, 'the text shown is what the worker hands the model')
  assert.equal(detail.system, FOLLOWUP_SYSTEM)
  assert.deepEqual(detail.fragments.map(x => [x.ref, x.ask, x.cited, x.mine]), [[ask, true, true, false]])
  assert.deepEqual([detail.waiting, detail.judged.needsReply, detail.judged.current], [true, true, true])

  // The router is in its default mode: it writes down what it would have raised and wakes nobody.
  f.attention.tick()
  v = f.view()
  assert.deepEqual([v.attention.mode, v.attention.wokeToday, v.attention.dailyWakes], ['observe', 0, 8])
  assert.deepEqual(v.attention.items.map(x => [x.id, x.raised, x.woke, x.who, x.ask]), [[DM, false, false, '张三', '确认明天部署的时间']])
  assert.deepEqual(f.wakes, [])

  // The owner writes back: nothing waits, and the detail says so without rebuilding an input.
  f.at('10:41');const mine = await f.lark(T('10:40'), '林一（我）：下午三点吧', { id: 'om_2', me: true })
  assert.deepEqual(f.view().followups.conversations, [])
  detail = conversationDetail(f.log(), f.parts, DM)
  assert.deepEqual([detail.waiting, detail.input, detail.judged.current], [false, '', false])
  assert.deepEqual(detail.fragments.map(x => [x.ref, x.mine, x.ask]), [[ask, false, false], [mine, true, false]])
  for (const bad of [undefined, '', 'x'.repeat(201)]) assert.throws(() => conversationDetail(f.log(), f.parts, bad), /会话标识无效/)
  assert.throws(() => conversationDetail(f.log(), f.parts, 'lark-chat.none'), /没有这个会话/)
})

test('each turn of the assistant lists what woke it and the tools it called, and a wake from an important fragment is told apart', async t => {
  const f = await setup(t, { wakeMinutes: 20 })
  f.at('10:05');const ask = await f.lark(T('10:04'), '张三：明天的部署你几点方便？', { id: 'om_1' })
  const request = f.log().events.findLast(e => e.type === 'mira.requested')
  assert.deepEqual([request.reason, request.observationRef, f.wakes.length], ['attention', ask, 1], 'a direct message wakes the assistant at once')
  const put = event => f.hub.append('hub', event)
  f.at('10:06')
  put({ type: 'tool.called', key: 'mira', tool: 'hub_inbox_read', ok: true, ms: 12 })
  put({ type: 'inbox.acked', key: 'mira', cursor: request.seq })
  put({ type: 'tool.called', key: 'mira', tool: 'hub_no_reply', ok: true, ms: 3 })
  put({ type: 'turn.ended', key: 'mira', sessionId: 's1', silent: true })
  f.at('10:20')
  const said = put({ type: 'message.posted', messageId: f.hub.newMessageId(), threadId: null, author: { kind: 'human', id: 'owner' }, trust: 'principal', text: '今天还有什么要回的', mentions: [], to: [] })
  put({ type: 'mira.requested', reason: 'conversation', to: ['mira'] })
  f.at('10:21')
  put({ type: 'inbox.acked', key: 'mira', cursor: f.log().seq })
  put({ type: 'tool.called', key: 'mira', tool: 'hub_reply', ok: false, ms: 40 })
  put({ type: 'turn.ended', key: 'mira', sessionId: 's1', silent: false })
  assert.ok(said.seq > request.seq)

  const v = f.view()
  assert.deepEqual(v.sources.devices[0].wakeMinutes, 20)
  assert.deepEqual(v.turns.map(x => [hm(x.at), x.silent, x.inbox, x.tools]), [
    ['10:21', false, [{ kind: 'message.posted', n: 1 }, { kind: 'request:conversation', n: 1 }], [{ tool: 'hub_reply', ok: false, ms: 40 }]],
    ['10:06', true, [{ kind: 'request:important', n: 1 }], [{ tool: 'hub_inbox_read', ok: true, ms: 12 }, { tool: 'hub_no_reply', ok: true, ms: 3 }]],
  ])
})

test('the page is one self-contained document whose script parses', () => {
  const html = workersHtml(), script = /<script>([\s\S]*)<\/script>/.exec(html)[1]
  assert.match(html, /^<!doctype html>/)
  assert.ok(script.includes("'/api/mira-projects/workers'"))
  assert.doesNotThrow(() => new Function(script))
  assert.ok(!/innerHTML\s*=\s*[^'"]/.test(script.replaceAll("innerHTML=''", '')), 'fragment text reaches the page as text only')
})
