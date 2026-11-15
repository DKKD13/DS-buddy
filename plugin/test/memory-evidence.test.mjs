import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Actions } from '../lib/actions.js'
import { ProjectStore, MIRA, workerKey } from '../lib/store.js'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, { warn() {} });store.load()
  const actions = new Actions(store, { deliver() {} })
  const { projectId } = actions.createProject({ name: '记忆出处' })
  return { store, actions, project: store.get(projectId) }
}

test('memory evidence must exist in this project before the write is appended', t => {
  const { actions, project } = setup(t)
  actions.writeMemory(project, MIRA, { now: [{ text: '原有工作', evidence_seq: [1] }] })
  const before = project.seq
  assert.throws(() => actions.writeMemory(project, MIRA, { now: [{ text: '不存在的工作', evidence_seq: [999] }] }), /不存在/)
  assert.equal(project.seq, before)
  assert.deepEqual(project.memory.now.map(item => item.text), ['原有工作'])
  assert.throws(() => actions.writeMemory(project, MIRA, { now: [], facts: [{ text: '后续栏无效', evidence_seq: [999] }] }), /不存在/)
  assert.equal(project.seq, before)
  assert.deepEqual(project.memory.now.map(item => item.text), ['原有工作'], 'the entire invalid write is rejected, preserving existing sections')
})

test('acceptance state alone cannot establish a new long-term preference or project fact', t => {
  const { actions, project } = setup(t)
  const { threadId } = actions.openThread(project, { title: '交付', brief: '确定内容', assignee: '工程师' })
  actions.updateCard(project, workerKey(threadId), { state: 'review_ready' })
  actions.ownerUpdateThread({ projectId: project.id, threadId, state: 'done' })
  const stateSeq = project.seq
  assert.throws(() => actions.writeMemory(project, MIRA, { facts: [{ text: '关单通报只说一句，不列其他事项', evidence_seq: [stateSeq] }] }), /长期事实.*状态/)
  assert.equal(project.memory.facts.length, 0)
  assert.equal(project.seq, stateSeq)
})

test('an explicit owner preference remains valid when ordinary state changes and loop cleanup follow', t => {
  const { actions, project, store } = setup(t)
  const { messageId } = actions.ownerPost({ projectId: project.id, text: '以后回复只给结论。' })
  const said = project.messages.get(messageId).seq
  actions.writeMemory(project, MIRA, { facts: [{ text: '用户喜欢直接给结论', evidence_seq: [said] }] })
  actions.writeMemory(project, MIRA, { now: [], open_loops: [] })
  const reloaded = new ProjectStore(store.root, { warn() {} });reloaded.load()
  assert.deepEqual(reloaded.get(project.id).memory.facts.map(f => f.text), ['用户喜欢直接给结论'])
})

test('unchanged legacy memory does not block unrelated cleanup but cannot supply a new invalid citation', t => {
  const { actions, project, store } = setup(t)
  store.append(project.id, { type: 'memory.updated', memory: { now: [], decisions: [], openLoops: [], facts: [{ text: '旧版本留下的条目', evidence: [999] }] } })
  actions.writeMemory(project, MIRA, { now: [], open_loops: [] })
  assert.equal(project.memory.facts[0].text, '旧版本留下的条目')
  assert.throws(() => actions.writeMemory(project, MIRA, { facts: [{ text: '旧版本留下的条目', evidence_seq: [998] }] }), /不存在/)
})
