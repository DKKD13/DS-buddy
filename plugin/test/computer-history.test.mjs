import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../lib/store.js'
import { ensureHub } from '../lib/hub.js'
import { Observations } from '../lib/observations.js'
import { ComputerHistory, parseActivities, HISTORY_RULES } from '../lib/computer-history.js'
import { buildDay, renderDay } from '../lib/today.js'

// The owner's day and clock are China time, as on the Mira machine.
process.env.TZ = 'Asia/Shanghai'
const T = text => Date.parse(`2026-11-07T${text}:00+08:00`)
const MIN = 60_000

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-history-'));t.after(() => rmSync(root, { recursive: true, force: true }))
  const hub = new ProjectStore(join(root, 'hub-store'), { warn() {} });hub.load();ensureHub(hub)
  const projects = new ProjectStore(join(root, 'projects'), { warn() {} });projects.load()
  const project = projects.createProject({ name: 'Mira' })
  let clock = T('10:00')
  const observations = new Observations(hub, projects, { root: join(root, 'images'), now: () => clock })
  t.after(() => observations.close())
  observations.hello('mac-1', '我的 Mac')
  const { revision } = await observations.configure({ deviceId: 'mac-1', policy: { enabled: true }, expectedRevision: 0, requestId: 'on' })
  let n = 0
  const observe = async (at, extra) => {
    const event = { eventId: 'e' + ++n, localSeq: n, source: 'screen', occurredAt: at, app: 'Code', title: 'gateway.js', text: '屏幕文字', ...extra }
    const { receipts } = await observations.ingest('mac-1', { revision, events: [event] })
    assert.equal(receipts[0].status, 'accepted')
    return receipts[0].ref
  }
  const calls = []
  let answer = () => '{"activities":[]}'
  const history = new ComputerHistory({ hubStore: hub, observations, projects, now: () => clock, timeZone: 'Asia/Shanghai',
    complete: async request => { calls.push(request);return answer(request) } })
  return { hub, projects, projectId: project.projectId, observations, observe, history, calls,
    answer: fn => { answer = fn }, at: text => { clock = T(text) }, advance: ms => { clock += ms }, now: () => clock }
}

const reply = activities => JSON.stringify({ activities })

test('each settled 10-minute window of a device becomes the activities the model wrote, citing only that window\'s observations', async t => {
  const f = await setup(t)
  f.at('10:02');const screen = await f.observe(T('10:01'), { text: '侧边栏 ' + '中间'.repeat(2000) + ' 正在写 gateway' })
  f.at('10:05');const lark = await f.observe(T('10:04'), { source: 'lark', app: '飞书', title: '达标讨论群', text: '林一（我）：标签先定 10 个' })
  f.at('10:12');await f.observe(T('10:11'), { title: 'history.js' })
  f.answer(() => '```json\n' + reply([
    { title: '改 Mira 设备接入', detail: '写完设备入口，顺手在群里定了标签数', apps: ['Code', '飞书'], project: 'Mira', refs: [screen, lark, 'hub#99999'] },
    { title: '编出来的事', detail: '没有依据', apps: [], project: '', refs: ['hub#99999'] },
  ]) + '\n```')

  f.at('10:12');await f.history.tick()
  assert.equal(f.calls.length, 0, 'a window is written only after it has closed and settled')
  f.at('10:14');await f.history.tick()
  assert.equal(f.calls.length, 1, 'only the first window is ready; the second is still open')
  const input = f.calls[0].input
  for (const piece of [`[${screen}]`, `[${lark}]`, '10:01', '林一（我）：标签先定 10 个', '10:00–10:10', 'Mira']) assert.ok(input.includes(piece), `input shows ${piece}`)
  assert.ok(input.includes('侧边栏 中间') && input.includes(' … 中间') && input.includes('正在写 gateway') && input.length < 4000, 'long screen text keeps its start and its end, not the middle')
  assert.ok(!input.includes('history.js'), 'the next window stays out')

  const written = [...f.hub.get('hub').activities.values()]
  assert.equal(written.length, 1)
  assert.deepEqual(written[0].activities, [{ title: '改 Mira 设备接入', detail: '写完设备入口，顺手在群里定了标签数', apps: ['Code', '飞书'], projectRef: f.projectId, refs: [screen, lark] }],
    'refs outside the window are dropped, and an activity with no evidence left is dropped')
  await f.history.tick()
  assert.equal(f.calls.length, 1, 'an understood window is not sent again')

  // A Feishu message for that window arrives late (the sensor was offline): the window is written again, replacing the first version.
  f.at('10:30');const late = await f.observe(T('10:08'), { source: 'lark', app: '飞书', title: '达标讨论群', text: '李四：好' })
  f.answer(request => reply([{ title: '改 Mira 设备接入', detail: '李四同意了标签数', apps: ['飞书'], project: 'Mira', refs: [screen, late] }]))
  f.at('10:31');await f.history.tick()
  assert.equal(f.calls.filter(c => c.input.includes('10:00–10:10')).length, 1, 'waits until the late arrival settles')
  f.at('10:34');await f.history.tick()
  const first = f.hub.get('hub').activities.get('mac-1|' + T('10:00'))
  assert.equal(first.version, 2)
  assert.equal(first.activities[0].detail, '李四同意了标签数')
  // What the computer shows now: the latest screen observation, never a Feishu message.
  assert.deepEqual(f.history.live(), { deviceName: '我的 Mac', app: 'Code', title: 'history.js', at: T('10:11'), recent: [] })
})

test('the day\'s timeline shows the computer\'s activities, one row for a thing that ran across windows, and Mira reads the same', async t => {
  const f = await setup(t)
  f.at('10:02');const a = await f.observe(T('10:01'))
  f.at('10:12');const b = await f.observe(T('10:11'))
  f.at('10:22');const c = await f.observe(T('10:21'), { eventId: 'lark:om_c:202611071021:me', app: '飞书', title: '达标讨论群', source: 'lark', text: '林一（我）：在的' })
  f.answer(request => request.input.includes('10:20–10:30')
    ? reply([{ title: '回飞书消息', detail: '', apps: ['飞书'], project: '', refs: [c] }])
    : reply([{ title: '改 Mira 设备接入', detail: request.input.includes('10:10–10:20') ? '接上了屏幕' : '写设备入口', apps: ['Code'], project: 'Mira', refs: [request.input.includes('10:10–10:20') ? b : a] }]))
  f.at('10:40');await f.history.tick()
  assert.equal(f.calls.length, 3)
  assert.ok(f.calls[1].input.includes('上一段：改 Mira 设备接入'), 'the next window sees what the previous one was, so the same thing keeps one name')

  const day = buildDay(f.projects, f.hub.get('hub'), { now: f.now() })
  const rows = day.timeline.filter(e => e.kind === 'activity')
  assert.deepEqual(rows.map(r => [r.title, r.at, r.end]), [['改 Mira 设备接入', T('10:00'), T('10:20')], ['回飞书消息', T('10:20'), T('10:30')]])
  assert.deepEqual([rows[0].detail, rows[0].projectId, rows[0].apps, rows[0].refs], ['接上了屏幕', f.projectId, ['Code'], [a, b]])
  const text = renderDay(day)
  const computer = text.slice(text.indexOf('## 电脑活动'))
  assert.ok(computer.includes('10:00–10:20') && computer.includes('改 Mira 设备接入'), 'today_read carries the activity for Mira, in its own section')
  assert.ok(computer.includes(`依据 ${a},${b}`))
  assert.ok(!text.slice(text.indexOf('## 时间线'), text.indexOf('## 电脑活动')).includes('改 Mira 设备接入'), 'project events keep the timeline to themselves')
})

test('a failed or unreadable model answer writes nothing and is tried again later; old windows are never backfilled', async t => {
  const f = await setup(t)
  f.at('09:00')
  await f.observe(T('09:00') - 2 * 24 * 3600_000 + MIN)
  f.at('10:02');const a = await f.observe(T('10:01'))
  f.answer(() => { throw Error('model down') })
  f.at('10:14');await f.history.tick()
  assert.equal(f.hub.get('hub').activities.size, 0)
  assert.equal(f.calls.length, 1, 'the two-day-old window is not sent')
  f.answer(() => 'not json')
  f.advance(MIN);await f.history.tick()
  assert.equal(f.calls.length, 1, 'waits before trying again')
  f.advance(5 * MIN);await f.history.tick()
  assert.equal(f.calls.length, 2)
  assert.equal(f.hub.get('hub').activities.size, 0)
  f.answer(() => reply([{ title: '改 Mira', detail: '', apps: [], project: '不存在的项目', refs: [a] }]))
  f.advance(10 * MIN);await f.history.tick()
  assert.deepEqual([...f.hub.get('hub').activities.values()][0].activities, [{ title: '改 Mira', detail: '', apps: [], projectRef: null, refs: [a] }], 'an unknown project is left unlinked')
})

test('the owner did something only when the screen or their own message shows it: others\' messages alone are background', async t => {
  const f = await setup(t)
  f.at('10:02');const others = await f.observe(T('10:01'), { source: 'lark', app: '飞书', title: '大群', text: '张三：今晚发版' })
  f.at('10:12');const screen = await f.observe(T('10:11'))
  const theirs = await f.observe(T('10:12'), { source: 'lark', app: '飞书', title: '大群', text: '李四：收到' })
  f.answer(() => reply([{ title: '看发版通知', detail: '', apps: ['飞书'], project: '', refs: [theirs] }, { title: '改 Mira 设备接入', detail: '', apps: ['Code'], project: '', refs: [screen, theirs] }]))
  f.at('10:30');await f.history.tick()
  assert.equal(f.calls.length, 1, 'the window with only others\' messages is not sent to the model')
  const written = f.hub.get('hub').activities
  assert.deepEqual(written.get('mac-1|' + T('10:00')).activities, [], 'and is written as nothing done')
  assert.deepEqual(written.get('mac-1|' + T('10:10')).activities.map(a => a.title), ['改 Mira 设备接入'], 'an activity citing only others\' messages is dropped')
  assert.ok(others)
  // A window written under older rules is written again once, then left alone.
  const { seq, at, projectId, rules, ...older } = written.get('mac-1|' + T('10:10'))
  f.hub.append('hub', { ...older, activities: [{ title: '看发版通知', detail: '', apps: [], projectRef: null, refs: [theirs] }] })
  await f.history.tick()
  assert.equal(f.calls.length, 2)
  assert.deepEqual([written.get('mac-1|' + T('10:10')).version, written.get('mac-1|' + T('10:10')).rules, written.get('mac-1|' + T('10:10')).activities.map(a => a.title)], [2, HISTORY_RULES, ['改 Mira 设备接入']])
  await f.history.tick()
  assert.equal(f.calls.length, 2)
})

test('after an outage the day the owner is looking at is written first, in time order, then the day before', async t => {
  const f = await setup(t)
  f.at('00:30');await f.observe(T('00:05'))
  f.at('00:30');await f.observe(T('00:15'))
  f.at('00:30');await f.observe(T('00:05') - 3600_000)
  f.at('00:40');await f.history.tick()
  assert.deepEqual(f.calls.map(c => c.input.split('\n')[0]), ['时段：2026/11/07 00:00–00:10', '时段：2026/11/07 00:10–00:20', '时段：2026/11/06 23:00–23:10'])
})

test('model output is checked only for what is explicit: shape, lengths, evidence in the window, a known project', () => {
  const window = new Set(['hub#1', 'hub#2'])
  const projects = [{ id: 'p_1', name: 'Mira' }]
  assert.throws(() => parseActivities('no json here', window, projects))
  assert.throws(() => parseActivities('{"activities":"x"}', window, projects))
  assert.deepEqual(parseActivities('{"activities":[]}', window, projects), [])
  const [one] = parseActivities(JSON.stringify({ activities: [{ title: 'x'.repeat(80), detail: 'y'.repeat(400), apps: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], project: 'p_1', refs: ['hub#2', 'hub#2', 'hub#3'] }] }), window, projects)
  assert.equal(one.title.length, 24)
  assert.equal(one.detail.length, 120)
  assert.equal(one.apps.length, 5)
  assert.equal(one.projectRef, 'p_1', 'a project may be named by id too')
  assert.deepEqual(one.refs, ['hub#2'])
  assert.equal(parseActivities(JSON.stringify({ activities: Array.from({ length: 6 }, () => ({ title: 't', refs: ['hub#1'] })) }), window, projects).length, 3)
  assert.deepEqual(parseActivities(JSON.stringify({ activities: [{ title: 't', refs: ['hub#1'] }] }), window, projects, new Set(['hub#2'])), [], 'with first-person refs given, one of them must be cited')
})

test('正在记录 is what the recorder last saw in front; other apps in front in the 10 minutes before it are listed, newest first', async t => {
  const f = await setup(t)
  f.at('10:20')
  await f.observe(T('09:50'), { app: '旧的', title: '十多分钟前' })
  // Chrome is seen first, 飞书 later and last: the list goes by when each was last in front.
  await f.observe(T('10:01'), { app: 'Google Chrome', title: '文档' })
  await f.observe(T('10:04'), { app: '飞书', title: '群聊' })
  await f.observe(T('10:06'), { app: '飞书', title: '另一个群' })
  await f.observe(T('10:08'), { app: '', title: '没有应用名' })
  await f.observe(T('10:10'), { app: 'Claude', title: 'Claude' })
  const live = f.history.live()
  assert.deepEqual([live.app, live.title, live.at], ['Claude', 'Claude', T('10:10')])
  assert.deepEqual(live.recent, ['飞书', 'Google Chrome'])
  // Nothing recorded yet: nothing to show.
  const g = await setup(t)
  assert.equal(g.history.live(), null)
})
