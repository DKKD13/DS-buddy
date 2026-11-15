import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, workerKey } from '../lib/store.js'
import { Actions } from '../lib/actions.js'
import { Driver } from '../lib/driver.js'
import { rolePrompt } from '../lib/protocol.js'

const selection = { provider: 'kth', model: 'kimi-k2.8-highspeed' }
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mira-members-'));t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new ProjectStore(directory, { warn() {} });store.load()
  const driver = { deliver() {}, status() { return 'idle' }, async modelCatalog() { return { groups: [{ id: 'kth', models: [{ id: selection.model }] }] } } }
  const actions = new Actions(store, driver), project = store.get(actions.createProject({ name: '配置项目' }).projectId)
  const members = () => project.members.filter(m => m.kind === 'assistant' && m.active !== false).map(m => ({ id: m.id, name: m.name, role: m.role, persona: m.persona, modelSelection: m.modelSelection ?? null }))
  const configure = patch => actions.configureProject({ projectId: project.id, expectedRevision: project.configRevision ?? 0, name: project.name, instructions: project.instructions, members: members(), ...patch })
  return { directory, store, driver, actions, project, members, configure }
}

test('project description and new member persist with explicit model selection and a stale settings form cannot overwrite them', async t => {
  const e = setup(t), members = e.members();members.push({ name: '测试员', persona: '做回归验证', modelSelection: selection })
  await e.configure({ instructions: '只做测试，不改生产', members })
  const added = e.store.memberByName(e.project, '测试员')
  assert.deepEqual(added.modelSelection, selection);assert.ok(added.id.startsWith('a_'))
  // Executors are per task: the project assistant's roster no longer lists them (2026-11-13), the member still exists.
  assert.doesNotMatch(rolePrompt(e.project, 'coordinator'), /测试员/)
  await assert.rejects(e.configure({ expectedRevision: 0, instructions: '覆盖旧配置' }), /已变化|刷新/)
  const replay = new ProjectStore(e.directory, { warn() {} });replay.load()
  assert.equal(replay.get(e.project.id).instructions, '只做测试，不改生产')
  assert.deepEqual(replay.get(e.project.id).members.find(m => m.name === '测试员').modelSelection, selection)
})

test('unavailable model, credentials in model fields, duplicate names and missing core roles are refused atomically', async t => {
  const e = setup(t), before = e.project.seq
  const invalid = [
    e.members().map(m => m.id === 'engineer' ? { ...m, modelSelection: { provider: 'other', model: 'unavailable' } } : m),
    e.members().map(m => m.id === 'engineer' ? { ...m, modelSelection: { ...selection, token: 'never-save' } } : m),
    e.members().map(m => m.id === 'engineer' ? { ...m, name: 'Mira' } : m),
    e.members().filter(m => m.id !== 'coordinator'),
  ]
  for (const members of invalid) await assert.rejects(e.configure({ members }))
  assert.equal(e.project.seq, before)
})

test('a worker with unfinished or queued work cannot be removed; retirement retains historical names', async t => {
  const e = setup(t), thread = e.project.threads.get(e.actions.openThread(e.project, { title: '现有任务', brief: '测试', assignee: '工程师' }).threadId)
  const members = e.members().filter(m => m.id !== 'engineer')
  await assert.rejects(e.configure({ members }), /未完成|进行中|未读/)
  e.actions.ownerUpdateThread({ projectId: e.project.id, threadId: thread.id, state: 'done' })
  e.store.append(e.project.id, { type: 'inbox.acked', key: workerKey(thread.id), cursor: e.project.seq })
  e.driver.status = () => 'queued'
  await assert.rejects(e.configure({ members }), /运行|排队|未完成|进行中/)
  e.driver.status = () => 'idle'
  e.store.append(e.project.id, { type: 'session.bound', key: workerKey(thread.id), sessionId: 'retired-session', assignee: 'engineer' })
  await e.configure({ members })
  assert.equal(e.project.members.find(m => m.id === 'engineer').name, '工程师')
  assert.equal(e.store.memberByName(e.project, '工程师'), undefined)
  assert.equal(e.store.mentions(e.project, '@工程师 请看一下').includes('engineer'), false)
  assert.equal(e.store.bySession('retired-session'), undefined, 'retired native sessions lose project tool authorization')
  const posted = e.actions.ownerPost({ projectId: e.project.id, threadId: thread.id, text: '请继续扩展' })
  assert.deepEqual(e.project.events.find(x => x.messageId === posted.messageId).to, ['coordinator'])
})

test('configuration applies at the next wake in a new session while retaining the same thread and its files', async t => {
  const e = setup(t), agents = new Map(), prompts = [], installed = []
  const ctx = { logger: { warn() {} }, agents: { get: id => agents.get(id) }, get: () => undefined }
  const driver = new Driver(ctx, e.store, c => c, { installModelSelection: (_ctx, value) => installed.push(value.current) })
  driver.controller = {
    async create(request) { const agent = { id: request.sessionId, session: { id: request.sessionId }, ctx: { on() { return () => {} }, systemPrompt: { section: p => prompts.push(p.text) } } };agents.set(agent.id, agent);return { sessionId: agent.id } },
    async resolveAgent(id) { return { agent: agents.get(id) } },
  }
  const thread = e.project.threads.get(e.actions.openThread(e.project, { title: '测试配置', brief: '继续', assignee: '工程师' }).threadId)
  const first = await driver.ensureAgent(e.project, workerKey(thread.id));driver.registerScoped(first.agent)
  const members = e.members().map(m => m.id === 'engineer' ? { ...m, persona: '只负责校验', modelSelection: selection } : m)
  await e.configure({ instructions: '新说明', members })
  assert.equal(prompts.length, 1, 'current turn retains its frozen prompt')
  const next = await driver.ensureAgent(e.project, workerKey(thread.id));driver.registerScoped(next.agent)
  assert.notEqual(next.agent.id, first.agent.id);assert.equal(next.continuity, true)
  assert.equal(e.project.threads.size, 1)
  assert.match(prompts[1], /新说明/);assert.match(prompts[1], /只负责校验/)
  assert.deepEqual(installed.at(-1), selection)
  assert.equal(e.store.bySession(first.agent.id), undefined)
  assert.equal((await driver.ensureAgent(e.project, workerKey(thread.id))).agent.id, next.agent.id)
})

test('retired-member threads cannot be reactivated or relayed into and leave no orphan unread work', async t => {
  const e = setup(t), thread = e.project.threads.get(e.actions.openThread(e.project, { title: '旧任务', brief: '完成', assignee: '工程师' }).threadId)
  e.actions.ownerUpdateThread({ projectId: e.project.id, threadId: thread.id, state: 'done' })
  e.store.append(e.project.id, { type: 'inbox.acked', key: workerKey(thread.id), cursor: e.project.seq })
  await e.configure({ members: e.members().filter(m => m.id !== 'engineer') })
  assert.throws(() => e.actions.relay(e.project, 'coordinator', { toKey: workerKey(thread.id), text: '继续工作' }), /移出|已完成|已经完成/)
  assert.throws(() => e.actions.ownerUpdateThread({ projectId: e.project.id, threadId: thread.id, state: 'working' }), /移出/)
  assert.equal(e.store.unread(e.project, workerKey(thread.id)).length, 0)
})

test('concurrent settings saves from the same revision accept exactly one complete configuration', async t => {
  const e = setup(t), members = e.members().map(m => m.id === 'engineer' ? { ...m, modelSelection: selection } : m)
  let release
  const barrier = new Promise(resolve => { release = resolve })
  e.driver.modelCatalog = async () => { await barrier;return { groups: [{ id: 'kth', models: [{ id: selection.model }] }] } }
  const changes = [e.configure({ instructions: 'A', members }), e.configure({ instructions: 'B', members })]
  release()
  const results = await Promise.allSettled(changes)
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(e.project.events.filter(event => event.type === 'project.configured').length, 1)
})

test('renaming a project keeps the original default directory and its delivery files', async t => {
  const e = setup(t), paths = []
  const ctx = { get: key => key === 'workspaceRegistry' ? { create: async path => { paths.push(path);return { id: 'workspace' } } } : undefined, logger: { warn() {} } }
  const driver = new Driver(ctx, e.store, c => c)
  await driver.workspaceFor(e.project)
  writeFileSync(join(paths[0], 'delivery.txt'), 'keep this result')
  await e.configure({ name: '改过名字的项目' })
  await driver.workspaceFor(e.project)
  assert.equal(paths[1], paths[0])
  assert.equal(readFileSync(join(paths[1], 'delivery.txt'), 'utf8'), 'keep this result')
})
