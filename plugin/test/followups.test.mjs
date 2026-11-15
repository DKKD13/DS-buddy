import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../lib/store.js'
import { ensureHub } from '../lib/hub.js'
import { Followups, owedReplies, parseJudgment, FOLLOWUP_RULES } from '../lib/followups.js'
import { buildDay, renderDay } from '../lib/today.js'

process.env.TZ = 'Asia/Shanghai'
const T0 = Date.parse('2026-11-07T09:00:00+08:00'), MIN = 60_000
const DM = 'lark-chat.oc_dm', GROUP = 'lark-chat.oc_group'

// A stand-in model that says a reply is owed on every message marked as waiting.
const waitingRefs = input => [...input.matchAll(/\[(hub#\d+)\][^\n]*（待回）/g)].map(m => m[1])
function setup(t, answer = input => JSON.stringify({ needsReply: true, ask: '确认明天部署的时间', refs: waitingRefs(input) })) {
  const root = mkdtempSync(join(tmpdir(), 'mira-followups-'));t.after(() => rmSync(root, { recursive: true, force: true }))
  const hubStore = new ProjectStore(join(root, 'hub'), { warn() {} });hubStore.load();ensureHub(hubStore)
  const projects = new ProjectStore(join(root, 'projects'), { warn() {} });projects.load()
  const clock = { now: T0 }, calls = []
  const reply = { answer }
  const followups = new Followups({ hubStore, now: () => clock.now, logger: { warn() {} },
    complete: async ({ system, input }) => { calls.push({ system, input });return reply.answer(input) } })
  // A Feishu observation as the device entrance stores it.
  let n = 0
  const say = ({ at, text, chat = DM, title = '单聊', me = false, toMe = !me, id = 'om_' + ++n }) => hubStore.append('hub', {
    type: 'observation.accepted', eventId: `lark:${id}:${at}${me ? ':me' : ''}`, source: 'lark', occurredAt: at, app: '飞书', title, text,
    correlationId: chat, important: toMe, deviceId: 'mac-1', deviceName: '我的 Mac', trust: 'external', receivedAt: at })
  return { hubStore, projects, clock, calls, reply, followups, say, hub: () => hubStore.get('hub') }
}

test('a direct message the owner has left unanswered for half an hour is judged once, listed with who asked what, and drops off once they write back', async t => {
  const f = setup(t)
  const ask = f.say({ at: T0, text: '张三：明天的部署你几点方便？' })
  f.reply.answer = () => `好的。{"needsReply":true,"ask":"确认明天部署的时间","refs":["hub#${ask.seq}","hub#99999"]}`
  f.clock.now = T0 + 10 * MIN
  await f.followups.tick()
  assert.equal(f.calls.length, 0, 'the owner gets half an hour first')
  f.clock.now = T0 + 31 * MIN
  await f.followups.tick()
  assert.equal(f.calls.length, 1)
  assert.match(f.calls[0].input, new RegExp(`\\[hub#${ask.seq}\\] 11-07 09:00 张三：明天的部署你几点方便？（待回）`))
  assert.match(f.calls[0].system, /JSON/)
  const judged = f.hub().events.filter(e => e.type === 'followup.judged')
  assert.deepEqual(judged.map(e => [e.conversation, e.needsReply, e.refs, e.rules]), [[DM, true, [`hub#${ask.seq}`], FOLLOWUP_RULES]], 'a ref outside the waiting messages is dropped')
  assert.deepEqual(owedReplies(f.hub(), f.clock.now), [{ conversation: DM, title: '单聊', who: '张三', ask: '确认明天部署的时间', text: '明天的部署你几点方便？',
    since: T0, at: T0, count: 1, ref: `hub#${ask.seq}`, refs: [`hub#${ask.seq}`], through: ask.seq }])
  await f.followups.tick()
  assert.equal(f.calls.length, 1, 'judged once')
  // The owner writes in that conversation: nothing is owed any more.
  f.say({ at: T0 + 40 * MIN, text: '林一（我）：下午三点吧', me: true })
  f.clock.now = T0 + 41 * MIN
  assert.deepEqual(owedReplies(f.hub(), f.clock.now), [])
  await f.followups.tick()
  assert.equal(f.calls.length, 1)
})

test('only messages marked as addressed to the owner wait for them, an edited message counts once, and group chatter is context', async t => {
  const f = setup(t)
  f.say({ at: T0, chat: GROUP, title: '达标讨论群', text: '李四：大家看下新字段', toMe: false })
  f.say({ at: T0 + MIN, chat: GROUP, title: '达标讨论群', text: '李四：@林一 字段表你能今天定吗', id: 'om_at' })
  f.say({ at: T0 + 2 * MIN, chat: GROUP, title: '达标讨论群', text: '李四：@林一 字段表你能今天定下来吗', id: 'om_at' })
  f.say({ at: T0 + 3 * MIN, chat: 'lark-chat.oc_other', title: '灌水群', text: '王五：午饭吃啥', toMe: false })
  f.clock.now = T0 + 40 * MIN
  await f.followups.tick()
  assert.equal(f.calls.length, 1, 'one conversation waits: the group where the owner was @-ed')
  assert.match(f.calls[0].input, /会话：达标讨论群/)
  assert.match(f.calls[0].input, /李四：大家看下新字段\n/, 'what was said around it is there as context, unmarked')
  assert.equal((f.calls[0].input.match(/（待回）/g) || []).length, 1, 'the edit replaced its first version')
  const [item] = owedReplies(f.hub(), f.clock.now)
  assert.deepEqual([item.who, item.title, item.text, item.count], ['李四', '达标讨论群', '@林一 字段表你能今天定下来吗', 1])
})

test('the model says whether anything is asked: a thank-you is not listed, and a new message in that conversation is judged again', async t => {
  const f = setup(t, () => '{"needsReply":false,"ask":"","refs":[]}')
  f.say({ at: T0, text: '张三：谢谢！' })
  f.clock.now = T0 + 31 * MIN
  await f.followups.tick();await f.followups.tick()
  assert.equal(f.calls.length, 1)
  assert.deepEqual(owedReplies(f.hub(), f.clock.now), [])
  const later = f.say({ at: T0 + 35 * MIN, text: '张三：对了，那个 PR 你能帮我看下吗' })
  f.reply.answer = () => `{"needsReply":true,"ask":"帮他看 PR","refs":["hub#${later.seq}"]}`
  f.clock.now = T0 + 70 * MIN
  await f.followups.tick()
  assert.equal(f.calls.length, 2)
  assert.equal((f.calls[1].input.match(/（待回）/g) || []).length, 2, 'both unanswered messages are in front of the model')
  const [item] = owedReplies(f.hub(), f.clock.now)
  assert.deepEqual([item.ask, item.count, item.since, item.text], ['帮他看 PR', 2, T0, '对了，那个 PR 你能帮我看下吗'])
})

test('an answer without a waiting message behind it, a malformed answer and a failing call list nothing; failures back off and stop', async t => {
  assert.throws(() => parseJudgment('我觉得要回', []), /JSON/)
  assert.throws(() => parseJudgment('{"ask":"x"}', []), /needsReply/)
  const f = setup(t, () => '{"needsReply":true,"ask":"回一下","refs":["hub#1"]}')
  f.say({ at: T0, text: '张三：在吗' })
  f.clock.now = T0 + 31 * MIN
  await f.followups.tick()
  assert.deepEqual(f.hub().events.filter(e => e.type === 'followup.judged').map(e => e.needsReply), [false], 'no evidence named, nothing owed')
  assert.deepEqual(owedReplies(f.hub(), f.clock.now), [])
  // Another conversation whose calls fail.
  f.say({ at: T0 + MIN, chat: 'lark-chat.oc_fail', text: '王五：周报发我一下' })
  f.reply.answer = () => { throw Error('timeout') }
  for (let i = 0; i < 7; i++) { f.clock.now += 6 * MIN;await f.followups.tick() }
  assert.equal(f.calls.filter(c => c.input.includes('周报')).length, 5, 'five tries, five minutes apart, then it stops')
})

test('ignoring a conversation hides it until someone writes to the owner there again; two-day-old messages are not chased', async t => {
  const f = setup(t)
  const first = f.say({ at: T0, text: '张三：方案你看了吗' })
  f.clock.now = T0 + 31 * MIN
  await f.followups.tick()
  assert.equal(owedReplies(f.hub(), f.clock.now).length, 1)
  assert.throws(() => f.followups.dismiss({ conversation: 'oc_dm; rm -rf', through: first.seq }), /会话/)
  assert.throws(() => f.followups.dismiss({ conversation: DM, through: 10 ** 9 }), /范围/)
  f.followups.dismiss({ conversation: DM, through: first.seq })
  f.followups.dismiss({ conversation: DM, through: first.seq })
  assert.equal(f.hub().events.filter(e => e.type === 'followup.dismissed').length, 1, 'ignoring twice is one record')
  assert.deepEqual(owedReplies(f.hub(), f.clock.now), [])
  const second = f.say({ at: T0 + 50 * MIN, text: '张三：今天能给反馈吗？' })
  f.reply.answer = () => `{"needsReply":true,"ask":"今天给方案反馈","refs":["hub#${second.seq}"]}`
  f.clock.now = T0 + 90 * MIN
  await f.followups.tick()
  assert.deepEqual(owedReplies(f.hub(), f.clock.now).map(i => i.ask), ['今天给方案反馈'])
  // A message from three days ago is past being a reminder: never sent to the model.
  f.say({ at: T0 - 72 * 3600_000, chat: 'lark-chat.oc_old', text: '王五：上周那个表呢' })
  const before = f.calls.length
  await f.followups.tick()
  assert.equal(f.calls.length, before)
})

test('the day view carries what waits for a reply, and Mira\'s day text names it with its ref', async t => {
  const f = setup(t)
  const ask = f.say({ at: T0, text: '张三：明天的部署你几点方便？' })
  f.reply.answer = () => `{"needsReply":true,"ask":"确认明天部署的时间","refs":["hub#${ask.seq}"]}`
  f.clock.now = T0 + 31 * MIN
  await f.followups.tick()
  const view = buildDay(f.projects, f.hub(), { now: f.clock.now })
  assert.deepEqual(view.followups.map(i => [i.who, i.ask]), [['张三', '确认明天部署的时间']])
  const text = renderDay(view)
  assert.match(text, /## 可能要你回复的飞书消息/)
  assert.match(text, new RegExp(`- \\[hub#${ask.seq}\\] 张三 · 单聊：确认明天部署的时间（等了 31 分钟）原话「明天的部署你几点方便？」`))
  assert.deepEqual(buildDay(f.projects, f.hub(), { day: '2026-11-06', now: f.clock.now }).followups, [], 'a past day has no reminders')
})
