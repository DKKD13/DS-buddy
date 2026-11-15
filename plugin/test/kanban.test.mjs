import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let client
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => ({})) } } },
})

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime()
const never = () => false
const dream = { latest: { day: '2026-11-14', startedAt: at(14, 2, 10), line: '早。昨晚我替你看了两件事。', picked: [{ lane: 'do', title: '补数据', body: '四步。', refs: [] }, { lane: 'read', title: '看说明', body: '没打开。', refs: [] }] } }


test('today\'s dream picks show at the top of 待你决定, and the source says when the night started and how many were kept', () => {
  const say = client.kanbanLine({ dream, now: at(14, 9, 30), hidden: never })
  assert.equal(say.key, 'dream:2026-11-14')
  assert.equal(say.dream.picked.length, 2)
  assert.match(say.why, /02:10 开始，留下 2 件/)
  assert.ok(client.kanbanLine({ dream, now: at(14, 15), hidden: never }), 'still there in the afternoon')
})

test('nothing of her own otherwise: no dream, an old dream, or 收起 for the day; waiting items are only in the list below', () => {
  assert.equal(client.kanbanLine({ dream: null, now: at(14, 9, 30), hidden: never }), null)
  assert.equal(client.kanbanLine({ dream, now: at(15, 9, 30), hidden: never }), null, 'yesterday\'s dream is not today\'s')
  assert.equal(client.kanbanLine({ dream, now: at(14, 9, 30), hidden: key => key === 'dream:2026-11-14' }), null)
  assert.equal(client.kanbanLine({ dream: { latest: { ...dream.latest, picked: [] } }, now: at(14, 9, 30), hidden: never }), null)
})
