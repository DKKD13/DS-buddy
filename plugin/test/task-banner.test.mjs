import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let client
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => ({})) } } },
})

const project = { id: 'p_1', files: [
  { id: 'f_1', path: 'docs/说明.md', by: { kind: 'assistant', threadId: 't_1' } },
  { id: 'f_2', path: 'docs/别的.md', by: { kind: 'assistant', threadId: 't_2' } },
  { id: 'f_3', path: 'notes.md', by: { kind: 'human', id: 'owner' } },
] }
const at = new Date(2026, 10, 13, 16, 21).getTime()
// The client runs in its own context, so its arrays are copied into this one before a deep comparison.
const banner = (...args) => [...client.bannerOf(...args)]

test('a task\'s delivered files are the shared files it published itself, and sizes read in B, KB, MB', () => {
  assert.deepEqual(client.deliveredFiles(project, { id: 't_1' }).map(f => f.id), ['f_1'])
  assert.equal(client.deliveredFiles({ id: 'p_2' }, { id: 't_1' }).length, 0, 'a project without files')
  assert.equal(client.sizeLabel(900), '900 B')
  assert.equal(client.sizeLabel(66591), '67 KB', 'decimal units, as Finder counts them')
  assert.equal(client.sizeLabel(3 * 1048576), '3.1 MB')
})

test('the banner says the state in words and one line of detail; acceptance and archive read apart', () => {
  const delivered = { id: 't_1', state: 'review_ready', updatedAt: at, experience: { summary: { next: '查看交付并验收' } } }
  const [head, detail] = client.bannerOf(project, delivered)
  assert.equal(head, '已交付，待验收')
  assert.match(detail, /16:21 交付了 1 个文件$/)
  assert.match(client.bannerOf(project, { ...delivered, id: 't_9' })[1], /16:21 交付$/, 'no file published: no count')
  assert.equal(client.bannerOf(project, { ...delivered, resolved: true })[0], '已归档', 'an archived delivery is not offered for acceptance')
  assert.equal(client.bannerOf(project, { ...delivered, state: 'done', resolved: true })[0], '已验收')
  assert.deepEqual(banner(project, { id: 't_1', state: 'blocked', experience: { reason: '按自然日还是 24 小时？' } }), ['待拍板', '按自然日还是 24 小时？'])
  assert.deepEqual(banner(project, { id: 't_1', state: 'working', experience: { execution: { active: true, label: '正在改 3 个文件' }, summary: { next: '写测试' } } }), ['进行中', '正在改 3 个文件'])
  assert.deepEqual(banner(project, { id: 't_1', state: 'working', experience: { summary: { next: '写测试' } } }), ['进行中', '写测试'])
  assert.deepEqual(banner(project, { id: 't_1', state: 'failed', experience: {} }), ['执行失败', ''])
})

test('status colour is one channel: everything waiting on the owner is yellow, running is blue, done is green, and none is orange', () => {
  const colour = key => client.STATUS_LOOK[key][1]
  assert.equal(colour('review'), colour('decision'), 'both wait on the owner')
  assert.equal(colour('review'), '#eab308')
  assert.notEqual(colour('working'), colour('review'))
  assert.notEqual(colour('done'), colour('working'))
  for (const key of Object.keys(client.STATUS_LOOK)) assert.notEqual(colour(key), '#f76b15', key)
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const rules = source.split('\n').filter(line => !/^(:root\{|@media \(prefers-color-scheme:dark\)\{html:not|html\[data-theme="dark"\])/.test(line))
  assert.equal(rules.filter(line => line.includes('var(--rx-orange-')).length, 0, 'no style rule paints with orange')
})

test('the progress timeline names who spoke, keeps the owner\'s follow-ups, says what a state change means, and shows a repeated one once', () => {
  const thread = { timeline: [
    { kind: 'event', id: 'e1', at: 1, text: '项目助理开了线程，交给源码考古员', tone: 'neutral' },
    { kind: 'event', id: 'e2', at: 2, text: '源码考古员把状态改为进行中', tone: 'working', state: 'working' },
    { kind: 'event', id: 'e3', at: 3, text: '源码考古员把状态改为进行中', tone: 'working', state: 'working' },
    { kind: 'message', id: 'm1', at: 4, text: '继续', author: { kind: 'human', id: 'owner', name: '我' } },
    { kind: 'relay', id: 'r1', at: 5, text: '要给一轮真实组装的实例' },
    { kind: 'message', id: 'm2', at: 6, text: '已按补充要求更新', author: { kind: 'assistant', id: 'a_1', name: '源码考古员' } },
    { kind: 'event', id: 'e4', at: 7, text: '源码考古员把状态改为待验收', tone: 'review_ready', state: 'review_ready' },
    { kind: 'event', id: 'e5', at: 8, text: '归档', tone: 'closed' },
  ] }
  const rows = client.timelineRows(thread).map(r => [r.text, r.status, r.human])
  assert.equal(JSON.stringify(rows), JSON.stringify([
    ['项目助理开了线程，交给源码考古员', null, false],
    ['开始执行', 'working', false],
    ['你：继续', null, true],
    ['你补充：要给一轮真实组装的实例', null, true],
    ['源码考古员：已按补充要求更新', null, false],
    ['交付了，待验收', 'review', false],
    ['归档', 'archived', false],
  ]))
  assert.equal(client.timelineRows({}).length, 0)
})

test('a word passed between tasks is never put in the owner\'s mouth, and a raw state name reads as words', () => {
  const thread = { id: 't_qa', timeline: [
    { kind: 'relay', id: 'r1', at: 1, text: '媒体问答已交付（review_ready）：共享库有 qa.md', from: '执行者', fromThread: 't_qa', toThread: null },
    { kind: 'relay', id: 'r2', at: 2, text: '时间改到周五', from: '邀请函执行者', fromThread: 't_inv', toThread: 't_qa' },
    { kind: 'relay', id: 'r3', at: 3, text: '加一页 FAQ', fromThread: null },
  ] }
  const rows = client.timelineRows(thread).map(r => [r.text, r.human])
  assert.equal(JSON.stringify(rows), JSON.stringify([
    ['告诉项目助理：媒体问答已交付（待验收）：共享库有 qa.md', false],
    ['邀请函执行者转来：时间改到周五', false],
    ['你补充：加一页 FAQ', true],
  ]))
})
