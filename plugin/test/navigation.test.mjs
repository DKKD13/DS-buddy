import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../lib/store.js'
import { Actions } from '../lib/actions.js'
import { snapshot } from '../lib/http.js'
import { buildDay } from '../lib/today.js'

test('workspace navigation lists project threads, including threads with no execution session', t => {
  const root = mkdtempSync(join(tmpdir(), 'mira-navigation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, { warn() {} }); store.load()
  const driver = { deliver() {}, status: () => 'idle', childrenOf: () => [], memberModel: () => null }
  const actions = new Actions(store, driver)
  const { projectId } = actions.createProject({ name: '项目甲' })
  const p = store.get(projectId)
  const opened = actions.openThread(p, { title: '核对交付', brief: '核对结果', assignee: '工程师' })
  const row = snapshot(store, driver).projects.find(x => x.id === projectId)
  assert.deepEqual(row.threads.map(x => [x.id, x.title, x.state]), [[opened.threadId, '核对交付', 'working']])
  // v4: rows stay keyed by the domain thread; each also names its bound DSH Session (null before execution) so a task opens as that Session.
  assert.deepEqual(row.threads.map(x => x.sessionId), [null])
  store.append(projectId, { type: 'session.bound', key: 'w:' + opened.threadId, sessionId: 's-task', generation: 1 })
  assert.deepEqual(snapshot(store, driver).projects.find(x => x.id === projectId).threads.map(x => [x.id, x.sessionId]), [[opened.threadId, 's-task']])
})

test('snapshot agrees across workspace, task and dock when a replaced session still has active children', t => {
  const root = mkdtempSync(join(tmpdir(), 'mira-task-state-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, { warn() {} }); store.load()
  const driver = { deliver() {}, status: () => 'idle', childrenOf: id => id === 'old-session' ? [{ id: 'child', running: true, status: 'stopping' }] : [], memberModel: () => null }
  const actions = new Actions(store, driver)
  const { projectId } = actions.createProject({ name: '长期任务' }), p = store.get(projectId)
  const { threadId } = actions.openThread(p, { title: '持续任务', brief: '不丢历史', assignee: '工程师' })
  for (const [sessionId, generation] of [['old-session', 1], ['new-session', 2]]) store.append(projectId, { type: 'session.bound', key: 'w:' + threadId, sessionId, generation })
  const snap = snapshot(store, driver, projectId)
  assert.equal(snap.projects[0].working, 1)
  assert.equal(snap.projects[0].busy, true)
  assert.equal(snap.projects[0].threads[0].experience.group, 'executing')
  assert.equal(snap.project.threads[0].experience.execution.phase, 'stopping')
  assert.deepEqual(snap.project.threads[0].sessions.map(s => [s.id, s.current]), [['old-session', false], ['new-session', true]])
  assert.equal(snap.project.threads[0].children[0].parentId, 'old-session')
  assert.equal(snap.dock.working[0].threadId, threadId)
  assert.equal(snap.dock.working[0].execution.activeChildren, 1)
})

test('workspace, thread and dock agree on actual device waiting and unconfirmed execution', t => {
  const root = mkdtempSync(join(tmpdir(), 'mira-device-navigation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, { warn() {} });store.load()
  const driver = { deliver() {}, status: () => 'running', childrenOf: () => [], memberModel: () => null }
  const actions = new Actions(store, driver), { projectId } = actions.createProject({ name: '设备任务' }), p = store.get(projectId)
  const { threadId } = actions.openThread(p, { title: '等待设备', brief: '真实状态', assignee: '工程师' })
  for (const [phase, active] of [['waiting_device', false], ['running', true], ['unconfirmed', false], ['stopping', true]]) {
    const states = new Map([[projectId + '|w:' + threadId, [{ requestId: 'r', deviceId: 'd', phase, stopped: false, pending: true }]]])
    const snap = snapshot(store, driver, projectId, undefined, undefined, states)
    assert.equal(snap.projects[0].working, active ? 1 : 0)
    assert.equal(snap.project.threads[0].experience.execution.active, active)
    assert.equal(snap.projects[0].threads[0].experience.reason, snap.project.threads[0].experience.reason)
    assert.equal(snap.dock.working.some(row => row.threadId === threadId), active)
    const day = buildDay(store, undefined, { status: driver.status,
      execution: (_p, t) => snap.project.threads.find(row => row.id === t.id).experience.execution })
    assert.equal(day.projects.find(row => row.id === projectId).busy.includes('工程师'), active)
  }
})

test('follow-up tasks keep a durable source link without reopening or modifying accepted delivery', t => {
  const root = mkdtempSync(join(tmpdir(), 'mira-related-task-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, { warn() {} }); store.load()
  const driver = { deliver() {}, status: () => 'idle', childrenOf: () => [], memberModel: () => null }
  const actions = new Actions(store, driver)
  const { projectId } = actions.createProject({ name: '关联任务' }), p = store.get(projectId)
  const old = actions.openThread(p, { title: '原交付', brief: '原结果', assignee: '工程师' })
  actions.ownerUpdateThread({ projectId, threadId: old.threadId, state: 'done', resolved: true })
  const seq = p.seq
  assert.throws(() => actions.openThread(p, { title: '越界来源', brief: '无效', assignee: '工程师', related_thread_id: 't_other_project' }), /当前项目/)
  assert.equal(p.seq, seq)
  const followup = actions.openThread(p, { title: '下一版', brief: '新目标', assignee: '工程师', related_thread_id: old.threadId })
  const replay = new ProjectStore(root, { warn() {} }); replay.load()
  const snapshotThread = snapshot(replay, driver, projectId).project.threads.find(t => t.id === followup.threadId)
  assert.equal(snapshotThread.relatedThreadId, old.threadId)
  assert.equal(replay.get(projectId).threads.get(old.threadId).state, 'done')
  assert.equal(replay.get(projectId).threads.get(old.threadId).resolved, true)
})
