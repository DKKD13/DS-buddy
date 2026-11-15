import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../lib/store.js'
import { Actions } from '../lib/actions.js'
import { ProjectAutomations, normalizeRule } from '../lib/automations.js'
import { Driver } from '../lib/driver.js'

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mira-auto-'));t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new ProjectStore(directory, { warn() {} });store.load()
  const delivered = [], agents = new Map(), rows = [], history = new Map()
  const driver = { deliver: e => delivered.push(e), workspaceFor: async () => undefined,
    controller: { resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: true },
      create: async ({ sessionId }) => { agents.set(sessionId, { id: sessionId, session: {}, ctx: { on: (_event, hook) => { agents.get(sessionId).reject = hook;return () => {} } } });return { sessionId } },
    } }
  const actions = new Actions(store, driver), project = store.get(actions.createProject({ name: '自动项目' }).projectId)
  const native = { creates: 0, loseResponse: false,
    catalog: async () => rows,
    create: async (sessionId, request) => {
      const record = { id: 'native-' + ++native.creates, sessionId, status: 'active', kind: 'after', scheduledAt: new Date(Date.now() + 5000).toISOString(), ...request }
      rows.push(record);history.set(record.id, [])
      if (native.loseResponse) throw new Error('lost response')
      return record
    },
    delete: async ({ id }) => { const index = rows.findIndex(r => r.id === id);if (index >= 0) rows.splice(index, 1);return { deleted: index >= 0 } },
    history: async ({ id }) => ({ records: history.get(id) ?? [] }),
  }
  const manager = new ProjectAutomations({ get() { return undefined } }, store, driver);manager.native = native
  const create = patch => manager.create({ projectId: project.id, title: '检查进度', prompt: '有新进展才汇报，不验收合并', rule: { kind: 'after', seconds: 5 }, ...patch })
  const fire = task => {
    const row = rows.find(r => r.id === task.nativeId), receipt = { scheduledAt: new Date().toISOString(), deliveredAt: new Date().toISOString(), messageId: 'shared-batch-message' }
    row.lastDelivery = receipt;history.get(row.id).unshift(receipt);return row
  }
  return { directory, store, driver, project, native, manager, create, rows, agents, delivered, fire }
}

test('native creation lost response recovers the durable intent without creating a second task or model courier', async t => {
  const e = setup(t);e.native.loseResponse = true
  assert.equal((await e.create()).status, 'error')
  const replay = new ProjectStore(e.directory, { warn() {} });replay.load()
  const manager = new ProjectAutomations({ get() {} }, replay, e.driver);manager.native = e.native
  e.native.loseResponse = false;await manager.reconcile()
  const task = [...replay.get(e.project.id).automations.values()][0]
  assert.equal(task.status, 'active');assert.equal(e.native.creates, 1)
  assert.equal(e.store.bySession(e.project.courierSessionId), undefined)
  assert.deepEqual(await e.agents.get(e.project.courierSessionId).reject(), { kind: 'reject' })
})

test('durable receipts route to the inbox once across replay; shared native batch message IDs do not collide', async t => {
  const e = setup(t);await e.create();await e.create({ title: '记忆回顾', target: 'mira' })
  for (const task of e.project.automations.values()) e.fire(task)
  await e.manager.reconcile();await e.manager.reconcile()
  assert.equal(e.delivered.length, 2)
  assert.deepEqual(e.delivered.map(event => event.to[0]).sort(), ['coordinator', 'mira'])
  const replay = new ProjectStore(e.directory, { warn() {} });replay.load()
  const manager = new ProjectAutomations({ get() {} }, replay, e.driver);manager.native = e.native
  await manager.reconcile();assert.equal(e.delivered.length, 2)
  assert.equal(e.project.configRevision, 0)
  assert.equal(e.project.events.filter(e => e.type === 'message.posted' && e.author?.kind === 'human').length, 0)
})

test('pause and deletion remove only owned native tasks; resume starts a new generation', async t => {
  const e = setup(t), { automationId } = await e.create()
  const task = e.project.automations.get(automationId), old = task.nativeId
  e.rows.push({ id: 'unrelated', sessionId: 'another-session', prompt: 'untouched', status: 'active' })
  await e.manager.pause({ projectId: e.project.id, automationId })
  assert.equal(task.status, 'paused');assert.equal(e.rows.some(r => r.id === old), false)
  await e.manager.resume({ projectId: e.project.id, automationId })
  assert.notEqual(task.nativeId, old);assert.equal(task.epoch, 2)
  await e.manager.pause({ projectId: e.project.id, automationId, deleted: true })
  assert.equal(task.status, 'deleted');assert.equal(e.rows.length, 1);assert.equal(e.rows[0].id, 'unrelated')
  await assert.rejects(e.manager.resume({ projectId: e.project.id, automationId }), /已删除/)
})

test('recovery coalesces unsent receipts to the latest and records the catch-up limits', async t => {
  const e = setup(t), { automationId } = await e.create(), task = e.project.automations.get(automationId)
  const row = e.fire(task), newest = row.lastDelivery
  e.native.history = async () => ({ records: [newest, { ...newest, scheduledAt: new Date(Date.parse(newest.scheduledAt) - 1000).toISOString() }], earlierRecordsUnavailable: true })
  await e.manager.reconcile()
  assert.equal(e.delivered.length, 1);assert.equal(e.delivered[0].coalesced, 1);assert.equal(e.delivered[0].earlierUnavailable, true)
})

test('external native deletion is visible and does not silently re-arm the task', async t => {
  const e = setup(t), { automationId } = await e.create()
  e.rows.splice(0);await e.manager.reconcile();await e.manager.reconcile()
  assert.equal(e.project.automations.get(automationId).status, 'missing');assert.equal(e.native.creates, 1)
  assert.throws(() => normalizeRule({ kind: 'every', minutes: 0 }))
  assert.throws(() => normalizeRule({ kind: 'daily', time: '25:00', timeZone: 'Asia/Shanghai' }))
  assert.throws(() => normalizeRule({ kind: 'daily', time: '09:00', timeZone: 'invalid-zone' }))
})

test('an owner retry with the same request ID cannot create a second task or change its intent', async t => {
  const e = setup(t), first = await e.create({ requestId: 'owner-request-123' })
  const retry = await e.create({ requestId: 'owner-request-123' })
  assert.equal(first.automationId, retry.automationId);assert.equal(e.native.creates, 1)
  await assert.rejects(e.create({ requestId: 'owner-request-123', prompt: 'another task' }), /另一份/)
})

test('a crash after the project event but before wake leaves durable unread work for Driver recovery', async t => {
  const e = setup(t), { automationId } = await e.create()
  e.fire(e.project.automations.get(automationId));e.driver.deliver = () => { throw new Error('crash before wake') }
  await e.manager.reconcile()
  const replay = new ProjectStore(e.directory, { warn() {} });replay.load()
  const project = replay.get(e.project.id)
  assert.equal(project.automations.get(automationId).occurrences.size, 1)
  assert.equal(replay.unread(project, 'coordinator').filter(e => e.type === 'automation.triggered').length, 1)
  const recovered = [], driver = new Driver({}, replay, value => value)
  driver.schedule = (projectId, key) => recovered.push({ projectId, key })
  driver.recover()
  assert.deepEqual(recovered, [{ projectId: project.id, key: 'coordinator' }])
})

test('a concurrent resume waits for the pending pause to commit before arming the next generation', async t => {
  const e = setup(t), { automationId } = await e.create(), task = e.project.automations.get(automationId)
  const old = task.nativeId, catalog = e.native.catalog
  let release, started
  const entering = new Promise(resolve => { started = resolve }), barrier = new Promise(resolve => { release = resolve })
  e.native.catalog = async () => { started();await barrier;return catalog() }
  const paused = e.manager.pause({ projectId: e.project.id, automationId })
  await entering
  const resumed = e.manager.resume({ projectId: e.project.id, automationId })
  assert.equal(task.enabled, false)
  release();await Promise.all([paused, resumed])
  assert.equal(task.status, 'active');assert.equal(task.epoch, 2)
  assert.ok(e.rows.some(row => row.id === task.nativeId));assert.equal(e.rows.some(row => row.id === old), false)
})

test('resuming a paused task respects the active-task limit as creation does', async t => {
  const e = setup(t), paused = await e.create()
  await e.manager.pause({ projectId: e.project.id, automationId: paused.automationId })
  for (let index = 0; index < 10; index++) await e.create({ title: '任务 ' + index })
  const before = e.native.creates
  await assert.rejects(e.manager.resume({ projectId: e.project.id, automationId: paused.automationId }), /最多启用/)
  assert.equal(e.native.creates, before);assert.equal(e.project.automations.get(paused.automationId).status, 'paused')
})

test('a failed delete intent cannot be resumed into a new live schedule', async t => {
  const e = setup(t), { automationId } = await e.create(), remove = e.native.delete
  e.native.delete = async () => { throw new Error('delete transport unavailable') }
  await assert.rejects(e.manager.pause({ projectId: e.project.id, automationId, deleted: true }))
  await assert.rejects(e.manager.resume({ projectId: e.project.id, automationId }), /删除/)
  assert.equal(e.native.creates, 1)
  e.native.delete = remove;await e.manager.reconcile()
  assert.equal(e.project.automations.get(automationId).status, 'deleted');assert.equal(e.rows.length, 0)
})

test('resuming after a failed pause removes the old native task before arming another generation', async t => {
  const e = setup(t), { automationId } = await e.create(), remove = e.native.delete
  e.native.delete = async () => { throw new Error('pause transport unavailable') }
  await assert.rejects(e.manager.pause({ projectId: e.project.id, automationId }))
  const old = e.project.automations.get(automationId).nativeId
  e.native.delete = remove;await e.manager.resume({ projectId: e.project.id, automationId })
  assert.equal(e.rows.length, 1);assert.notEqual(e.rows[0].id, old)
  assert.equal(e.project.automations.get(automationId).status, 'active')
})
