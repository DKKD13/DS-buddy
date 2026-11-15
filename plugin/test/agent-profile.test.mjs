import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore, MIRA, COORDINATOR, THREAD_INPUTS_MAX, workerKey } from '../lib/store.js'
import { Actions, toolPaths } from '../lib/actions.js'
import { ensureHub, HUB_ID, MORNING_HOUR, EVENING_HOUR } from '../lib/hub.js'
import { PersonalMira } from '../lib/personal.js'
import { URGENT_MS, BUSY_COUNT } from '../lib/mira.js'
import { agentProfile, wakesFor } from '../lib/agent-profile.js'

const CATALOG = { default: { provider: 'ds', model: 'flash' }, groups: [{ id: 'ds', name: 'DeepSeek', models: [{ id: 'flash', name: 'V4.1-Flash' }, { id: 'pro', name: 'V4-Pro' }] }] }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-agent-profile-'))
  const store = new ProjectStore(root, { warn() {} }), hubStore = new ProjectStore(join(root, '_hub'), { warn() {} })
  store.load(); hubStore.load(); ensureHub(hubStore)
  const text = { rolePrompt: (project, key) => `PROMPT ${project.name} ${key}`, liveContext: (_project, key) => `LIVE ${key}` }
  const driver = { text, deliver() {}, status: (_p, key) => key === COORDINATOR ? 'running' : 'idle', childrenOf: () => [], memberModel: () => null, async modelCatalog() { return CATALOG } }
  const hubDriver = { text: { rolePrompt: () => 'HUB PROMPT', liveContext: () => 'HUB LIVE' }, status: () => 'idle', memberModel: () => ({ provider: 'ds', model: 'pro' }) }
  const actions = new Actions(store, driver)
  const personal = new PersonalMira(hubStore, driver, store, actions)
  t.after(() => { personal.close(); rmSync(root, { recursive: true, force: true }) })
  const { projectId } = actions.createProject({ name: '试玩' })
  const project = store.get(projectId)
  const { threadId } = actions.openThread(project, { title: '写简介', brief: '100 字以内', assignee: '工程师' })
  const say = (text, kind = 'human') => hubStore.append(HUB_ID, { type: 'message.posted', messageId: hubStore.newMessageId(), threadId: null,
    author: kind === 'human' ? { kind: 'human', id: 'owner' } : { kind: 'assistant', id: MIRA }, trust: kind === 'human' ? 'principal' : 'assistant', text, mentions: [], to: [] }).messageId
  const hub = { store: hubStore, driver: hubDriver }
  return { root, store, hubStore, driver, hub, actions, personal, projectId, project, threadId, say }
}

test('the page says what wakes each assistant with the numbers the wake policies use', () => {
  const text = list => list.map(x => `${x.name} ${x.detail}`)
  const personal = text(wakesFor(null, { id: MIRA }))
  assert.ok(personal.some(line => line.includes(`${MORNING_HOUR} 点`) && line.includes(`${EVENING_HOUR} 点`)), personal.join('|'))
  const memory = text(wakesFor('p_1', { id: MIRA }))
  assert.ok(memory.some(line => line.includes(`${URGENT_MS / 1000} 秒`)), memory.join('|'))
  assert.ok(memory.some(line => line.includes(`${BUSY_COUNT} 条`)), memory.join('|'))
  assert.ok(text(wakesFor('p_1', { id: COORDINATOR })).some(line => line.includes('项目对话')))
  assert.ok(text(wakesFor('p_1', { id: 'engineer' })).some(line => line.includes('开任务')))
})

test('a profile shows the instructions each assistant reads, its status and model, and an executor speaks for its latest task', t => {
  const f = fixture(t)
  const mine = agentProfile({ store: f.store, driver: f.driver, hub: f.hub }, { projectId: null })
  assert.equal(mine.name, '个人助理'); assert.equal(mine.instructions, 'HUB PROMPT'); assert.equal(mine.live, 'HUB LIVE')
  assert.match(mine.persona, /个人助理/, 'the personal assistant is described as itself, not as the memory assistant')
  assert.deepEqual(mine.running, { provider: 'ds', model: 'pro' })
  const lead = agentProfile({ store: f.store, driver: f.driver, hub: f.hub }, { projectId: f.projectId, member: COORDINATOR })
  assert.equal(lead.instructions, `PROMPT 试玩 ${COORDINATOR}`); assert.equal(lead.status, 'running'); assert.equal(lead.roleLabel, '项目助理')
  const worker = agentProfile({ store: f.store, driver: f.driver, hub: f.hub }, { projectId: f.projectId, member: 'engineer' })
  assert.equal(worker.example.title, '写简介'); assert.equal(worker.instructions, `PROMPT 试玩 ${workerKey(f.threadId)}`)
  // An executor that never held a task has nothing to show yet, and unknown names are refused.
  const idle = agentProfile({ store: f.store, driver: f.driver, hub: f.hub }, { projectId: f.projectId, member: 'designer' })
  assert.equal(idle.example, null); assert.equal(idle.instructions, '')
  assert.throws(() => agentProfile({ store: f.store, driver: f.driver, hub: f.hub }, { projectId: f.projectId, member: '路人' }), /没有这个助理/)
  assert.throws(() => agentProfile({ store: f.store, driver: f.driver, hub: f.hub }, { projectId: 'p_nope', member: COORDINATOR }), /没有这个项目/)
})

test('a model strategy is the owner\'s own words, kept per project and for the personal assistant, and survives a restart', async t => {
  const f = fixture(t)
  assert.deepEqual(f.personal.setModelStrategy({ projectId: f.projectId, text: '规划用 Pro，写代码用 Flash' }), { ok: true, modelStrategy: '规划用 Pro，写代码用 Flash' })
  assert.equal(f.personal.setModelStrategy({ projectId: f.projectId, text: '规划用 Pro，写代码用 Flash' }).unchanged, true)
  // Through the assistant it must cite the owner's own words and leaves a 「已执行」 line.
  const asked = f.say('个人助理都用 Pro')
  f.personal.setModelStrategy({ text: '都用 Pro' }, { messageId: asked })
  assert.equal(f.personal.snapshot().actions.at(-1).text, '记下了个人助理的模型策略')
  assert.throws(() => f.personal.setModelStrategy({ text: '乱改' }, { messageId: f.say('我替你记了', 'assistant') }), /用户本人的原话/)
  assert.throws(() => f.personal.setModelStrategy({ projectId: f.projectId, text: '长'.repeat(501) }), /500 字/)
  assert.throws(() => f.personal.setModelStrategy({ projectId: 'p_nope', text: 'x' }), /没有这个项目/)
  const view = await f.personal.models()
  assert.equal(view.strategies[''], '都用 Pro'); assert.equal(view.strategies[f.projectId], '规划用 Pro，写代码用 Flash')
  const replay = new ProjectStore(f.root, { warn() {} }); replay.load()
  assert.equal(replay.get(f.projectId).modelStrategy, '规划用 Pro，写代码用 Flash')
  assert.equal(agentProfile({ store: f.store, driver: f.driver, hub: f.hub }, { projectId: f.projectId, member: COORDINATOR }).strategy, '规划用 Pro，写代码用 Flash')
})

test('the files a task\'s tools read become its inputs: written files are left out, repeats once, capped, after a restart too', t => {
  const f = fixture(t)
  const message = { content: [
    { type: 'text', text: '先看看' },
    { type: 'tool-call', toolName: 'read_file', args: { path: 'docs/a.md' } },
    { type: 'tool-call', name: 'grep', input: JSON.stringify({ paths: ['src', 'docs/a.md'] }) },
    { type: 'tool-call', toolName: 'write_file', args: { path: 'out/report.md' } },
    { type: 'tool-call', toolName: 'bash', args: { command: 'cat secret.txt' } },
  ] }
  assert.deepEqual(toolPaths(message), ['docs/a.md', 'src'])
  assert.deepEqual(toolPaths({ content: 'plain' }), [])
  f.actions.noteInputs({ projectId: f.projectId, threadId: f.threadId, paths: toolPaths(message) })
  const events = f.project.events?.length
  f.actions.noteInputs({ projectId: f.projectId, threadId: f.threadId, paths: ['docs/a.md'] })
  assert.equal(f.project.events?.length, events, 'nothing new, nothing written')
  f.actions.noteInputs({ projectId: f.projectId, threadId: f.threadId, paths: Array.from({ length: 100 }, (_, i) => `f${i}.md`) })
  assert.equal(f.project.threads.get(f.threadId).inputs.length, THREAD_INPUTS_MAX)
  assert.deepEqual(f.project.threads.get(f.threadId).inputs.slice(0, 2), ['docs/a.md', 'src'])
  f.actions.noteInputs({ projectId: f.projectId, threadId: 't_nope', paths: ['x'] })
  const replay = new ProjectStore(f.root, { warn() {} }); replay.load()
  assert.equal(replay.get(f.projectId).threads.get(f.threadId).inputs.length, THREAD_INPUTS_MAX)
})
