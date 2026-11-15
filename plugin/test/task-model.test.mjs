import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { ProjectStore, workerKey } from '../lib/store.js'
import { Actions } from '../lib/actions.js'
import { Driver } from '../lib/driver.js'
import { wakeText } from '../lib/protocol.js'
import { hubWakeText } from '../lib/hub.js'
import { snapshot } from '../lib/http.js'

const CATALOG = { default: { provider: 'ds', model: 'flash' }, groups: [
  { id: 'ds', name: 'DeepSeek', models: [{ id: 'flash', name: 'V4.1-Flash' }, { id: 'pro', name: 'V4-Pro' }] },
  { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }] }] }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-task-model-'))
  const store = new ProjectStore(root, { warn() {} }); store.load()
  const stub = { deliver() {}, status: () => 'idle', childrenOf: () => [], memberModel: () => null, async modelCatalog() { return CATALOG } }
  const actions = new Actions(store, stub)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { projectId } = actions.createProject({ name: '试玩' })
  const project = store.get(projectId)
  const open = title => actions.openThread(project, { title, brief: '走一遍', assignee: '工程师' }).threadId
  return { root, store, actions, project, projectId, open }
}

test('a task picks its own model from DSH\'s list; going back to default clears it, and the pick survives a restart', async t => {
  const f = fixture(t), threadId = f.open('写简介')
  const thread = () => f.project.threads.get(threadId)
  assert.equal(thread().modelSelection, null)
  const before = f.project.events.length
  assert.deepEqual((await f.actions.setTaskModel({ projectId: f.projectId, threadId, provider: 'anthropic', model: 'claude-opus-5-5' })).modelSelection, { provider: 'anthropic', model: 'claude-opus-5-5' })
  const event = f.project.events.at(-1)
  assert.equal(f.project.events.length, before + 1)
  assert.equal(event.type, 'thread.model')
  assert.equal(event.to, undefined, 'picking a model wakes nobody')
  assert.deepEqual(thread().modelSelection, { provider: 'anthropic', model: 'claude-opus-5-5' })
  // The same pick again is no new event.
  assert.equal((await f.actions.setTaskModel({ projectId: f.projectId, threadId, provider: 'anthropic', model: 'claude-opus-5-5' })).unchanged, true)
  assert.equal(f.project.events.length, before + 1)
  const replay = new ProjectStore(f.root, { warn() {} }); replay.load()
  assert.deepEqual(replay.get(f.projectId).threads.get(threadId).modelSelection, { provider: 'anthropic', model: 'claude-opus-5-5' })
  await f.actions.setTaskModel({ projectId: f.projectId, threadId, model: 'default' })
  assert.equal(thread().modelSelection, null)
})

test('a model that is not in DSH\'s list, or no model at all, is refused and changes nothing', async t => {
  const f = fixture(t), threadId = f.open('写简介')
  const before = f.project.events.length
  await assert.rejects(f.actions.setTaskModel({ projectId: f.projectId, threadId, provider: 'anthropic', model: 'claude-made-up' }), /模型不可用/)
  await assert.rejects(f.actions.setTaskModel({ projectId: f.projectId, threadId, provider: 'nope', model: 'flash' }), /模型不可用/)
  await assert.rejects(f.actions.setTaskModel({ projectId: f.projectId, threadId, provider: '', model: '' }), /要选一个模型/)
  await assert.rejects(f.actions.setTaskModel({ projectId: f.projectId, threadId: 't_missing', provider: 'ds', model: 'pro' }), /没有这个任务/)
  assert.equal(f.project.events.length, before)
  assert.equal(f.project.threads.get(threadId).modelSelection, null)
})

test('a task session runs on the task\'s own pick, ahead of its member\'s model; other tasks keep the member\'s', async t => {
  const f = fixture(t), first = f.open('写简介'), second = f.open('改标题')
  const executor = f.project.threads.get(first).assignee
  f.store.append(f.projectId, { type: 'member.model', memberId: executor, modelSelection: { provider: 'ds', model: 'pro' } })
  const selections = {}
  const driver = new Driver({ logger: { warn() {} } }, f.store, c => c, { installModelSelection: (ctx, value) => { selections[ctx.id] = value } })
  for (const [threadId, sessionId] of [[first, 's-1'], [second, 's-2']]) {
    f.store.append(f.projectId, { type: 'session.bound', key: workerKey(threadId), sessionId, assignee: executor })
    const agent = { id: sessionId, ctx: { on: () => () => {}, systemPrompt: { section() {} } }, session: { requestHeader: () => undefined } }
    driver.installModelSelection = (_ctx, value) => { selections[sessionId] = value }
    driver.registerScoped(agent)
  }
  assert.deepEqual(selections['s-1'].current, { provider: 'ds', model: 'pro' })
  await f.actions.setTaskModel({ projectId: f.projectId, threadId: first, provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.deepEqual(selections['s-1'].current, { provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.deepEqual(selections['s-2'].current, { provider: 'ds', model: 'pro' })
  await f.actions.setTaskModel({ projectId: f.projectId, threadId: first, model: 'default' })
  assert.deepEqual(selections['s-1'].current, { provider: 'ds', model: 'pro' })
})

let client
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => ({})) } } },
})

test('a wake notice reads as one line for people: why, and what it counted, never the instructions', t => {
  const f = fixture(t), threadId = f.open('整理 hub 数据与记忆机制')
  const thread = f.project.threads.get(threadId)
  const opened = f.project.events.find(e => e.type === 'thread.opened' && e.threadId === threadId)
  const spawn = client.readWake(wakeText(f.project, workerKey(threadId), [opened], 'spawn'))
  assert.equal(spawn.title, '收到新任务')
  assert.equal(spawn.detail, '「整理 hub 数据与记忆机制」')
  assert.equal(spawn.icon, 'tasks')
  for (const word of ['inbox_read', '本轮', '<mira-wake']) assert.ok(!spawn.detail.includes(word), word)
  f.actions.ownerPost({ projectId: f.projectId, threadId, text: '再加一段' })
  const posted = f.project.events.findLast(e => e.type === 'message.posted')
  const message = client.readWake(wakeText(f.project, workerKey(threadId), [posted], 'message'))
  assert.equal(message.title, '有新消息')
  assert.equal(message.detail, `「${thread.title}」 你的消息`)
  // Mira's personal assistant and the morning request.
  assert.deepEqual({ ...client.readWake('<mira-wake project="总管" reason="conversation" unread="1">\n新动态 1 条：个人对话 1。现在是 9 点。\n先hub_inbox_read，再按问题hub_search。本轮必须以一次平台工具调用收尾。\n</mira-wake>') },
    { reason: 'conversation', title: '你发来消息', detail: '个人对话 1', icon: 'reply', project: '总管', request: '', owner: 1, said: '' })
  assert.equal(client.readWake('<mira-wake project="p" reason="owner" unread="0" request="morning">\n项目里有 0 条新动态：无。\n</mira-wake>').title, '早上整理')
  // An unknown reason still reads as something; anything that is not a Mira notice is left to the generic line.
  assert.equal(client.readWake('<mira-wake reason="later">\n</mira-wake>').title, '有新动态')
  assert.equal(client.readWake('please continue'), null)
  assert.equal(client.readWake(''), null)
})

test('a task is named by the model it is known to run on: its own pick first, never DSH\'s default standing in for an unseen session', () => {
  const name = (member, thread) => client.executorOf({ members: [member] }, { assignee: 'executor', ...thread }).name
  const executor = model => ({ id: 'executor', kind: 'assistant', role: 'worker', name: '执行者', model })
  // Only DSH's default is known (the session has not been seen since a restart): say DSH, not the default's name.
  assert.equal(name(executor({ provider: 'anthropic', model: 'claude-opus-5-5', source: 'default' }), {}), 'DSH')
  // The task's own pick, or what its session was seen running, wins over the member's.
  assert.equal(name(executor({ provider: 'ds', model: 'deepseek-flash', source: 'session' }), { modelSelection: { provider: 'anthropic', model: 'claude-opus-5-5' } }), 'Claude Opus 5.5')
  assert.equal(name(executor({ provider: 'anthropic', model: 'claude-opus-5-5', source: 'default' }), { model: { provider: 'ds', model: 'deepseek-flash' } }), 'DeepSeek Flash')
  // A model the member was seen running still names it, as before.
  assert.equal(name(executor({ provider: 'ds', model: 'deepseek-flash', source: 'session' }), {}), 'DeepSeek Flash')
})

test('the task list and the task card report a session\'s model only once it has been seen, plus the task\'s own pick', async t => {
  const f = fixture(t), threadId = f.open('写简介')
  const seen = new Map()
  const driver = { status: () => 'idle', childrenOf: () => [], memberModel: () => null, modelOf: id => seen.has(id) ? { ...seen.get(id), source: 'session' } : { provider: 'anthropic', model: 'claude-opus-5-5', source: 'default' } }
  const view = () => { const s = snapshot(f.store, driver, f.projectId); return [s.projects[0].threads.find(x => x.id === threadId), s.project.threads.find(x => x.id === threadId)] }
  for (const row of view()) assert.equal(row.model, null, 'no session yet')
  f.store.append(f.projectId, { type: 'session.bound', key: workerKey(threadId), sessionId: 's-1', assignee: f.project.threads.get(threadId).assignee })
  for (const row of view()) assert.equal(row.model, null, 'a session not seen since the restart is not given the default')
  seen.set('s-1', { provider: 'ds', model: 'flash' })
  for (const row of view()) assert.equal(JSON.stringify(row.model), JSON.stringify({ provider: 'ds', model: 'flash' }))
  await f.actions.setTaskModel({ projectId: f.projectId, threadId, provider: 'anthropic', model: 'claude-opus-5-5' })
  for (const row of view()) assert.equal(JSON.stringify(row.modelSelection), JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5-5' }))
})

test('a wake shows the owner\'s own words: the last messages it counts, the page\'s prefix dropped, their typed words kept', () => {
  const human = (id, at, text, typed) => ({ id, at, text, typed, author: { kind: 'human', id: 'owner' } })
  const list = [human('m1', 1000, '早上的话'), { id: 'a1', at: 1500, text: '助理的回复', author: { kind: 'assistant', id: 'mira' } },
    human('m2', 2000, '（我正在看「写简介」（试玩））现在到哪了？', '现在到哪了？'), human('m3', 3000, '（我正在看「试玩」项目）帮我验收'), { ...human('m3n', 2500, '在会话里直接打的字'), native: true }, human('m4', 90_000, '后来的话')]
  assert.deepEqual(client.wakeMessages(list, 3000, 2).map(m => m.text), ['现在到哪了？', '帮我验收'])
  assert.deepEqual(client.wakeMessages(list, 3000, 1).map(m => m.id), ['m3'], 'never a message from after the wake')
  assert.deepEqual(client.wakeMessages(list, 3000, 3).map(m => m.text), ['早上的话', '现在到哪了？', '帮我验收'], 'only the owner\'s messages, never the assistant\'s reply')
  assert.equal(client.wakeMessages(list, 3000, 0).length, 0)
  assert.equal(client.wakeMessages(undefined, 3000, 2).length, 0)
  // What a wake counts: the assistant's "个人对话 N", a task's lines flagged as the owner's.
  assert.equal(client.readWake('<mira-wake project="总管" reason="conversation" unread="2" request="evening">\n新动态 2 条：个人对话 1，整理请求 1。现在是 18 点。\n</mira-wake>').owner, 1)
  assert.equal(client.readWake('<mira-wake project="总管" reason="conversation" unread="2" request="evening">\n</mira-wake>').request, 'evening')
  assert.equal(client.readWake('<mira-wake project="试玩" reason="message" unread="3">\n- 线程「写简介」：2 条（用户）\n- 群聊：1 条（转达）\n</mira-wake>').owner, 2)
})

test('a wake names the owner\'s own messages by id, so the page shows exactly those words and never a guess', t => {
  const f = fixture(t), threadId = f.open('写简介')
  const texts = list => [...list].map(m => m.text)
  f.actions.ownerPost({ projectId: f.projectId, threadId, text: '标题再短一点' })
  const posted = f.project.events.findLast(e => e.type === 'message.posted')
  const wake = client.readWake(wakeText(f.project, workerKey(threadId), [posted], 'message'))
  assert.equal(wake.said, posted.messageId)
  const timeline = [{ kind: 'message', id: 'old', at: 1, text: '更早的话', author: { kind: 'human' } }, { kind: 'message', id: posted.messageId, at: posted.at, text: '标题再短一点', author: { kind: 'human' } }]
  assert.deepEqual(texts(client.wakeMessages(timeline, Date.now(), 1, wake.said)), ['标题再短一点'])
  // The assistant's notice names them too; an assistant message or a system request is never named.
  const hubWake = hubWakeText({ projects: new Map() }, 'mira', [{ type: 'message.posted', messageId: 'm_ball', author: { kind: 'human' } }, { type: 'message.posted', messageId: 'm_bot', author: { kind: 'assistant' } }, { type: 'mira.requested', reason: 'evening' }], 'conversation')
  assert.equal(client.readWake(hubWake).said, 'm_ball')
  // Named ids win over time; without ids only the ten minutes before the wake count, so an old message is never picked.
  const human = (id, at, text) => ({ id, at, text, author: { kind: 'human' } })
  const list = [human('a', 0, '很早以前'), human('b', 30 * 60e3, '刚才'), human('c', 31 * 60e3, '刚刚')]
  assert.deepEqual(texts(client.wakeMessages(list, 31 * 60e3, 1, 'b')), ['刚才'])
  assert.deepEqual(texts(client.wakeMessages(list, 50 * 60e3, 2)), [], 'nothing within ten minutes: show nothing rather than guess')
  assert.deepEqual(texts(client.wakeMessages(list, 31 * 60e3, 3)), ['刚才', '刚刚'])
  assert.deepEqual(texts(client.wakeMessages(list, 31 * 60e3, 1, 'zzz')), [], 'an id that is gone shows nothing')
})

test('a wake brought by words typed straight into the session is recognised, so it is not shown twice', () => {
  const m = (id, at, native) => ({ id, at, text: 'x', native, author: { kind: 'human' } })
  const list = [m('n1', 60e3, true), m('b1', 120e3, false)]
  assert.equal(client.typedInSession(list, 70e3, 'n1'), true)
  assert.equal(client.typedInSession(list, 130e3, 'n1,b1'), false, 'one message from the ball means there is something to show')
  assert.equal(client.typedInSession(list, 130e3, 'gone'), false, 'an id that is gone is not assumed to be on screen')
  assert.equal(client.typedInSession(list, 70e3), true, 'without ids: a typed message within ten minutes before')
  assert.equal(client.typedInSession(list, 60e3 + 11 * 60e3), false)
})
