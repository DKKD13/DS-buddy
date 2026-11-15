import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../lib/store.js'
import { Actions } from '../lib/actions.js'
import { DeviceGrants } from '../lib/devices.js'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-grants-'));t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, { warn() {} });store.load();const driver = { deliver() {} }, actions = new Actions(store, driver)
  const p = store.get(actions.createProject({ name: '设备授权' }).projectId), other = store.get(actions.createProject({ name: '其他项目' }).projectId)
  let at = Date.now()
  const devices = [{ id: 'dev_fixture', name: '测试设备', roots: [{ id: 'notes', label: '工作资料', path: '/must/not/publish', token: 'never-publish' }] }]
  const grants = new DeviceGrants(store, { devices: () => devices, now: () => at })
  const grant = patch => grants.grant(p.id, { deviceId: 'dev_fixture', rootId: 'notes', kind: 'folder', access: 'read', expiresAt: at + 60000, expectedRevision: grants.snapshot(p.id).revision, requestId: 'req-' + p.seq, ...patch })
  return { root, store, actions, driver, p, other, grants, devices, grant, advance: delta => { at += delta } }
}

test('directory grants record owner authority and expose only configured device labels', t => {
  const f = setup(t), saved = f.grant(), state = f.grants.snapshot(f.p.id)
  assert.equal(saved.kind, 'folder');assert.equal(saved.access, 'read');assert.equal(saved.approvedBy, 'owner')
  assert.equal(state.revision, 1);assert.equal(state.grants.length, 1)
  assert.ok(!JSON.stringify(state).includes('/must/not/publish'));assert.ok(!JSON.stringify(state).includes('never-publish'))
  assert.deepEqual(state.devices[0].roots, [{ id: 'notes', label: '工作资料' }])
  assert.equal(f.grants.snapshot(f.other.id).grants.length, 0)
})

test('unknown devices/roots, authority fields and invalid expiry never append grants', t => {
  const f = setup(t), seq = f.p.seq
  for (const patch of [{ deviceId: 'other' }, { rootId: '../outside' }, { rootId: 'absent' }, { approvedBy: 'owner' }, { path: '/outside' }, { kind: 'admin' }, { access: 'exec' }, { expiresAt: 0 }, { expiresAt: Number.MAX_SAFE_INTEGER }]) assert.throws(() => f.grant(patch))
  assert.equal(f.p.seq, seq)
})

test('stale owner views cannot overwrite grants and request replay preserves original expiry', t => {
  const f = setup(t), input = { requestId: 'fixed', expectedRevision: 0 }, saved = f.grant(input)
  assert.throws(() => f.grant({ expectedRevision: 0 }), { code: 'GRANT_CONFLICT' })
  f.advance(120000)
  const replay = f.grants.grant(f.p.id, { deviceId: saved.deviceId, rootId: saved.rootId, kind: saved.kind, access: saved.access, expiresAt: saved.expiresAt, ...input })
  assert.equal(replay.id, saved.id);assert.equal(f.grants.snapshot(f.p.id).revision, 1)
  assert.equal(f.grants.snapshot(f.p.id).grants[0].state, 'expired')
  assert.throws(() => f.grants.resolve(f.p.id, saved.id, 'fs.read'), { code: 'GRANT_EXPIRED' })
  assert.throws(() => f.grant({ ...input, access: 'write' }), { code: 'IDEMPOTENCY_CONFLICT' })
})

test('enabling execution atomically revokes directory grants on that device', t => {
  const f = setup(t), folder = f.grant()
  const execution = f.grant({ kind: 'exec', access: undefined })
  const state = f.grants.snapshot(f.p.id)
  assert.equal(state.revision, 2);assert.equal(state.grants.find(g => g.id === folder.id).state, 'revoked')
  assert.equal(state.grants.find(g => g.id === execution.id).state, 'active')
  assert.throws(() => f.grants.resolve(f.p.id, folder.id, 'fs.read'), { code: 'GRANT_REVOKED' })
  assert.throws(() => f.grant(), { code: 'EXEC_ACTIVE' })
  assert.equal(f.p.events.filter(e => e.type.startsWith('device.')).length, 2, 'switch is one event')
})

test('file write and execution remain separate capabilities and grants never cross projects', t => {
  const f = setup(t), read = f.grant()
  assert.throws(() => f.grants.resolve(f.p.id, read.id, 'fs.write'), { code: 'FORBIDDEN' })
  assert.throws(() => f.grants.resolve(f.p.id, read.id, 'exec'), { code: 'FORBIDDEN' })
  assert.throws(() => f.grants.resolve(f.other.id, read.id, 'fs.read'), { code: 'FORBIDDEN' })
  const write = f.grant({ access: 'write' });assert.equal(f.grants.resolve(f.p.id, write.id, 'fs.write').id, write.id)
  assert.throws(() => f.grants.resolve(f.p.id, write.id, 'exec'), { code: 'FORBIDDEN' })
})

test('revocation has a durable idempotent receipt and does not resurrect on replay', t => {
  const f = setup(t), grant = f.grant(), input = { grantId: grant.id, expectedRevision: 1, requestId: 'revoke' }
  const revoked = f.grants.revoke(f.p.id, input);assert.equal(revoked.state, 'revoked')
  const next = f.grant({ access: 'write' });const revision = f.grants.snapshot(f.p.id).revision
  assert.deepEqual(f.grants.revoke(f.p.id, input), revoked);assert.equal(f.grants.snapshot(f.p.id).revision, revision)
  assert.equal(f.grants.resolve(f.p.id, next.id, 'fs.write').id, next.id)
  assert.throws(() => f.grants.revoke(f.p.id, { ...input, grantId: next.id }), { code: 'IDEMPOTENCY_CONFLICT' })
})

test('grant renewals cannot reuse old identities and a removed root loses authority', t => {
  const f = setup(t), old = f.grant(), next = f.grant({ access: 'write' })
  assert.notEqual(old.id, next.id);assert.equal(f.grants.snapshot(f.p.id).grants.find(g => g.id === old.id).state, 'revoked')
  f.devices[0].roots = []
  assert.throws(() => f.grants.resolve(f.p.id, next.id, 'fs.read'), { code: 'DEVICE_UNAVAILABLE' })
})

test('event replay preserves grant revisions, revocation and expiry without exposing host roots', t => {
  const f = setup(t), folder = f.grant(), execute = f.grant({ kind: 'exec', access: undefined })
  const other = f.grants.grant(f.other.id, { deviceId: 'dev_fixture', rootId: 'notes', kind: 'folder', access: 'read', expiresAt: folder.expiresAt, expectedRevision: 0, requestId: 'other' })
  f.grants.revoke(f.p.id, { grantId: execute.id, expectedRevision: 2, requestId: 'revoke' })
  const replay = new ProjectStore(f.root, { warn() {} });replay.load()
  const grants = new DeviceGrants(replay, { devices: () => f.devices })
  assert.equal(grants.snapshot(f.p.id).revision, 3);assert.ok(grants.snapshot(f.p.id).grants.every(g => g.state === 'revoked'))
  assert.equal(grants.resolve(f.other.id, other.id, 'fs.read').id, other.id)
  assert.ok(!JSON.stringify(f.p.events).includes('/must/not/publish'))
})
