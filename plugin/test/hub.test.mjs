// The hub: Mira above every project. The day view, the steward's wake policy,
// her recap / memory / cards with cross-project evidence, the owner's
// "交给项目", computer context, and the routes' data. No DSH needed.

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, COORDINATOR, MIRA, workerKey } from '../lib/store.js'
import { Driver } from '../lib/driver.js'
import { Actions } from '../lib/actions.js'
import { MiraService } from '../lib/mira.js'
import { createTools, visibleTo } from '../lib/tools.js'
import { HUB_ID, HubActions, HubService, ensureHub, hubRolePrompt, hubWakeText, hubContinuity, todayView } from '../lib/hub.js'
import { createHubTools, visibleToHub } from '../lib/hub-tools.js'
import { buildDay, dayBounds, renderDay } from '../lib/today.js'
import { snapshot } from '../lib/http.js'
import { todayHtml } from '../lib/today-page.js'

class FakeAgent {
  constructor(id, brain) {
    this.id = id
    this.session = { id }
    this.status = 'idle'
    this.received = []
    this.idle = Promise.resolve()
    this.brain = brain
    this.ctx = { systemPrompt: { section: (spec) => { this.prompt = spec.text } } }
  }
  followup(message) {
    this.received.push(message.content[0].text)
    this.idle = this.idle.then(() => this.brain(this, message.content[0].text))
  }
  whenIdle() { return this.idle }
}

function fakeClock(start = Date.now()) {
  const timers = new Map()
  let id = 0
  let now = start
  return {
    clock: {
      now: () => now,
      setTimer: (fn, ms) => { id++; timers.set(id, { fn, due: now + ms }); return id },
      clearTimer: (t) => { timers.delete(t) },
    },
    advance(ms) {
      now += ms
      for (const [key, t] of [...timers]) if (t.due <= now) { timers.delete(key); t.fn() }
    },
    pending: () => [...timers.values()].map(t => t.due - now),
  }
}

function setup(brain = async () => {}, { now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mira-hub-'))
  const agents = new Map()
  const warnings = []
  const ctx = {
    logger: { warn: (...args) => { warnings.push(args.map(String).join(' ')) } },
    agents: { withoutInitiator: fn => fn(), get: id => agents.get(id) },
    sessions: { flush: async () => true },
    get: () => undefined,
  }
  const store = new ProjectStore(dir, ctx.logger)
  store.load()
  const driver = new Driver(ctx, store, content => ({ content }))
  const actions = new Actions(store, driver)
  const tools = createTools({ defineTool: d => d, store, driver, actions })
  const hubStore = new ProjectStore(join(dir, '_hub'), ctx.logger)
  hubStore.load()
  ensureHub(hubStore)
  const hubDriver = new Driver(ctx, hubStore, content => ({ content }), {
    rolePrompt: p => hubRolePrompt(p), wakeText: hubWakeText, continuityNotice: () => hubContinuity(), nudge: 'NUDGE',
  })
  const hubActions = new HubActions(hubStore, hubDriver, store, actions)
  const hubTools = createHubTools({ defineTool: d => d, hubStore, hubDriver, hubActions, projects: store, projectDriver: driver })
  const fake = fakeClock(now)
  const service = new HubService(hubStore, hubActions, store, fake.clock)
  service.start()
  const env = { dir, store, driver, actions, tools, hubStore, hubDriver, hubActions, hubTools, service, fake, agents, warnings }
  const controller = {
    async create({ sessionId }) { agents.set(sessionId, new FakeAgent(sessionId, (agent, text) => brain(env, agent, text))); return { sessionId } },
    async resolveAgent(sessionId) { const agent = agents.get(sessionId); return agent ? { agent } : { error: new Error('not found') } },
  }
  driver.setController(controller)
  hubDriver.setController(controller)
  env.hubCall = async (agent, name, args = {}) => {
    const tool = hubTools.find(t => t.definition.name === name)
    assert.ok(tool, `no hub tool ${name}`)
    assert.ok(visibleToHub(hubStore)({ agent }), `${name} is not visible to ${agent.id}`)
    return tool.definition.execute(args, { agent })
  }
  env.hub = () => hubStore.get(HUB_ID)
  return env
}

const settle = async (drivers, ms = 1500) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 30))
    const busy = drivers.some(d => [...d.slots.values()].some(s => s.running || s.timer !== null))
    if (!busy) return
  }
  throw new Error('drivers did not settle')
}

/** A small working day in one project: a thread opened, a decision asked and answered, a delivery. */
function aDay(env, name = '回顾项目', cwd) {
  const { projectId } = env.actions.createProject({ name, cwd })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '把今日回顾做出来' })
  const { threadId } = env.actions.openThread(project, { title: '今日回顾接口', brief: '写接口', assignee: '工程师' })
  const key = workerKey(threadId)
  env.actions.updateCard(project, key, { state: 'working', summary: '在写', checklist: [{ text: '读日志', done: true }, { text: '写接口', done: false }] })
  const { decisionId } = env.actions.requestDecision(project, key, { question: '按自然日还是按 24 小时？', options: [{ label: '自然日' }, { label: '24 小时' }], recommended: 0 })
  return { projectId, project, threadId, key, decisionId }
}

test('the day view: timeline, waiting items, per-project progress, and refs Mira can cite', async () => {
  const env = setup()
  const { projectId, project, threadId, key, decisionId } = aDay(env)
  let view = buildDay(env.store, env.hub())
  assert.equal(view.isToday, true)
  assert.equal(view.waiting.decisions.length, 1)
  assert.equal(view.waiting.decisions[0].question, '按自然日还是按 24 小时？')
  assert.match(view.waiting.decisions[0].ref, new RegExp(`^${projectId}#\\d+$`))
  const row = view.projects.find(p => p.id === projectId)
  assert.equal(row.opened.length, 1)
  assert.equal(row.blocked.length, 1)
  assert.deepEqual(row.checklist, { done: 1, total: 2 })
  const texts = view.timeline.map(e => e.text)
  assert.ok(texts.some(t => /你在项目对话里说：把今日回顾做出来/.test(t)), texts.join('|'))
  assert.ok(texts.some(t => /开了线程「今日回顾接口」，交给工程师/.test(t)), texts.join('|'))
  assert.ok(texts.some(t => /请你拍板/.test(t)), texts.join('|'))

  env.actions.answerDecision({ projectId, decisionId, chosen: 0 })
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '接口写好了' })
  env.actions.ownerUpdateThread({ projectId, threadId, state: 'done', resolved: true })
  view = buildDay(env.store, env.hub())
  assert.equal(view.waiting.decisions.length, 0)
  assert.equal(view.totals.done, 1)
  assert.equal(view.totals.answered, 1)
  assert.equal(view.projects.find(p => p.id === projectId).done[0].title, '今日回顾接口')
  const text = renderDay(view)
  assert.match(text, /你拍板「按自然日还是按 24 小时？」：自然日/)
  assert.match(text, new RegExp(`\\[${projectId}#\\d+\\]`))

  // Another day sees none of it.
  const { day } = dayBounds(undefined, Date.now() - 2 * 86_400_000)
  const before = buildDay(env.store, env.hub(), { day })
  assert.equal(before.timeline.length, 0)
  assert.equal(before.isToday, false)
  await settle([env.driver, env.hubDriver])
})

test('urgent project events reach the steward a couple of minutes later, at most every 20 minutes', async () => {
  const seen = []
  const env = setup(async (env, agent, text) => {
    if (env.hubStore.bySession(agent.id) === undefined) return
    seen.push(text)
    await env.hubCall(agent, 'hub_inbox_read')
    await env.hubCall(agent, 'hub_no_reply')
  })
  const { projectId, project, key } = aDay(env)
  // The decision was mirrored into the hub, pointing back at its project event.
  const mirrored = env.hub().events.filter(e => e.type === 'project.attention')
  assert.equal(mirrored.length, 1)
  assert.equal(mirrored[0].kind, 'decision')
  assert.equal(mirrored[0].projectRef, projectId)
  assert.deepEqual(env.fake.pending().filter(ms => ms <= 2 * 60_000), [2 * 60_000])
  env.fake.advance(2 * 60_000)
  await settle([env.driver, env.hubDriver])
  assert.equal(seen.length, 1)
  assert.match(seen[0], /reason="attention"/)
  const agent = env.agents.get(env.hub().sessions.get(MIRA).sessionId)
  assert.match(agent.prompt, /# 个人助理/)
  assert.match(agent.prompt, new RegExp(`nonce="${env.hub().nonce}"`))

  // A delivery right after waits out the 20-minute gap instead of waking her again at once.
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '接口写好了' })
  const next = Math.min(...env.fake.pending())
  assert.ok(next > 2 * 60_000 && next <= 20 * 60_000, `next wake in ${next}ms`)
  // Quiet events (a worker's progress) are not mirrored at all.
  const before = env.hub().events.length
  env.actions.updateCard(project, key, { summary: '还在改' })
  assert.equal(env.hub().events.length, before)
  await settle([env.driver, env.hubDriver])
})

test('recap, memory and cards need cross-project refs; the board and the dock show them', async () => {
  const env = setup()
  const { projectId, project, threadId, decisionId } = aDay(env)
  const dRef = `${projectId}#${project.decisions.get(decisionId).seq}`
  const a = env.hubActions
  assert.throws(() => a.writeRecap({ kind: 'morning', headline: '今天先拍板', waiting: [{ text: '回顾接口等你拍板', refs: [] }] }), /refs 不能为空/)
  assert.throws(() => a.writeRecap({ kind: 'morning', headline: '今天先拍板', waiting: [{ text: '回顾接口等你拍板', refs: ['p_nope#1'] }] }), /不存在的项目/)
  assert.throws(() => a.writeRecap({ kind: 'morning', headline: '今天先拍板', waiting: [{ text: '回顾接口等你拍板', refs: [`${projectId}#999`] }] }), /不存在的动态/)
  assert.throws(() => a.writeRecap({ kind: 'weekly', headline: 'x' }), /kind 只能是/)
  a.writeRecap({ kind: 'morning', headline: '今天先拍板回顾接口', focus: [{ text: '回顾接口卡在拍板上', refs: [dRef] }], waiting: [{ text: '按自然日还是 24 小时', refs: [dRef] }], tomorrow: [{ text: '接上电脑端摘要' }] })
  a.writeMemory({ links: [{ text: '回顾接口和看板共用一份日志', refs: [dRef] }] })
  assert.equal(env.hub().hubMemory.links.length, 1)
  assert.deepEqual(env.hub().hubMemory.focus, [])

  assert.throws(() => a.proposeCard({ kind: 'next_step', title: '去拍板', refs: [dRef], project_id: projectId, thread_id: 't_nope' }), /没有这个线程/)
  assert.throws(() => a.proposeCard({ kind: 'next_step', title: '去拍板', refs: [dRef], actions: [{ id: 'handoff' }], project_id: projectId }), /handoff 需要 text/)
  const { cardId } = a.proposeCard({
    kind: 'next_step', title: '先拍板回顾接口', body: '工程师在等你选自然日还是 24 小时。', project_id: projectId, thread_id: threadId, refs: [dRef],
    actions: [{ id: 'handoff', text: '按自然日做，跨时区先不管' }],
  })
  const card = env.hub().cards.get(cardId)
  assert.deepEqual(card.actions.map(x => x.id), ['open_thread', 'handoff'])
  assert.equal(card.target.threadTitle, '今日回顾接口')
  // Same thread, same kind: the new card replaces the old one.
  const twin = a.proposeCard({ kind: 'next_step', title: '拍板回顾接口', project_id: projectId, thread_id: threadId, refs: [dRef] })
  assert.equal(twin.superseded, cardId)
  for (let i = 0; i < 3; i++) a.proposeCard({ kind: 'link', title: `关联 ${i}`, refs: [dRef] })
  assert.throws(() => a.proposeCard({ kind: 'link', title: '第六张', refs: [dRef] }), /今天已经递了 5 张/)

  const view = todayView(env.store, env.hubStore)
  assert.equal(view.recap.morning.headline, '今天先拍板回顾接口')
  assert.equal(view.recap.latest.sections.tomorrow[0].refs.length, 0)
  assert.equal(view.cards.filter(c => c.state === 'open').length, 4)
  const snap = snapshot(env.store, env.driver, undefined, env.hubStore)
  const hubCard = snap.dock.cards.find(c => c.id === twin.cardId)
  assert.equal(hubCard.projectId, HUB_ID)
  assert.equal(hubCard.jumpProjectId, projectId)
  assert.equal(snap.dock.headline.headline, '今天先拍板回顾接口')
  assert.equal(snap.dock.waiting.length, 1)
  await settle([env.driver, env.hubDriver])
})

test('交给项目 posts under the owner name in the project chat and wakes the coordinator', async () => {
  const woken = []
  const env = setup(async (env, agent) => {
    const binding = env.store.bySession(agent.id)
    if (binding === undefined) return
    woken.push(binding.key)
    const tool = env.tools.find(t => t.definition.name === 'inbox_read')
    await tool.definition.execute({}, { agent })
    await env.tools.find(t => t.definition.name === 'no_reply').definition.execute({}, { agent })
  })
  const { projectId, project, decisionId } = aDay(env)
  await settle([env.driver, env.hubDriver])
  woken.length = 0
  const dRef = `${projectId}#${project.decisions.get(decisionId).seq}`
  const { cardId } = env.hubActions.proposeCard({ kind: 'link', title: '复用日志', project_id: projectId, refs: [dRef], actions: [{ id: 'handoff', text: '看板直接读事件日志，不要另存' }] })
  const result = env.hubActions.cardAction({ cardId, actionId: 'handoff' })
  const message = project.messages.get(result.messageId)
  assert.equal(message.author.kind, 'human')
  assert.equal(message.trust, 'principal')
  assert.match(message.text, /看板直接读事件日志，不要另存\n（经个人助理转交）/)
  assert.equal(env.hub().cards.get(cardId).state, 'acted')
  assert.ok(env.hubStore.unread(env.hub(), MIRA).some(e => e.type === 'card.acted'))
  await settle([env.driver, env.hubDriver])
  assert.ok(woken.includes(COORDINATOR))
  // Dismiss is recorded for Mira to learn from; acting twice is refused.
  const other = env.hubActions.proposeCard({ kind: 'recap', title: '小结', refs: [dRef] })
  env.hubActions.cardAction({ cardId: other.cardId, actionId: 'dismiss' })
  assert.throws(() => env.hubActions.cardAction({ cardId: other.cardId, actionId: 'dismiss' }), /已经处理过了/)
})

test('computer context: windows bind to a project by folder and show up as hours on the board', async () => {
  const env = setup()
  const folder = join(env.dir, 'repo')
  mkdirSync(join(folder, 'src'), { recursive: true })
  const { projectId } = aDay(env, '有目录的项目', folder)
  assert.throws(() => env.hubActions.ingest([]), /非空数组/)
  env.hubActions.ingest([
    { type: 'pc.window', app: 'Cursor', path: join(folder, 'src', 'today.js'), summary: '在改今日回顾的接口', minutes: 10 },
    { type: 'pc.window', app: 'Cursor', path: join(folder, 'README.md'), summary: '写说明', minutes: 10 },
    { type: 'pc.window', app: 'Safari', path: '/elsewhere', summary: '看 AirJelly 的回顾页' },
    { type: 'pc.signal', kind: 'meeting', text: '15:00 设计评审' },
  ])
  const view = buildDay(env.store, env.hub())
  assert.equal(view.projects.find(p => p.id === projectId).pcMinutes, 20)
  assert.equal(view.pcMinutes, 30)
  const pc = view.timeline.filter(e => e.kind === 'pc').map(e => e.text)
  assert.ok(pc.some(t => /电脑上 30 分钟：Cursor、Safari/.test(t) && /有目录的项目/.test(t)), pc.join('|'))
  assert.ok(pc.some(t => /15:00 设计评审/.test(t)), pc.join('|'))
  // Computer context never wakes the steward by itself.
  assert.equal(env.hubStore.unread(env.hub(), MIRA).filter(e => e.type.startsWith('pc.')).length, 0)
  await settle([env.driver, env.hubDriver])
})

test('desktop retry IDs deduplicate across devices and store replay; invalid batches leave no partial context', () => {
  const env = setup()
  const event = { type: 'pc.window', deviceId: 'mac-1', eventId: 'window-1', summary: '整理接口', minutes: 10 }
  assert.equal(env.hubActions.ingest([event]).count, 1)
  assert.deepEqual(env.hubActions.ingest([event]), { ok: true, count: 0, duplicates: 1 })
  assert.equal(env.hubActions.ingest([{ ...event, deviceId: 'mac-2' }]).count, 1)
  const replay = new ProjectStore(env.hubStore.root, { warn() {} });replay.load()
  const actions = new HubActions(replay, env.hubDriver, env.store, env.actions)
  assert.equal(actions.ingest([event]).duplicates, 1)
  const before = replay.get(HUB_ID).pc.length
  assert.throws(() => actions.ingest([{ ...event, eventId: 'next' }, { type: 'image', screenshot: 'no-upload' }]), /type|字段/)
  assert.equal(replay.get(HUB_ID).pc.length, before)
  assert.throws(() => actions.ingest([{ ...event, deviceId: undefined }]), /deviceId/)
  assert.throws(() => actions.ingest([{ ...event, minutes: Infinity }]), /minutes/)
})

test('offline desktop summaries count on their original activity day, not their upload day', () => {
  const env = setup(), { projectId } = aDay(env)
  const previous = new Date();previous.setDate(previous.getDate() - 1);previous.setHours(12, 0, 0, 0)
  env.hubActions.ingest([{ type: 'pc.window', deviceId: 'mac-1', eventId: 'offline-window', summary: '昨天的工作', startedAt: previous.getTime(), projectId, minutes: 10 }])
  assert.equal(buildDay(env.store, env.hub()).pcMinutes, 0)
  const yesterday = buildDay(env.store, env.hub(), { day: dayBounds(undefined, previous.getTime()).day })
  assert.equal(yesterday.pcMinutes, 10)
  assert.equal(yesterday.projects.find(p => p.id === projectId).pcMinutes, 10)
})

test('two device summaries sharing an event ID stay distinct and expose per-device totals', () => {
  const env = setup(), event = { type: 'pc.window', eventId: 'same-window', summary: '整理项目', minutes: 10 }
  env.hubActions.ingest([{ ...event, deviceId: 'mac-a', deviceName: '工作 Mac' }, { ...event, deviceId: 'mac-b', deviceName: '另一台 Mac' }])
  env.hubActions.ingest([{ ...event, deviceId: 'mac-a', deviceName: '工作 Mac' }])
  const view = buildDay(env.store, env.hub())
  assert.equal(view.pcMinutes, 20);assert.equal(view.devices.length, 2)
  assert.match(renderDay(view), /工作 Mac/)
  assert.deepEqual(view.devices.map(d => [d.name, d.minutes]).sort(), [['另一台 Mac', 10], ['工作 Mac', 10]].sort())
})

test('one morning and one evening recap a day across projects; the per-project morning card is off', async () => {
  // 19:00 of the day the clock lands on, or a little after the real now when the suite runs later than that (events are
  // stamped with the real clock). Taken from now + 2 min, not from now: at 23:59 the two are on different days and the
  // morning check saw hour 0 (flaked once, 31 Oct 23:59 UTC).
  const today = new Date(Date.now() + 120_000); today.setHours(19, 0, 0, 0)
  const env = setup(async () => {}, { now: Math.max(today.getTime(), Date.now() + 120_000) })
  aDay(env)
  aDay(env, '第二个项目')
  assert.equal(env.service.maybeMorning(), true)
  assert.equal(env.service.maybeMorning(), false)
  assert.equal(env.service.maybeEvening(), true)
  assert.equal(env.service.maybeEvening(), false)
  const requests = env.hub().events.filter(e => e.type === 'mira.requested').map(e => e.reason)
  assert.deepEqual(requests, ['morning', 'evening'])
  // The project-level Mira does not send her own morning card when the hub runs.
  const mira = new MiraService(env.store, env.driver, env.actions, env.fake.clock, { morning: false })
  for (const p of env.store.projects.values()) assert.equal(mira.maybeMorning(p), false)
  // Early in the morning nothing fires.
  const early = new Date(); early.setHours(4, 0, 0, 0)
  const env2 = setup(async () => {}, { now: early.getTime() })
  aDay(env2)
  assert.equal(env2.service.maybeMorning(), false)
  await settle([env.driver, env.hubDriver, env2.driver, env2.hubDriver])
})

test('a daily check that cannot write (a full disk) stays inside the timer, and the next tick tries again', async () => {
  const today = new Date(Date.now() + 120_000); today.setHours(19, 0, 0, 0)
  const env = setup(async () => {}, { now: Math.max(today.getTime(), Date.now() + 120_000) })
  aDay(env)
  aDay(env, '第二个项目')
  const file = join(env.dir, '_hub', HUB_ID, 'events.jsonl'), tick = 10 * 60_000
  const requests = () => env.hub().events.filter(e => e.type === 'mira.requested').map(e => e.reason)
  // What a full disk does to the assistant's log: every write throws.
  chmodSync(file, 0o444)
  assert.throws(() => env.service.maybeMorning(), 'the write itself still fails loudly')
  // The timer is what must survive: an error that leaves it is uncaught, and that ends the server.
  assert.doesNotThrow(() => env.fake.advance(tick))
  assert.deepEqual(requests(), [], 'nothing was recorded')
  assert.equal(env.warnings.filter(text => text.includes('daily check failed')).length, 2, 'morning and evening each failed and said so')
  assert.equal(env.fake.pending().length, 1, 'and the timer is set again')
  // Space is back: the next tick does both, once.
  chmodSync(file, 0o644)
  env.fake.advance(tick)
  assert.deepEqual(requests(), ['morning', 'evening'])
  await settle([env.driver, env.hubDriver])
})

test('hub tools are for the steward alone; project tools never reach her; the steward writes a recap end to end', async () => {
  const env = setup(async (env, agent) => {
    if (env.hubStore.bySession(agent.id) === undefined) {
      const tool = env.tools.find(t => t.definition.name === 'no_reply')
      return tool.definition.execute({}, { agent })
    }
    const inbox = await env.hubCall(agent, 'hub_inbox_read')
    assert.match(inbox, /kind="mira_requested" reason="owner"/)
    const day = await env.hubCall(agent, 'today_read')
    const ref = /\[(p_[0-9a-f]+#\d+)\]/.exec(day)[1]
    const projectId = ref.split('#')[0]
    assert.match(await env.hubCall(agent, 'project_read', { project_id: projectId }), /今日回顾接口/)
    await env.hubCall(agent, 'hub_memory_write', { focus: [{ text: '回顾接口在等拍板', refs: [ref] }] })
    await env.hubCall(agent, 'recap_write', { kind: 'update', headline: '一个项目在等你拍板', waiting: [{ text: '回顾接口：自然日还是 24 小时', refs: [ref] }] })
    assert.match(await env.hubCall(agent, 'hub_read'), /一个项目在等你拍板/)
  })
  aDay(env)
  await settle([env.driver, env.hubDriver])
  env.hubActions.request('owner', '看看今天')
  await settle([env.driver, env.hubDriver])
  const hub = env.hub()
  assert.equal(hub.recaps.at(-1).headline, '一个项目在等你拍板')
  const steward = env.agents.get(hub.sessions.get(MIRA).sessionId)
  // Nothing visible to her from the project tool set, and nothing from hers for a project session.
  for (const t of env.tools) assert.equal(visibleTo(env.store, t.role)({ agent: steward }), false, t.definition.name)
  const coordinator = env.agents.get([...env.store.projects.values()][0].sessions.get(COORDINATOR).sessionId)
  assert.equal(visibleToHub(env.hubStore)({ agent: coordinator }), false)
  // The turn ended with a platform call, and was acknowledged.
  assert.equal(hub.turns.get(MIRA).silent, false)
  assert.equal(env.hubStore.unread(hub, MIRA).length, 0)
  // Restart: the hub log replays to the same place.
  const again = new ProjectStore(join(env.dir, '_hub'), { warn() {} })
  again.load()
  assert.equal(again.get(HUB_ID).recaps.at(-1).headline, '一个项目在等你拍板')
  assert.equal(again.get(HUB_ID).hubMemory.focus.length, 1)
  assert.match(todayHtml(), /\/api\/mira-projects\/today/)
  assert.deepEqual(env.warnings, [])
})

test('hub_no_reply ends the turn as the project no_reply does, so no closing line follows it in the assistant chat', async () => {
  let concluded = 0, result
  const env = setup(async (env, agent) => {
    if (env.hubStore.bySession(agent.id) === undefined) return
    await env.hubCall(agent, 'hub_inbox_read')
    const tool = env.hubTools.find(t => t.definition.name === 'hub_no_reply')
    result = await tool.definition.execute({}, { agent, concludeTurn() { concluded++ } })
  })
  aDay(env)
  env.fake.advance(2 * 60_000)
  await settle([env.driver, env.hubDriver])
  assert.equal(concluded, 1)
  assert.equal(result, '好，本轮不回复。')
  assert.match(env.hubTools.find(t => t.definition.name === 'hub_no_reply').definition.description, /调用后本轮就结束/)
})
