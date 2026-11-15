import test from 'node:test'
import assert from 'node:assert/strict'
import { FeishuAttention, attentionMode, attentionWokeToday } from '../lib/attention.js'

test('the owner sets the reminder level from the page; only the three known levels are accepted', () => {
  const hub = { events: [] }
  const hubStore = { get: () => hub, append: (_id, event) => { hub.events.push(event) } }
  const attention = new FeishuAttention({ hubStore, request() {} })
  assert.deepEqual(attention.setMode('auto'), { mode: 'auto' })
  assert.equal(attentionMode(hub), 'auto')
  assert.equal(hub.events.at(-1).by, 'owner')
  assert.deepEqual(attention.setMode('off'), { mode: 'off' })
  assert.equal(attentionMode(hub), 'off')
  assert.throws(() => attention.setMode('loud'), /档位/)
  assert.throws(() => attention.setMode(undefined), /档位/)
  assert.equal(attentionMode(hub), 'off')
  assert.throws(() => new FeishuAttention({ hubStore: { get: () => undefined, append() {} }, request() {} }).setMode('auto'), /还没有启用/)
})

test('"woken today" counts only reminders that really woke the assistant since local midnight', () => {
  const now = new Date(2026, 10, 10, 15, 0, 0).getTime()
  const today = new Date(2026, 10, 10, 9, 0, 0).getTime(), yesterday = new Date(2026, 10, 9, 23, 0, 0).getTime()
  const hub = { events: [
    { type: 'feishu.attention', woke: true, raisedAt: today },
    { type: 'feishu.attention', woke: true, raisedAt: today + 60_000 },
    { type: 'feishu.attention', woke: false, raisedAt: today },
    { type: 'feishu.attention', woke: true, raisedAt: yesterday },
    { type: 'feishu.attention.observed', woke: true, raisedAt: today },
  ] }
  assert.equal(attentionWokeToday(hub, now), 2)
  assert.equal(attentionWokeToday({ events: [] }, now), 0)
})
