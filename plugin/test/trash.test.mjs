import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore, MIRA, workerKey } from '../lib/store.js'
import { Actions } from '../lib/actions.js'
import { snapshot } from '../lib/http.js'
import { ensureHub, HUB_ID, hubRolePrompt } from '../lib/hub.js'
import { PersonalMira } from '../lib/personal.js'
import { liveBlobKeysFromStore } from '../lib/blob-maintenance.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-trash-'))
  const store = new ProjectStore(root, { warn() {} }), hubStore = new ProjectStore(join(root, '_hub'), { warn() {} })
  store.load(); hubStore.load(); ensureHub(hubStore)
  const running = new Set()
  const driver = { deliver() {}, status: (_projectId, key) => running.has(key) ? 'running' : 'idle', childrenOf: () => [], memberModel: () => null }
  const actions = new Actions(store, driver)
  const personal = new PersonalMira(hubStore, driver, store, actions)
  t.after(() => { personal.close(); rmSync(root, { recursive: true, force: true }) })
  const { projectId } = actions.createProject({ name: '试玩' })
  const { threadId } = actions.openThread(store.get(projectId), { title: '写简介', brief: '100 字以内', assignee: '工程师' })
  store.append(projectId, { type: 'session.bound', key: workerKey(threadId), sessionId: 's-task', generation: 1 })
  const say = (text, kind = 'human') => hubStore.append(HUB_ID, { type: 'message.posted', messageId: hubStore.newMessageId(), threadId: null,
    author: kind === 'human' ? { kind: 'human', id: 'owner' } : { kind: 'assistant', id: MIRA }, trust: kind === 'human' ? 'principal' : 'relay', text, mentions: [], to: [] }).messageId
  return { root, store, hubStore, driver, running, actions, personal, projectId, threadId, say }
}

test('a deleted project leaves every list and its Sessions, nothing is erased, and a restore puts it back whole', async t => {
  const f = fixture(t)
  const before = f.store.get(f.projectId).events.length
  assert.deepEqual(await f.actions.deleteProject({ projectId: f.projectId }), { ok: true, projectId: f.projectId, name: '试玩' })
  assert.equal(f.store.projects.has(f.projectId), false)
  assert.throws(() => f.store.get(f.projectId), /没有这个项目/)
  // Its Session is an ordinary DSH Session from here on.
  assert.equal(f.store.bySession('s-task'), undefined)
  const snap = snapshot(f.store, f.driver)
  assert.deepEqual(snap.projects.map(p => p.id), [])
  assert.deepEqual(snap.trash.map(p => [p.id, p.name, p.threads]), [[f.projectId, '试玩', 1]])
  assert.equal(snapshot(f.store, f.driver, f.projectId).project, null)
  // Nothing more is written into a deleted project, and it cannot be deleted twice.
  assert.throws(() => f.store.append(f.projectId, { type: 'thread.updated', threadId: f.threadId, patch: { resolved: true } }), /没有这个项目/)
  await assert.rejects(f.actions.deleteProject({ projectId: f.projectId }), /没有这个项目/)
  // The trash survives a restart.
  const replay = new ProjectStore(f.root, { warn() {} }); replay.load()
  assert.equal(replay.projects.has(f.projectId), false)
  assert.equal(replay.trash.get(f.projectId).name, '试玩')
  assert.equal(replay.bySession('s-task'), undefined)

  assert.deepEqual(f.actions.restoreProject({ projectId: f.projectId }), { ok: true, projectId: f.projectId, name: '试玩', pausedAutomations: 0 })
  const back = f.store.get(f.projectId)
  assert.equal(back.events.length, before + 2)
  assert.deepEqual(back.threadOrder, [f.threadId])
  assert.deepEqual(f.store.bySession('s-task'), { projectId: f.projectId, key: workerKey(f.threadId) })
  assert.deepEqual(snapshot(f.store, f.driver).trash, [])
  assert.throws(() => f.actions.restoreProject({ projectId: f.projectId }), /回收站里没有这个项目/)
  const again = new ProjectStore(f.root, { warn() {} }); again.load()
  assert.equal(again.get(f.projectId).name, '试玩')
  assert.deepEqual(again.bySession('s-task'), { projectId: f.projectId, key: workerKey(f.threadId) })
  assert.equal(again.trash.size, 0)
})

test('a project is not deleted in the middle of a turn, and its schedules are paused before it goes', async t => {
  const f = fixture(t)
  f.running.add(workerKey(f.threadId))
  await assert.rejects(f.actions.deleteProject({ projectId: f.projectId }), /还有会话在跑/)
  assert.equal(f.store.projects.has(f.projectId), true)
  f.running.clear()

  const add = (automationId, later = []) => {
    f.store.append(f.projectId, { type: 'automation.created', automationId, requestId: automationId, title: automationId, prompt: 'x', target: {}, rule: {} })
    for (const event of later) f.store.append(f.projectId, { automationId, ...event })
  }
  add('a-live', [{ type: 'automation.bound', schedule: {} }])
  add('a-paused', [{ type: 'automation.stop.requested', deleted: false }, { type: 'automation.stopped', deleted: false }])
  add('a-gone', [{ type: 'automation.stop.requested', deleted: true }, { type: 'automation.stopped', deleted: true }])
  const paused = []
  f.actions.automations = { pause: async input => {
    assert.equal(f.store.projects.has(f.projectId), true, 'paused while the project is still there')
    paused.push(input)
    f.store.append(input.projectId, { type: 'automation.stop.requested', automationId: input.automationId, deleted: false })
    f.store.append(input.projectId, { type: 'automation.stopped', automationId: input.automationId, deleted: false })
  } }
  await f.actions.deleteProject({ projectId: f.projectId })
  assert.deepEqual(paused, [{ projectId: f.projectId, automationId: 'a-live' }])
  // Restoring does not start them again; it says how many are waiting.
  assert.equal(f.actions.restoreProject({ projectId: f.projectId }).pausedAutomations, 2)

  // A schedule that cannot be stopped keeps the project where it is.
  add('a-stuck', [{ type: 'automation.bound', schedule: {} }])
  f.actions.automations = { pause: async () => { throw new Error('日程服务尚未就绪') } }
  await assert.rejects(f.actions.deleteProject({ projectId: f.projectId }), /日程服务尚未就绪/)
  assert.equal(f.store.projects.has(f.projectId), true)
})

test('files of a project in the trash are kept, so a restore finds them', async t => {
  const f = fixture(t)
  const blobs = { location: (projectId, sha256) => `${projectId}/${sha256}` }
  f.store.append(f.projectId, { type: 'repository.imported', repository: { sha256: 'abc' } })
  assert.deepEqual([...liveBlobKeysFromStore(f.store, blobs)], [`${f.projectId}/abc`])
  await f.actions.deleteProject({ projectId: f.projectId })
  assert.deepEqual([...liveBlobKeysFromStore(f.store, blobs)], [`${f.projectId}/abc`])
})

test('the assistant deletes, restores and archives on the owner\'s words only, and says what it did', async t => {
  const f = fixture(t)
  const other = f.actions.createProject({ name: '另一个' }).projectId
  const asked = f.say('把「试玩」和「另一个」都删了')
  // Only on the owner's own words, and only a project that exists (the error names the ones there are).
  await assert.rejects(f.personal.deleteProject({ projectId: f.projectId }, { messageId: f.say('我替你删了', 'assistant') }), /用户本人的原话/)
  await assert.rejects(f.personal.deleteProject({ projectId: f.projectId }, { messageId: '' }), /用户本人的原话/)
  await assert.rejects(f.personal.deleteProject({ projectId: 'p_missing' }, { messageId: asked }), new RegExp(`现有项目：.*试玩（${f.projectId}）`))
  assert.equal(f.store.projects.size, 2)
  // One message may name several projects.
  await f.personal.deleteProject({ projectId: f.projectId }, { messageId: asked })
  await f.personal.deleteProject({ projectId: other }, { messageId: asked })
  assert.equal(f.store.projects.size, 0)
  assert.deepEqual(f.personal.snapshot().actions.slice(-2).map(a => [a.kind, a.text, a.projectId]),
    [['delete', '把项目「试玩」移进了回收站', f.projectId], ['delete', '把项目「另一个」移进了回收站', other]])

  const back = f.say('「试玩」还是恢复吧')
  assert.throws(() => f.personal.restoreProject({ projectId: 'p_missing' }, { messageId: back }), new RegExp(`回收站里有：.*另一个（${other}）`))
  assert.throws(() => f.personal.restoreProject({ projectId: f.projectId }, { messageId: '' }), /用户本人的原话/)
  f.personal.restoreProject({ projectId: f.projectId }, { messageId: back })
  assert.equal(f.store.get(f.projectId).name, '试玩')
  assert.deepEqual(f.personal.snapshot().actions.at(-1).kind, 'restore')

  const tidy = f.say('「写简介」不要了，收掉')
  assert.throws(() => f.personal.archiveTask({ projectId: f.projectId, threadId: 't_missing' }, { messageId: tidy }), /没有这个任务/)
  assert.throws(() => f.personal.archiveTask({ projectId: f.projectId, threadId: f.threadId }, { messageId: '' }), /用户本人的原话/)
  f.personal.archiveTask({ projectId: f.projectId, threadId: f.threadId }, { messageId: tidy })
  assert.equal(f.store.get(f.projectId).threads.get(f.threadId).resolved, true)
  assert.match(f.personal.snapshot().actions.at(-1).text, /归档了「写简介」/)
  assert.throws(() => f.personal.archiveTask({ projectId: f.projectId, threadId: f.threadId }, { messageId: tidy }), /已经归档/)
  // The assistant is told it can.
  assert.match(hubRolePrompt(f.hubStore.get(HUB_ID)), /归档一个任务（hub_task_archive）、删除或恢复一个项目（hub_project_delete、hub_project_restore，删除只是移进回收站）/)
})
