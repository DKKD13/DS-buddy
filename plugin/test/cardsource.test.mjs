import test from 'node:test'
import assert from 'node:assert/strict'
import { cardSource } from '../lib/today.js'

const hub = { events: [
  { seq: 1, type: 'observation.accepted', source: 'lark', app: '飞书', title: '单聊' },
  { seq: 2, type: 'pc.activity', deviceName: '我的 Mac' },
  { seq: 3, type: 'feishu.attention', title: '发布群' },
  { seq: 4, type: 'message.posted' },
] }

test('a board card shows the source of the event it cites, never one guessed from its wording', () => {
  assert.deepEqual(cardSource({ refs: ['hub#1'] }, hub), { app: '飞书', where: '单聊' })
  assert.deepEqual(cardSource({ refs: ['hub#2', 'hub#1'] }, hub), { app: '电脑', where: '我的 Mac' }, 'the first cited event that names a source wins')
  assert.deepEqual(cardSource({ refs: ['hub#3'] }, hub), { app: '飞书', where: '发布群' })
  assert.deepEqual(cardSource({ refs: ['p_x#3', 'hub#4', 'hub#99', 'hub#4'] }, hub), null, 'project refs, chat messages and missing events name no source')
  assert.equal(cardSource({ title: '飞书里有人找你', refs: [] }, hub), null, 'the wording alone is not evidence')
})
