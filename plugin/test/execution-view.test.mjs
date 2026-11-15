import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let client
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => ({})) } } },
})
const event = (type, data, seq = 1) => ({ type: 'event', event: { type, data, seq, time: 1000 } })
const content = text => [{ type: 'text', text }]

test('execution view distinguishes admitted input, output and tool evidence without inventing live history', () => {
  const rows = client.executionRows([
    event('user/message', { content: content('notification: 2 unread') }, 1),
    event('tool/call', { name: 'inbox_read', arguments: '{"limit":2}' }, 2),
    event('tool/result', { message: { content: content('actual inbox content') } }, 3),
    event('assistant/message', { message: { content: [...content('visible answer'), { type: 'reasoning', text: 'private reasoning' }] } }, 4),
    event('request/header', { headers: { Authorization: 'header-private' } }, 5),
    { type: 'transient', event: { type: 'assistant/live-chunk', data: { text: 'not settled' } } },
  ])
  assert.equal(rows.length, 4)
  assert.equal(rows[0].label, '会话收到的输入')
  assert.equal(rows[2].text, 'actual inbox content')
  assert.equal(rows[3].text, 'visible answer')
  assert.doesNotMatch(JSON.stringify(rows), /private reasoning|header-private|not settled/)
})

test('execution view excludes tool-private meta and masks credential fields', () => {
  const rows = client.executionRows([
    event('tool/call', { name: 'fetch', arguments: JSON.stringify({ path: 'notes.md', apiKey: 'fixture-key', nested: { token: 'fixture-token' }, headers: { Authorization: 'fixture-header' } }) }),
    event('tool/result', { message: { content: content('Authorization: Bearer fixture-bearer') }, meta: { private: 'fixture-meta' } }),
  ])
  assert.match(rows[0].code, /notes.md/)
  assert.doesNotMatch(JSON.stringify(rows), /fixture-key|fixture-token|fixture-header|fixture-bearer|fixture-meta/)
})
