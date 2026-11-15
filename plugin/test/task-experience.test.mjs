import test from 'node:test'
import assert from 'node:assert/strict'
import { taskExperience, sessionHistory } from '../lib/task-experience.js'
import { continuityNotice } from '../lib/protocol.js'
import { COORDINATOR, MIRA } from '../lib/store.js'
import { Driver } from '../lib/driver.js'

const thread = patch => ({ id: 't_one', state: 'working', resolved: false, brief: '完成交付', checklist: [], decisionIds: [], ...patch })
const view = (t, run = {}) => taskExperience(t, { status: 'idle', children: [], ...run }, new Map())

test('queued and idle work remain unresolved; ending a turn does not solve a task', () => {
  assert.equal(view(thread(), { status: 'queued' }).group, 'unresolved')
  assert.equal(view(thread(), { status: 'queued' }).reason, '排队中')
  assert.equal(view(thread()).reason, '等待继续')
  assert.equal(view(thread(), { status: 'running' }).group, 'executing')
})

test('a model turn waiting on a device does not turn queued work into executing work', () => {
  for (const [phase, reason] of [['queued', '设备排队中'], ['waiting_device', '等待设备'], ['starting', '准备设备执行']]) {
    const result = view(thread(), { status: 'running', devices: [{ requestId: 'r', deviceId: 'd', phase, pending: true, stopped: false }] })
    assert.equal(result.group, 'unresolved')
    assert.equal(result.execution.active, false)
    assert.equal(result.reason, reason)
    assert.equal(view(thread(), { status: 'running', devices: result.execution.devices, children: [{ running: true }] }).group, 'executing')
  }
})

test('device execution and stop confirmation survive an idle or failed model turn', () => {
  const state = phase => ({ devices: [{ requestId: 'r', deviceId: 'd', phase, pending: false, stopped: false }], lastTurn: { failed: true } })
  assert.equal(view(thread(), state('running')).group, 'executing')
  assert.equal(view(thread(), state('stopping')).execution.phase, 'stopping')
  const held = view(thread(), state('unconfirmed'))
  assert.equal(held.group, 'unresolved')
  assert.equal(held.execution.held, true)
  assert.equal(held.reason, '等待设备停止确认')
  assert.match(held.summary.next, /停止.*重跑/)
  assert.equal(view(thread({ state: 'done' }), state('unconfirmed')).group, 'resolved')
})

test('a confirmed stop is independent of knowing the device outcome and never exposes private inputs', () => {
  const devices = [{ requestId: 'r', deviceId: 'd', phase: 'stopped', pending: false, stopped: true, outcome: 'unknown', args: { command: 'PRIVATE' }, result: 'PRIVATE', credential: 'PRIVATE' }]
  const result = view(thread({ state: 'review_ready' }), { devices })
  assert.equal(result.reason, '设备结果待确认')
  assert.equal(result.execution.active, false)
  assert.equal(result.execution.held, false)
  assert.match(result.summary.next, /实际文件/)
  assert.ok(!JSON.stringify(result).includes('PRIVATE'))
  assert.equal(view(thread({ state: 'done' }), { devices }).reason, '已验收')
})

test('a running or stopping child keeps execution visible after the parent goes idle', () => {
  for (const status of ['running', 'stopping']) {
    const result = view(thread(), { children: [{ id: 'child', status, running: true }] })
    assert.equal(result.group, 'executing')
    assert.equal(result.execution.activeChildren, 1)
  }
  assert.equal(view(thread(), { children: [{ id: 'child', status: 'not_loaded', running: false }] }).group, 'unresolved')
})

test('acceptance, archival, and live execution are independent facts', () => {
  assert.equal(view(thread({ state: 'done', resolved: true })).group, 'resolved')
  assert.equal(view(thread({ state: 'working', resolved: true })).group, 'archived')
  const accepted = view(thread({ state: 'done', resolved: true }), { status: 'running' })
  assert.equal(accepted.group, 'resolved')
  assert.equal(accepted.execution.active, true)
  assert.equal(view(thread({ state: 'review_ready' })).group, 'unresolved')
  assert.equal(view(thread({ state: 'review_ready' })).reason, '待验收')
  assert.equal(view(thread({ state: 'failed' })).reason, '执行失败')
})

test('summary follows pending decisions and actual checklist without inventing progress', () => {
  const t = thread({ state: 'blocked', brief: '实现上传', note: '只读来源', summary: '队列已接通', decisionIds: ['d_one'], checklist: [{ text: '恢复补传', done: false }] })
  const decisions = new Map([['d_one', { question: '是否保留图片？', chosen: null }]])
  const result = taskExperience(t, { status: 'idle', children: [] }, decisions)
  assert.equal(result.summary.goal, '实现上传')
  assert.equal(result.summary.constraints, '只读来源')
  assert.equal(result.summary.progress, '队列已接通')
  assert.equal(result.summary.next, '是否保留图片？')
  decisions.get('d_one').withdrawn = true
  assert.equal(taskExperience(t, { status: 'idle', children: [] }, decisions).summary.next, '恢复补传')
  assert.equal(view(thread()).summary.progress, null)
})

test('session history retains replaced sessions and removes duplicate bindings', () => {
  const project = { events: [
    { type: 'session.bound', key: 'w:t_one', sessionId: 's1', generation: 1, at: 10, node: 'local' },
    { type: 'session.bound', key: 'w:t_other', sessionId: 'other', at: 11 },
    { type: 'session.bound', key: 'w:t_one', sessionId: 's2', generation: 2, at: 20, node: 'node-b', continuity: true },
    { type: 'session.bound', key: 'w:t_one', sessionId: 's2', generation: 2, at: 21, node: 'node-b', continuity: true },
  ] }
  assert.deepEqual(sessionHistory(project, 'w:t_one').map(s => [s.id, s.generation, s.node]), [['s1', 1, 'local'], ['s2', 2, 'node-b']])
})

test('continuity tells each role to use only its available reading tools', () => {
  const project = { threads: new Map([['t_one', thread()]]) }
  for (const key of [COORDINATOR, 'w:t_one']) {
    assert.doesNotMatch(continuityNotice(project, key), /memory_read/)
    assert.match(continuityNotice(project, key), /inbox_read/)
  }
  assert.match(continuityNotice(project, MIRA), /memory_read/)
})

test('driver observes nested children and publishes their lifecycle changes without navigation or a new turn', async () => {
  const agents = new Map([['child', { status: 'idle' }], ['grandchild', { status: 'running' }]])
  let changes = 0
  const runtime = { async listChildren(id) { return (id === 'main' ? ['child'] : id === 'child' ? ['grandchild'] : ['main']).map(id => ({ id, mode: 'continuable' })) } }
  const driver = new Driver({ get: () => runtime, agents, logger: { warn() {} } }, { touch() { changes++ } }, x => x)
  await driver.refreshChildren(['main'])
  const descendants = driver.descendantsOf('main')
  assert.deepEqual(descendants.map(c => [c.id, c.parentId, c.depth]), [['child', 'main', 1], ['grandchild', 'child', 2]])
  assert.equal(view(thread(), { children: descendants }).group, 'executing')
  const previous = changes
  agents.get('grandchild').status = 'idle'
  driver.children.get('child').at = 0
  await driver.refreshChildren(['main'])
  assert.ok(changes > previous)
  assert.equal(view(thread(), { children: driver.descendantsOf('main') }).group, 'unresolved')
})

test('native completion turns count as running even without a driver wake slot', () => {
  const live = { status: 'running' }
  const store = { projects: new Map([['p', { sessions: new Map([['w:t', { sessionId: 'main' }]]) }]]) }
  const driver = new Driver({ agents: new Map([['main', live]]) }, store, x => x)
  assert.equal(driver.status('p', 'w:t'), 'running')
  live.status = 'idle'
  assert.equal(driver.status('p', 'w:t'), 'idle')
  driver.slots.set('p|w:t', { running: false, timer: {} })
  assert.equal(driver.status('p', 'w:t'), 'queued')
})

test('a new inbox wake does not own or acknowledge an already-running native turn', async () => {
  let finishNative, followups = 0, acked = false
  const gate = new Promise(resolve => { finishNative = resolve })
  const project = { id: 'p' }, event = { seq: 1, type: 'message.posted', author: { kind: 'human' }, to: ['w:t'] }
  const store = { touch() {}, get: () => project, unread: () => acked ? [] : [event], append: (_p, e) => { if (e.type === 'inbox.acked') acked = true } }
  const agent = { id: 'main', status: 'running', session: {}, whenIdle: () => agent.status === 'running' ? gate : Promise.resolve(), followup() { followups++; Object.assign(driver.turnOf('main'), { platform: true, replied: true, readThrough: 1 }) } }
  const driver = new Driver({ agents: new Map([['main', agent]]), sessions: { flush: async () => {} }, logger: { warn() {} } }, store, x => x, { wakeText: () => 'wake' })
  driver.ensureAgent = async () => ({ agent, continuity: false })
  driver.registerScoped = () => {}
  const slot = { running: false, again: false, wokenThrough: 0, timer: null }
  const run = driver.run('p', 'w:t', slot)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(followups, 0)
  assert.equal(driver.turnOf('main'), undefined)
  assert.equal(acked, false)
  agent.status = 'idle'; finishNative()
  await run
  assert.equal(followups, 1)
  assert.equal(acked, true)
})
