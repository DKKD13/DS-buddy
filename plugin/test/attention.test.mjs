import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, MIRA } from '../lib/store.js'
import { ensureHub, renderHubItem } from '../lib/hub.js'
import { FeishuAttention, attentionMode, ATTENTION_DAILY_WAKES } from '../lib/attention.js'

process.env.TZ = 'Asia/Shanghai'
const T0 = Date.parse('2026-11-07T10:00:00+08:00'), MIN = 60_000

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-attention-'));t.after(() => rmSync(root, { recursive: true, force: true }))
  const hubStore = new ProjectStore(join(root, 'hub'), { warn() {} });hubStore.load();ensureHub(hubStore)
  const clock = { now: T0 }, wakes = [], owed = { list: [] }
  const attention = new FeishuAttention({ hubStore, now: () => clock.now, request: reason => wakes.push(reason), owed: () => owed.list })
  const item = (conversation, through, extra = {}) => ({ conversation, through, title: '单聊', who: '张三', ask: '确认部署时间', text: '明天几点部署？', since: T0 - 40 * MIN, at: T0 - 40 * MIN, count: 1, ref: 'hub#7', refs: ['hub#7'], ...extra })
  const of = type => hubStore.get('hub').events.filter(e => e.type === type)
  return { hubStore, clock, wakes, owed, attention, item, of }
}
const setMode = (hubStore, mode) => hubStore.append('hub', { type: 'attention.mode', mode, by: 'mira', messageId: 'latest' })

test('by default Mira only observes: what she would raise is recorded, nothing reaches her or wakes her', t => {
  const f = setup(t)
  assert.equal(attentionMode(f.hubStore.get('hub')), 'observe')
  f.owed.list = [f.item('lark-chat.a', 7)]
  f.attention.tick();f.attention.tick()
  assert.equal(f.of('feishu.attention.observed').length, 1, 'recorded once')
  assert.equal(f.of('feishu.attention').length, 0)
  assert.deepEqual(f.wakes, [])
  assert.equal(f.hubStore.unread(f.hubStore.get('hub'), MIRA).some(e => e.type.startsWith('feishu.')), false)
})

test("in auto mode a new owed reply reaches Mira's inbox and wakes her once; new messages in that chat raise it again", t => {
  const f = setup(t);setMode(f.hubStore, 'auto')
  f.owed.list = [f.item('lark-chat.a', 7), f.item('lark-chat.b', 9, { who: '李四' })]
  f.attention.tick()
  assert.equal(f.of('feishu.attention').length, 2)
  assert.deepEqual(f.wakes, ['attention'], 'one wake for the batch')
  f.attention.tick()
  assert.deepEqual(f.wakes, ['attention'], 'nothing new, no wake')
  f.owed.list = [f.item('lark-chat.a', 12)]
  f.attention.tick()
  assert.equal(f.of('feishu.attention').length, 3);assert.equal(f.wakes.length, 2)
  const unread = f.hubStore.unread(f.hubStore.get('hub'), MIRA).filter(e => e.type === 'feishu.attention')
  assert.equal(unread.length, 3)
  const rendered = renderHubItem(f.hubStore.get('hub'), unread[0])
  assert.match(rendered, /kind="feishu_attention"/);assert.match(rendered, /张三/);assert.match(rendered, /trust="external"/)
})

test('quiet hours and the daily cap hold the wake but still hand the item to Mira for her next turn', t => {
  const f = setup(t);setMode(f.hubStore, 'auto')
  f.clock.now = Date.parse('2026-11-07T23:30:00+08:00')
  f.owed.list = [f.item('lark-chat.night', 3)]
  f.attention.tick()
  assert.equal(f.of('feishu.attention').length, 1);assert.deepEqual(f.wakes, [])
  f.clock.now = T0
  for (let i = 0; i < ATTENTION_DAILY_WAKES + 2; i++) { f.owed.list = [f.item('lark-chat.c' + i, i + 100)];f.attention.tick() }
  assert.equal(f.wakes.length, ATTENTION_DAILY_WAKES)
})

test('off records nothing', t => {
  const f = setup(t);setMode(f.hubStore, 'off')
  f.owed.list = [f.item('lark-chat.a', 7)]
  f.attention.tick()
  assert.equal(f.of('feishu.attention').length + f.of('feishu.attention.observed').length, 0)
})
