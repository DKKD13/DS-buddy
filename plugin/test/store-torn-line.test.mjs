import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../lib/store.js'
import { ensureHub } from '../lib/hub.js'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-torn-'));t.after(() => rmSync(root, { recursive: true, force: true }))
  const warnings = []
  const open = () => { const store = new ProjectStore(root, { warn: text => warnings.push(String(text)) });store.load();return store }
  const store = open();ensureHub(store)
  return { file: join(root, 'hub', 'events.jsonl'), store, open, warnings }
}
const mark = (store, messageId) => store.append('hub', { type: 'attention.mode', mode: 'observe', by: 'mira', messageId })
const marks = store => store.get('hub').events.filter(e => e.type === 'attention.mode').map(e => e.messageId)
const blankLines = file => readFileSync(file, 'utf8').split('\n').slice(0, -1).filter(line => line === '').length

test('a log whose last line broke off (full disk, crash): the event written next is not lost with it', t => {
  const f = setup(t)
  const before = mark(f.store, 'before')
  // What a write that ran out of disk leaves behind: the start of a line, no end.
  appendFileSync(f.file, '{"seq":99,"at":1,"projectId":"hub","type":"attention.mo')
  const again = f.open()
  assert.deepEqual(marks(again), ['before'], 'the broken line is skipped')
  assert.ok(f.warnings.some(text => text.includes('malformed')), 'and reported')
  const after = mark(again, 'after')
  assert.equal(after.seq, before.seq + 1, 'numbering carries on from the last whole event')
  assert.deepEqual(marks(f.open()), ['before', 'after'], 'the next event is read back')
  mark(again, 'third')
  assert.deepEqual(marks(f.open()), ['before', 'after', 'third'])
  assert.equal(blankLines(f.file), 0, 'the new line is added once, not before every event')
})

test('a write that fails while running: the event after it still gets its own line', t => {
  const f = setup(t)
  mark(f.store, 'before')
  chmodSync(f.file, 0o444)
  assert.throws(() => mark(f.store, 'lost'))
  chmodSync(f.file, 0o644)
  // The part of the failed write that did reach the disk.
  appendFileSync(f.file, '{"seq":3,"at":1,"proj')
  mark(f.store, 'after')
  assert.deepEqual(marks(f.store), ['before', 'after'], 'the failed event never counted')
  assert.deepEqual(marks(f.open()), ['before', 'after'])
})

test('a healthy log is written as before: one event per line, no blank lines', t => {
  const f = setup(t)
  mark(f.store, 'a');mark(f.store, 'b')
  const again = f.open();mark(again, 'c')
  assert.equal(blankLines(f.file), 0)
  assert.deepEqual(marks(f.open()), ['a', 'b', 'c'])
})
