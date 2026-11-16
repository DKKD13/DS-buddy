import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let client
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => ({})) } } },
})
// Arrays made inside the client's own context are compared as text: deepStrictEqual sees another realm's prototype.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)

test('a dream pick offers the night\'s own sentence when it wrote one, else one by its lane', () => {
  assert.equal(client.pickAsk({ lane: 'do', title: '补数据', ask: ' 帮我在画像项目里补一轮数据 ' }, '画像'), '帮我在画像项目里补一轮数据')
  assert.equal(client.pickAsk({ lane: 'do', title: '补数据' }, '用户访谈整理'), '在「用户访谈整理」开个任务：补数据')
  assert.equal(client.pickAsk({ lane: 'do', title: '补数据' }, ''), '开个任务：补数据')
  assert.equal(client.pickAsk({ lane: 'read', title: '新闻稿' }, 'x'), '带我看看「新闻稿」，说说要点')
  assert.equal(client.pickAsk({ lane: 'care', title: '睡得少' }, 'x'), '关于「睡得少」，')
})

test('项目进展 lists projects holding asks first, keeps each task once, and leaves out projects with nothing to show', () => {
  const projects = [
    { id: 'a', name: '安静的', lastAt: 9, working: [], done: [], review: [] },
    { id: 'b', name: '在跑的', lastAt: 8, working: [{ id: 't1', title: '写稿' }], done: [{ id: 't2', title: '口号' }] },
    { id: 'c', name: '等你的', lastAt: 1, working: [{ id: 't3', title: '网页' }], done: [] },
  ]
  const waiting = [{ projectId: 'c', threadId: 't3', kind: 'review', title: '网页', since: 5 }]
  const rows = client.inboxProjects(projects, waiting)
  same(rows.map(p => p.id), ['c', 'b'])
  assert.equal(rows[0].working.length, 0, 'a task waiting for the owner is not also listed as running')
  assert.equal(rows[0].lastAt, 5, 'a project is as recent as its newest ask')
  same(client.inboxProjects(undefined, []), [])
})

test('an outside runner\'s tool calls fold into one line per stretch, so the progress lines stay in sight', () => {
  const thread = { timeline: [
    { kind: 'event', id: 'e1', at: 1, text: '外部执行：mcp__mira-project__inbox_read', tone: 'neutral' },
    { kind: 'event', id: 'e2', at: 2, text: '外部执行：Bash', tone: 'neutral' },
    { kind: 'message', id: 'm1', at: 3, text: '接上了', author: { kind: 'assistant', name: '执行者' } },
    { kind: 'event', id: 'e3', at: 4, text: '外部执行：Edit', tone: 'neutral' },
  ] }
  same(client.timelineRows(thread).map(r => r.text), ['执行了 2 步', '执行者：接上了', '执行了 1 步'])
})

test('需要留意 is one stream, newest first: Feishu, the assistant\'s open notes and last night\'s picks not yet handled', () => {
  const notes = client.inboxNotes({
    followups: [{ conversation: 'oc_1', who: '陈工', title: '发布群', ask: '问坏图修好没', text: '那张图修了吗', since: 30 }],
    cards: [{ id: 'c_1', state: 'open', title: '20 文件待提交', body: '只差提交', at: 20 }, { id: 'c_2', state: 'dismissed', title: '关掉的', at: 40 }],
    dream: { startedAt: 10, picked: [{ lane: 'do', title: '补数据', body: '四步', projectId: 'p1' }, { lane: 'read', title: '看说明', reaction: 'opened' }] },
    projectName: id => id === 'p1' ? '画像' : '',
  })
  same(notes.map(n => [n.from, n.title]), [['followup', '问坏图修好没'], ['card', '20 文件待提交'], ['pick', '补数据']])
  same(client.noteAsks(notes[0]), [['帮我回', '陈工在「发布群」找我，原话「那张图修了吗」，帮我看看怎么回']])
  same(client.noteAsks(notes[1]), [['接着说', '关于「20 文件待提交」，']])
  same(client.noteAsks(notes[2]), [['开个任务', '在「画像」开个任务：补数据']])
  same(client.inboxNotes({}), [])
})

test('the @ menu does not offer a conversation that has no title, and passes every other row through', () => {
  const rows = [
    { name: '写媒体问答 qa.md', icon: 'session', section: '对话' },
    { name: 'session-658967df-1d3f-43bb-9c1e-0a8e58810a83', icon: 'session', section: '对话' },
    { name: 'session-notes.md', icon: 'file', section: '文件' },
  ]
  same(client.titledOnly(rows).map(r => r.name), ['写媒体问答 qa.md', 'session-notes.md'])
  assert.equal(client.titledOnly(undefined), undefined)
})

test('the @ menu also leaves out the plugin\'s own plumbing conversations', () => {
  const rows = [
    { name: '官网改版的记忆助理', icon: 'session' }, { name: '官网改版 · 定时投递', icon: 'session' },
    { name: '改版首页首屏', icon: 'session' }, { name: '我的记忆助理笔记.md', icon: 'file' },
  ]
  same(client.titledOnly(rows).map(r => r.name), ['改版首页首屏', '我的记忆助理笔记.md'])
})

test('the suggested lines above the composer offer each line once, also when one task holds two open decisions', () => {
  const waiting = [
    { title: '写媒体问答', decision: { id: 'd1' }, ask: '问答用哪种口径？' },
    { title: '写媒体问答', decision: { id: 'd2' }, ask: '价格要不要写？' },
    { title: '做邀请函', ask: '交付，待验收' },
  ]
  same(client.suggestionsFor(waiting, new Set()), ['「写媒体问答」按推荐的回复', '帮我把「做邀请函」验收了', '今天做了什么'])
  same(client.suggestionsFor(waiting, new Set(['今天做了什么'])), ['「写媒体问答」按推荐的回复', '帮我把「做邀请函」验收了'], 'a line already said is not offered again')
})

test('the @ menu does not show a data path under a conversation that works in the plugin\'s own storage', () => {
  const rows = [
    { name: '个人助理', icon: 'session', section: '对话', description: '~/.local/state/tacit/data/_hub/_folders/hub/个人助理 · 6分钟' },
    { name: '写媒体问答', icon: 'session', section: '对话', description: '~/data/_folders/p_1a2b3c4d5e/发布会 · 2小时' },
    { name: '老项目的任务', icon: 'session', section: '对话', description: '/srv/tacit/p_0123456789/老项目' },
    { name: '改版首页首屏', icon: 'session', section: '对话', description: '~/code/site · 3分钟' },
    { name: 'notes.md', icon: 'file', section: '文件', description: '~/data/_folders/p_1a2b3c4d5e/发布会/notes.md' },
  ]
  same(client.titledOnly(rows).map(r => r.description), ['6分钟', '2小时', '', '~/code/site · 3分钟', '~/data/_folders/p_1a2b3c4d5e/发布会/notes.md'])
  assert.equal(rows[0].description.startsWith('~/.local'), true, 'the host\'s own row objects are left as they were')
})
