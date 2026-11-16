import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore } from '../lib/store.js'
import { ensureHub, HUB_ID } from '../lib/hub.js'
import { NextSteps, checkSuggestions, NEXT_STEPS_SYSTEM, VIA } from '../lib/next-steps.js'

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime()

function setup(t, { reply, now = at(17, 14) } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mira-next-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const hubStore = new ProjectStore(root, { warn() {} }); hubStore.load(); ensureHub(hubStore)
  const said = (seq, when, text, threadId = null) => ({ seq, type: 'message.posted', messageId: 'm' + seq, threadId, author: { kind: 'human', id: 'owner' }, trust: 'principal', text, native: true, at: when })
  const project = { id: 'p_1', name: '用户访谈整理', hub: false, seq: 3,
    events: [said(1, at(17, 10), '画像报告明天要给李雷看'), { seq: 2, type: 'thread.updated', threadId: 't_a', at: at(17, 11) }, { seq: 3, type: 'thread.updated', threadId: 't_b', at: at(17, 12) }],
    threads: new Map([
      ['t_a', { id: 't_a', title: '三步核对数据', state: 'review_ready', resolved: false, updatedAt: at(17, 11), summary: '复核完' }],
      ['t_b', { id: 't_b', title: '补 11-06 之后的数据', state: 'working', resolved: false, updatedAt: at(17, 12), summary: '跑到一半' }],
    ]), decisions: new Map(), files: new Map() }
  const projects = { projects: new Map([['p_1', project]]) }
  let clock = now
  const calls = []
  const steps = new NextSteps({ hubStore, projects, now: () => clock, complete: async c => { calls.push(c); return typeof reply === 'function' ? reply(c, calls.length) : reply } })
  return { hubStore, steps, calls, set: v => { clock = v }, hub: () => hubStore.get(HUB_ID) }
}

const good = { title: '李雷明天看画像报告，补数据还差一半', body: '你上午说明天给李雷看，补数据的任务还在跑。', ask: '把「补 11-06 之后的数据」推进到能放进明天给李雷的画像报告：先看任务现在跑到哪，再列出还差的几天和预计时间；交付一段进度说明；做完的标准是我知道明天来不来得及；要改报告范围时先问我。', refs: ['t2', 'w1'] }

test('the look-over runs in the day, when something changed, at most every half hour, never at night', t => {
  const f = setup(t, { reply: '{}' })
  assert.equal(f.steps.due().ok, true)
  f.set(at(17, 3)); assert.equal(f.steps.due().why, '夜里交给做梦')
  f.hubStore.append(HUB_ID, { type: 'nextsteps.ran', rules: 1, fingerprint: f.steps.fingerprint(), added: 0, dropped: 0, at: at(17, 14) })
  f.set(at(17, 14, 10)); assert.equal(f.steps.due().why, '还没到时间')
  f.set(at(17, 15)); assert.equal(f.steps.due().why, '没有新动静', 'nothing new since the last look: no model call')
  f.hubStore.append(HUB_ID, { type: 'observation.device', at: at(17, 14, 20) })
  assert.equal(f.steps.due().why, '没有新动静', 'a device heartbeat is not news')
  f.hubStore.append(HUB_ID, { type: 'feishu.attention', conversation: 'oc_1', at: at(17, 14, 30) })
  assert.equal(f.steps.due().ok, true, 'a Feishu message is')
  f.steps.everyMs = 0; assert.equal(f.steps.due().why, '关闭了')
})

test('the material marks what the board already shows, and its prompt carries the owner\'s own ranking', t => {
  const f = setup(t, { reply: '{}' })
  const m = f.steps.material()
  assert.match(m.text, /三步核对数据｜做完了待验收（已在看板上）/)
  assert.match(m.text, /补 11-06 之后的数据｜进行中｜/)
  assert.match(m.text, /\[w1\] .*画像报告明天要给李雷看/)
  assert.equal(m.items.get('t1').onBoard, true)
  assert.equal(m.items.get('t2').ref, 'p_1#3')
  assert.match(NEXT_STEPS_SYSTEM, /他可能漏掉的最优先/)
  const msg = (text, chat = 'oc_2', important = true) => f.hubStore.append(HUB_ID, { type: 'observation.accepted', source: 'lark', trust: 'external', app: '飞书', title: '发布群', correlationId: chat, text, important, occurredAt: at(17, 13) })
  msg('陈工：图修了吗'); msg('陈工：图修了吗'); msg('林一（我）：好的'); msg('Mira：[卡片]'); msg('章一智：![Image](img_1)')
  msg('路人：今天食堂不错', 'oc_chatter', false)
  const lines = f.steps.material().text.split('\n').filter(l => /^\[m\d+\]/.test(l))
  assert.equal(lines.length, 1, 'the owner\'s own line, a bare card, a bare picture, a repeat and chatter he never joined are left out')
  assert.match(lines[0], /陈工：图修了吗/)
  assert.match(NEXT_STEPS_SYSTEM, /先停下来问他/)
})

test('a suggestion is kept only when it cites material, adds something the board lacks, repeats nothing and leaks no ids', t => {
  const f = setup(t, { reply: '{}' })
  const m = f.steps.material()
  const r = checkSuggestions(JSON.stringify({ suggestions: [
    good,
    { ...good, title: '没有出处', refs: ['w99'] },
    { ...good, title: '验收三步核对', refs: ['t1'] },
    { ...good, title: '标题里有 t2 编号' },
    { ...good, title: '开着的卡' },
    { ...good, title: '放下的那条' },
    { ...good, title: '这个标题实在是太长了' + '太长了'.repeat(8) },
    { ...good, title: '太短的请求', ask: '帮我看看' },
    { ...good, title: '第二条也成立' },
    { ...good, title: '第三条超出这一轮' },
  ] }), { items: m.items, open: [{ title: '开着的卡' }], setAside: ['放下的那条'], room: 2 })
  assert.deepEqual(r.kept.map(s => s.title), [good.title, '第二条也成立'])
  assert.deepEqual(r.rejected.map(x => x.why), ['没有指向材料', '只说了看板上已有的事', '正文里写了材料编号', '和开着的或放下的建议重复', '和开着的或放下的建议重复', '标题为空或太长', 'ask 太短或太长', '超过这一轮的条数'])
})

test('one run leaves checked suggestions as cards with their whole request, and later withdraws only its own when they stop holding', async t => {
  let answer = JSON.stringify({ suggestions: [good], drop: [] })
  const f = setup(t, { reply: () => answer })
  const first = await f.steps.tick()
  assert.equal(first.added, 1)
  const card = f.hub().cardOrder.map(id => f.hub().cards.get(id)).find(c => c.via === VIA)
  assert.equal(card.ask, good.ask)
  assert.equal(card.target.projectId, 'p_1')
  assert.deepEqual(card.refs, ['p_1#3', 'p_1#1'])
  assert.match(f.calls[0].input, /你之前提过、还开着的建议/)
  // The assistant's own card, not this worker's: never withdrawn by it.
  f.hubStore.append(HUB_ID, { type: 'card.proposed', cardId: 'c_mira', kind: 'next_step', title: '别人的卡', body: '', target: { projectId: null }, refs: [], actions: [], by: { kind: 'assistant', id: 'mira' } })
  answer = JSON.stringify({ suggestions: [], drop: [{ id: 's1', reason: '你已经在做了' }, { id: 's2', reason: '也撤掉' }] })
  f.set(at(30, 14)); f.steps.everyMs = 1
  const ranFingerprint = f.hub().events.findLast(e => e.type === 'nextsteps.ran').fingerprint
  assert.notEqual(ranFingerprint, f.steps.fingerprint(), 'the assistant\'s own card is news')
  const second = await f.steps.tick()
  assert.equal(f.hub().events.findLast(e => e.type === 'nextsteps.ran').fingerprint, f.steps.fingerprint(), 'its own cards and run are not news to itself')
  assert.equal(second.dropped, 1)
  assert.equal(f.hub().cards.get(card.id).state, 'withdrawn')
  assert.equal(f.hub().cards.get('c_mira').state, 'open')
})

test('a model failure is logged and retried later, and a set-aside suggestion is not offered again', async t => {
  const f = setup(t, { reply: () => { throw new Error('网络断了') } })
  const r = await f.steps.tick()
  assert.equal(r.added, 0); assert.match(r.error, /网络断了/)
  assert.equal(f.steps.due().why, '上次失败，等重试')
  f.hubStore.append(HUB_ID, { type: 'card.proposed', cardId: 'c_old', kind: 'next_step', title: good.title, body: '', ask: good.ask, via: VIA, target: { projectId: null }, refs: [], actions: [], by: { kind: 'assistant', id: 'mira' } })
  f.hubStore.append(HUB_ID, { type: 'card.dismissed', cardId: 'c_old', by: { kind: 'human', id: 'owner' } })
  const m = f.steps.material()
  assert.deepEqual(m.setAside, [good.title])
  const again = checkSuggestions(JSON.stringify({ suggestions: [good] }), { items: m.items, open: m.open, setAside: m.setAside, room: 2 })
  assert.equal(again.kept.length, 0)
})
