// 技能自迭代: an executor's 做事说明 learns only from what the owner typed in a task after it was delivered. The night
// drafts a new text; code checks it cites at least three of those words; the owner chooses, and every version stays.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore, EXECUTOR_MEMBER } from '../lib/store.js'
import { ensureHub, HUB_ID } from '../lib/hub.js'
import { Dream, SKILL_SYSTEM, skillRecord } from '../lib/dream.js'

const OWNER = { kind: 'human', id: 'owner' }

function setup(t, replies = []) {
  const root = mkdtempSync(join(tmpdir(), 'mira-skills-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const hubStore = new ProjectStore(join(root, 'hub'), { warn() {} }); hubStore.load(); ensureHub(hubStore)
  const projects = new ProjectStore(join(root, 'projects'), { warn() {} }); projects.load()
  const p = projects.createProject({ name: '用户访谈整理', members: [EXECUTOR_MEMBER] }).projectId
  const calls = []
  const dream = new Dream({ hubStore, projects, complete: async c => { calls.push(c); const r = replies.shift(); return typeof r === 'string' ? r : JSON.stringify(r ?? { change: false, why: '没有' }) } })
  const task = title => { const id = projects.newThreadId(); projects.append(p, { type: 'thread.opened', threadId: id, title, assignee: EXECUTOR_MEMBER.id, by: OWNER }); return id }
  const deliver = id => projects.append(p, { type: 'thread.updated', threadId: id, patch: { state: 'review_ready' }, by: { kind: 'assistant', id: 'executor' } })
  const say = (id, text) => projects.append(p, { type: 'message.posted', messageId: projects.newMessageId(), threadId: id, author: OWNER, trust: 'principal', text, mentions: [], to: [], native: true })
  const member = () => projects.get(p).members.find(m => m.id === EXECUTOR_MEMBER.id)
  return { hubStore, projects, p, dream, calls, task, deliver, say, member }
}

test('only words typed after a delivery count as feedback, and the night asks only once there are three new ones', async t => {
  const f = setup(t)
  const a = f.task('写说明'), b = f.task('写报告')
  f.say(a, '先写这个')                       // before any delivery: an instruction, not feedback
  f.deliver(a); f.say(a, '开头别写「写好了」'); f.say(a, '数字太长了')
  f.deliver(b)
  let r = skillRecord(f.hubStore.get(HUB_ID), f.projects.get(f.p), f.member())
  assert.equal(r.uses, 2); assert.equal(r.rework, 2); assert.equal(r.version, 1)
  assert.deepEqual(await f.dream.proposeSkills(), [], 'two are not enough')
  f.say(b, '又是一大段统计')
  await f.dream.proposeSkills()
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].system, SKILL_SYSTEM)
  assert.ok(f.calls[0].input.includes('[s3]') && !f.calls[0].input.includes('先写这个'))
  assert.ok(f.hubStore.get(HUB_ID).events.some(e => e.type === 'skill.considered'), 'a "no change" answer is recorded')
})

test('a draft must cite three real feedback words, change the text and stay a sensible size', async t => {
  const draft = after => ({ change: true, persona: after, why: '开头只写文件名', refs: ['s1', 's2', 's3'] })
  const f = setup(t, [{ ...draft('第一行只写交付的文件名。'), refs: ['s1', 's2', 's9'] }, draft(EXECUTOR_MEMBER.persona), draft('长'.repeat(5000)), draft('第一行只写交付的文件名，统计放进文件卡。')])
  const a = f.task('写说明'); f.deliver(a); f.say(a, '开头别写写好了'); f.say(a, '数字太长'); f.say(a, '又写了写好了')
  const notes = []
  for (let i = 0; i < 4; i++) notes.push(...await f.dream.proposeSkills())
  assert.match(notes[0], /引用的反馈不到 3 条/)
  assert.match(notes[1], /和原来一样/)
  assert.match(notes[2], /超过 4000 字|长太多/)
  assert.match(notes[3], /起草了新版/)
  const proposal = f.hubStore.get(HUB_ID).events.find(e => e.type === 'skill.proposed')
  assert.equal(proposal.refs.length, 3); assert.equal(proposal.before, EXECUTOR_MEMBER.persona)
  assert.deepEqual(await f.dream.proposeSkills(), [], 'one open draft per executor')
})

test('用新版 puts the text in place, every version stays, and the owner can go back; a stale draft is refused', async t => {
  const f = setup(t, [{ change: true, persona: '第一行只写交付的文件名。', why: '开头只写文件名', refs: ['s1', 's2', 's3'] }])
  const a = f.task('写说明'); f.deliver(a); f.say(a, '一'); f.say(a, '二'); f.say(a, '三')
  await f.dream.proposeSkills()
  const id = f.hubStore.get(HUB_ID).events.find(e => e.type === 'skill.proposed').id
  assert.throws(() => f.dream.decideSkill({ id, choice: 'maybe' }), /不认识/)
  f.dream.decideSkill({ id, choice: 'apply' })
  assert.equal(f.member().persona, '第一行只写交付的文件名。')
  assert.throws(() => f.dream.decideSkill({ id, choice: 'apply' }), /处理过/)
  let s = f.dream.skills()[0]
  assert.equal(s.version, 2); assert.equal(s.versions[0].persona, EXECUTOR_MEMBER.persona); assert.equal(s.proposal, null)
  f.dream.settleSkill({ projectId: f.p, memberId: EXECUTOR_MEMBER.id, version: 1 })
  assert.equal(f.member().persona, EXECUTOR_MEMBER.persona)
  s = f.dream.skills()[0]
  assert.equal(s.version, 3); assert.match(s.versions[2].why, /退回到第 1 版/)
  // A replay of the log gives the same text.
  const again = new ProjectStore(f.projects.root, { warn() {} }); again.load()
  assert.equal(again.get(f.p).members.find(m => m.id === EXECUTOR_MEMBER.id).persona, EXECUTOR_MEMBER.persona)
})

test('先试一次 can be kept or sent back, and a draft written before someone changed the text is void', async t => {
  const f = setup(t, [{ change: true, persona: '新的说明。', why: '试试', refs: ['s1', 's2', 's3'] }, { change: true, persona: '另一版。', why: '再试', refs: ['s1', 's2', 's3'] }])
  const a = f.task('写说明'); f.deliver(a); f.say(a, '一'); f.say(a, '二'); f.say(a, '三')
  await f.dream.proposeSkills()
  const first = f.hubStore.get(HUB_ID).events.find(e => e.type === 'skill.proposed').id
  f.dream.decideSkill({ id: first, choice: 'trial' })
  assert.equal(f.dream.skills()[0].trial.proposalId, first)
  f.dream.settleSkill({ projectId: f.p, memberId: EXECUTOR_MEMBER.id })
  assert.equal(f.member().persona, EXECUTOR_MEMBER.persona, '退回 puts the previous text back')
  assert.equal(f.dream.skills()[0].trial, null)
  f.say(a, '四'); f.say(a, '五'); f.say(a, '六')
  await f.dream.proposeSkills()
  const second = f.hubStore.get(HUB_ID).events.filter(e => e.type === 'skill.proposed').at(-1).id
  f.projects.append(f.p, { type: 'member.persona', memberId: EXECUTOR_MEMBER.id, before: EXECUTOR_MEMBER.persona, persona: '有人手改了。', by: OWNER })
  assert.throws(() => f.dream.decideSkill({ id: second, choice: 'apply' }), /作废/)
})

test('the before/after view splits a 做事说明 into sentences and shows only what went and what came', async () => {
  const { readFileSync } = await import('node:fs'), { runInNewContext } = await import('node:vm')
  let client
  runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load(d) { client = d.factory(() => ({})) } } } })
  const d = client.skillDiff('接手一件任务。开头写「写好了」。要拍板时问他。', '接手一件任务。第一行只写文件名。要拍板时问他。')
  assert.deepEqual([...d.gone], ['开头写「写好了」。']); assert.deepEqual([...d.came], ['第一行只写文件名。']); assert.equal(d.kept, 2)
})
