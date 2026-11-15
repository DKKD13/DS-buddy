import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, COORDINATOR, MIRA, workerKey } from '../lib/store.js'
import { Driver } from '../lib/driver.js'
import { Actions } from '../lib/actions.js'
import { createTools, visibleTo, maskPluginTools } from '../lib/tools.js'
import { HubActions, ensureHub } from '../lib/hub.js'
import { createHubTools, visibleToHub } from '../lib/hub-tools.js'

// DSH's tools.register takes no visibility option: every plugin tool reaches every Session unless that Session masks it.
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mira-masks-'));t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = { logger: { warn() {} }, agents: { withoutInitiator: fn => fn(), get: () => undefined }, sessions: { flush: async () => true }, get: () => undefined }
  const store = new ProjectStore(dir, ctx.logger);store.load()
  const driver = new Driver(ctx, store, content => ({ content }))
  const actions = new Actions(store, driver)
  const hubStore = new ProjectStore(join(dir, '_hub'), ctx.logger);hubStore.load();ensureHub(hubStore)
  const hubDriver = new Driver(ctx, hubStore, content => ({ content }))
  const projectTools = createTools({ defineTool: d => d, store, driver, actions })
  const hubTools = createHubTools({ defineTool: d => d, hubStore, hubDriver, hubActions: new HubActions(hubStore, hubDriver, store, actions), projects: store, projectDriver: driver })
  // What index.js keeps: every plugin tool and who may see it.
  const plugin = [...hubTools.map(({ definition }) => ({ name: definition.name, visible: visibleToHub(hubStore) })),
    ...projectTools.map(({ role, definition }) => ({ name: definition.name, visible: visibleTo(store, role) }))]
  const p = store.get(store.createProject({ name: '达标', cwd: dir }).projectId)
  for (const [key, sessionId] of [[COORDINATOR, 's-coordinator'], [workerKey('t_1'), 's-worker'], [MIRA, 's-project-mira']]) store.append(p.id, { type: 'session.bound', key, sessionId, assignee: key })
  // A DSH agent as far as masking goes: the tools it would be offered (DSH's own among them) and its restrictions.
  const agent = id => {
    const masks = []
    return { id, masks, ctx: { tools: { schemas: () => [...plugin.map(t => ({ name: t.name })), { name: 'bash' }, { name: 'web_search' }], restrict: filter => { masks.push(filter) } } } }
  }
  const offered = a => new Set(a.ctx.tools.schemas().map(s => s.name).filter(name => !a.masks.some(m => m.deny?.includes(name))))
  return { store, plugin, projectTools, hubTools, agent, offered }
}

test('a project Session is offered only its own role\'s plugin tools: never Mira\'s, never another role\'s, DSH\'s own untouched', t => {
  const f = setup(t)
  const role = name => f.projectTools.find(x => x.definition.name === name)?.role
  for (const id of ['s-coordinator', 's-worker', 's-project-mira']) {
    const a = f.agent(id)
    maskPluginTools(a, f.plugin)
    const names = f.offered(a)
    for (const { definition } of f.hubTools) assert.ok(!names.has(definition.name), `${id} must not be offered Mira's ${definition.name}`)
    for (const { role: r, definition } of f.projectTools) assert.equal(names.has(definition.name), visibleTo(f.store, r)({ agent: a }), `${id} · ${definition.name}`)
    assert.ok(names.has('bash') && names.has('web_search'), 'DSH tools are not the plugin\'s to mask')
  }
  // The split the user saw broken: the executor no longer sees the project assistant's tools, and the reverse.
  const worker = f.agent('s-worker');maskPluginTools(worker, f.plugin)
  const coordinator = f.agent('s-coordinator');maskPluginTools(coordinator, f.plugin)
  assert.equal(role('open_thread'), 'coordinator')
  assert.ok(!f.offered(worker).has('open_thread') && !f.offered(worker).has('hub_search'))
  assert.ok(f.offered(coordinator).has('open_thread') && !f.offered(coordinator).has('hub_search'))
  // 2026-11-13: no roles. The project assistant can no longer create an executor; tasks go to the project's one.
  assert.ok(!f.projectTools.some(x => x.definition.name === 'add_member'))
})

test('masking names only tools the Session was offered, and does nothing when none are foreign', t => {
  const f = setup(t)
  const bare = { id: 's-worker', ctx: { tools: { schemas: () => [{ name: 'bash' }], restrict: () => { throw Error('nothing to mask') } } } }
  assert.doesNotThrow(() => maskPluginTools(bare, f.plugin), 'a tool DSH did not offer is never named (DSH rejects unknown names)')
})
