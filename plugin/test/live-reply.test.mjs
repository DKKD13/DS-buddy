import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PROJECT_ICONS } from '../lib/project-icons.js'
import { runInNewContext } from 'node:vm'

let client
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => ({})) } } },
})

// DSH's client feed: durable events, plus transient live chunks of the step being generated.
const live = (time, chunk) => ({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 9.5, time, data: { attemptId: 'a1', turn: 1, step: 1, chunk } } })
const call = (time, id, argumentsDelta, name) => live(time, { type: 'tool-call-delta', index: 0, id, ...(name ? { name } : {}), argumentsDelta })

test('a reply being written into post_message is read from the live chunks as it streams, escapes included', () => {
  const pieces = ['{"te', 'xt": "先说结论：\\', 'n第一行\\u4e', '2d第二行 \\"引号\\"', '", "file_paths": []}']
  const seen = []
  for (let i = 1; i <= pieces.length; i++) {
    const entries = [{ type: 'event', event: { type: 'user/message', seq: 9, time: 1, data: {} } },
      ...pieces.slice(0, i).map((p, k) => call(100 + k, 'c1', p, k === 0 ? 'post_message' : undefined))]
    seen.push(client.livePosts(entries).map(p => p.text).join('|'))
  }
  // An escape split across chunks waits for the rest instead of showing a stray backslash or half a character.
  assert.deepEqual(seen, ['', '先说结论：', '先说结论：\n第一行', '先说结论：\n第一行中第二行 "引号"', '先说结论：\n第一行中第二行 "引号"'])
  assert.equal(client.livePosts([call(100, 'c1', '{"text":"好', 'post_message')])[0].at, 100)
})

test('only post_message text streams: other tools, the model\'s own text and durable events are not shown', () => {
  const entries = [
    live(1, { type: 'text-delta', index: 0, text: '我在想要不要开线程' }),
    call(2, 'c1', '{"state":"working","summary":"在做"}', 'update_card'),
    call(3, 'c2', '{"file_paths":["a.md"],"text":"附上文件', 'post_message'),
    call(4, 'c3', '{"text":"第二条', 'post_message'),
    { type: 'event', event: { type: 'tool/call', seq: 10, time: 5, data: { name: 'post_message', arguments: '{"text":"旧的"}' } } },
  ]
  // The client runs in its own realm; compare plain copies.
  const plain = value => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(client.livePosts(entries).map(p => [p.id, p.text, p.at])), [['c2', '附上文件', 3], ['c3', '第二条', 4]])
  assert.deepEqual(plain(client.livePosts([])), [])
  assert.deepEqual(plain(client.livePosts(undefined)), [])
})

// What the native @ menu offers in each conversation, and what the model reads for a pick.
const DATA = {
  miraSessionId: 's-mira',
  projects: [
    { id: 'p_a', name: '达标', chatSessionId: 's-chat-a', threads: [{ id: 't1', sessionId: 's-task-a' }] },
    { id: 'p_b', name: '试玩', chatSessionId: 's-chat-b', threads: [] },
  ],
  agents: [
    { projectId: null, projectName: null, member: 'mira', name: 'Mira', role: 'memory' },
    { projectId: 'p_a', projectName: '达标', member: 'coordinator', name: '项目助理', role: 'coordinator' },
    { projectId: 'p_a', projectName: '达标', member: 'a_1', name: '标注员', role: 'worker' },
    { projectId: 'p_a', projectName: '达标', member: 'mira', name: 'Mira', role: 'memory' },
    { projectId: 'p_b', projectName: '试玩', member: 'designer', name: '设计师', role: 'worker' },
  ],
}
const plain = value => JSON.parse(JSON.stringify(value))
const rows = (session, query = '') => plain(client.mentionCandidates(DATA, session, query)).map(c => `${c.section}:${c.label}`)

test('the @ menu offers projects, and Mira in her own conversation; never a per-task role, and nothing in other DSH sessions', () => {
  // The owner sees tasks and the models doing them, not the roles the project assistant wrote: no executor is offered.
  assert.deepEqual(rows('s-mira'), ['项目:达标', '项目:试玩', '助理:Mira'])
  assert.deepEqual(rows('s-chat-a'), ['项目:达标', '项目:试玩'])
  assert.deepEqual(rows('s-task-a'), ['项目:达标', '项目:试玩'])
  assert.deepEqual(rows('s-other'), [])
  // Typing filters by name.
  assert.deepEqual(rows('s-mira', '标'), ['项目:达标'])
  assert.deepEqual(rows('s-mira', 'Mi'), ['助理:Mira'])
})

test('a picked project or Mira reads as a plain @name; an executor written earlier still reads with its project; no ids reach the owner', () => {
  const [project] = plain(client.mentionCandidates(DATA, 's-mira', '达标'))
  assert.equal(client.mentionClipboard(project.value), '@达标')
  // DSH shows the sent text in the owner's bubble, so it carries names only; the assistants resolve names themselves.
  assert.equal(client.mentionText(project.value), '@达标')
  const mira = plain(client.mentionCandidates(DATA, 's-mira', 'Mira')).find(c => c.section === '助理')
  assert.equal(client.mentionText(mira.value), '@Mira')
  assert.equal(client.mentionText(JSON.stringify({ k: 'agent', projectId: 'p_a', projectName: '达标', member: 'a_1', name: '标注员' })), '@标注员（达标）')
  assert.equal(client.mentionText('not json'), '')
})

test('a model id reads as a name, and a task shows what executes it: the model, or Claude Code / Codex', () => {
  assert.equal(client.modelName('deepseek-flash'), 'DeepSeek Flash')
  assert.equal(client.modelName({ provider: 'x', model: 'claude-opus-4-5' }), 'Claude Opus 4.5')
  assert.equal(client.modelName('gpt-5-4'), 'GPT 5.4')
  assert.equal(client.modelName(null), '默认模型')
  const members = [
    { id: 'coordinator', kind: 'assistant', role: 'coordinator', name: '项目助理', model: { model: 'deepseek-flash' } },
    { id: 'a_1', kind: 'assistant', role: 'worker', name: '标注员', model: { model: 'deepseek-flash' } },
    { id: 'a_2', kind: 'assistant', role: 'worker', name: '工程师', model: { model: 'deepseek-flash' }, runtimeSelection: { provider: 'claude', deviceId: 'local' } },
    { id: 'owner', kind: 'human', name: '我' },
  ]
  const project = { members }
  const ex = (thread) => plain(client.executorOf(project, thread))
  assert.deepEqual(ex({ assignee: 'a_1', runner: 'dsh', runtime: { provider: 'dsh' } }), { name: 'DeepSeek Flash', model: { model: 'deepseek-flash' } })
  // The task's own choice wins over the role's default; a task bound to Codex shows Codex.
  assert.equal(ex({ assignee: 'a_2', runner: 'dsh', runtime: { provider: 'dsh' } }).name, 'DeepSeek Flash')
  assert.equal(ex({ assignee: 'a_2' }).name, 'Claude Code')
  assert.equal(ex({ assignee: 'a_1', runtime: { provider: 'codex' } }).app, 'Codex')
  // Without the project's members (the navigation list) only an outside runner is known.
  assert.equal(plain(client.executorOf({ threads: [] }, { assignee: 'a_1', runtime: { provider: 'claude' } })).name, 'Claude Code')
  assert.equal(plain(client.executorOf({ threads: [] }, { assignee: 'a_1', runtime: { provider: 'dsh' } })).name, '')
  // Names on screen: the assistants by their role, a per-task role by what runs it, people as themselves.
  assert.equal(client.shownName(members[0]), '项目助理')
  assert.equal(client.shownName(members[1]), 'DeepSeek Flash')
  assert.equal(client.shownName(members[2]), 'Claude Code')
  assert.equal(client.shownName(members[3]), '我')
  assert.equal(client.shownName(undefined, '某人'), '某人')
})

// A sent mention in the owner's bubble: one chip for the whole name, however the name is written.
const WIDE = { ...DATA, projects: [...DATA.projects, { id: 'p_c', name: 'Mira Context 解剖' }, { id: 'p_d', name: 'beta' }, { id: 'p_e', name: '达标二期' }] }
const hit = (text, from = 0, data = WIDE) => {
  const found = client.mentionRule(client.mentionNames(data)).match(text, from)
  return found ? plain([text.slice(found.start, found.end), found.data.kind, found.data.label, found.data.projectId]) : null
}

test('a project name with spaces is one mention, and the longest name wins over a shorter one that starts the same', () => {
  // DSH's own file rule ends at the first space: "@Mira" became a file chip and the rest loose words. Ours runs first.
  const rule = client.mentionRule(client.mentionNames(WIDE))
  assert.equal(rule.id, 'mira-mention')
  assert.ok(rule.order < 30)
  assert.deepEqual(hit('看一下 @Mira Context 解剖 的进度'), ['@Mira Context 解剖', 'project', 'Mira Context 解剖', 'p_c'])
  assert.deepEqual(hit('@Mira 帮我看看'), ['@Mira', 'mira', 'Mira', null])
  assert.deepEqual(hit('@达标'), ['@达标', 'project', '达标', 'p_a'])
  assert.deepEqual(hit('@达标二期 排期'), ['@达标二期', 'project', '达标二期', 'p_e'])
  // An executor is written with its project, which tells same names apart; hidden assistants are never mentions.
  assert.deepEqual(hit('交给 @标注员（达标） 吧'), ['@标注员（达标）', 'agent', '标注员', 'p_a'])
  assert.equal(hit('@项目助理（达标） 在吗'), null)
  assert.deepEqual(hit('@Mira（达标）'), ['@Mira', 'mira', 'Mira', null])
})

test('an address, a longer latin word and text before the search start are not mentions', () => {
  assert.equal(hit('写信给 a@beta.com'), null)
  assert.equal(hit('@betamax 不是项目'), null)
  assert.deepEqual(hit('@beta, 然后呢'), ['@beta', 'project', 'beta', 'p_d'])
  assert.equal(hit('@src/app.js 这个文件'), null)
  // DSH asks again from where the last node ended: the first mention is skipped, the second found.
  assert.deepEqual(hit('@达标 和 @试玩', 3), ['@试玩', 'project', '试玩', 'p_b'])
  assert.equal(hit('没有提到谁'), null)
  assert.equal(hit('@达标', 0, { projects: [], agents: [] }), null)
})

test('a source or an app gets its own mark, and an unknown one a letter tile that stays the same for the same name', () => {
  for (const name of ['飞书', '邮件', 'Claude', 'Claude Code', 'Codex', 'Google Chrome', '访达', '助理']) {
    const spec = client.iconSpec(name)
    assert.ok(spec.d || spec.shapes || spec.sticker, name)
    assert.equal(spec.letter, undefined, name)
  }
  // Mira herself is drawn as her sticker face, not as a brand tile.
  assert.equal(client.iconSpec('助理').sticker, 'memory')
  assert.equal(client.iconSpec('个人助理').sticker, 'memory')
  assert.notDeepEqual(plain(client.iconSpec('Claude')), plain(client.iconSpec('Claude Code')))
  assert.deepEqual(plain(client.iconSpec('google chrome')), plain(client.iconSpec('Google Chrome')))
  const unknown = plain(client.iconSpec('airjelly'))
  assert.equal(unknown.letter, 'A')
  assert.deepEqual(plain(client.iconSpec('airjelly')), unknown)
  assert.equal(client.iconSpec('').letter, '·')
  assert.equal(client.iconSpec(undefined).letter, '·')
})

test('every icon name the client uses has a line drawing in the host\'s style', () => {
  const icons = plain(client.ICONS)
  for (const [name, d] of Object.entries(icons)) assert.match(d, /^M[\d.\s,a-zA-Z-]+$/, name)
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const used = new Set([...source.matchAll(/h\((?:Icon|IconButton), \{ name: "([a-z_]+)"/g), ...source.matchAll(/\bicon: "([a-z_]+)"/g)].map(m => m[1]))
  assert.ok(used.size > 10)
  for (const name of used) assert.ok(icons[name], `no line icon for ${name}`)
  // The project's executor is told apart from the roles made before it.
  assert.equal(client.isProjectExecutor({ id: 'executor' }), true)
  assert.equal(client.isProjectExecutor({ id: 'executor_0a1b2c3d' }), true)
  assert.equal(client.isProjectExecutor({ id: 'a_123' }), false)
  assert.equal(client.isProjectExecutor(undefined), false)
})

test('a task\'s status icon follows its state, and a project wears its own emoji and colour or a stable stand-in', () => {
  const s = t => client.taskStatus(t)
  assert.equal(s({ state: 'done' }), 'done')
  assert.equal(s({ state: 'working', resolved: true }), 'archived')
  assert.equal(s({ state: 'review_ready' }), 'review')
  assert.equal(s({ state: 'blocked' }), 'decision')
  assert.equal(s({ state: 'failed' }), 'failed')
  assert.equal(s({ state: 'working', experience: { execution: { phase: 'queued' } } }), 'queued')
  assert.equal(s({ state: 'working' }), 'working')
  assert.equal(s(undefined), 'queued')
  // Done wins over archived: an accepted task that was then put away still reads 已完成.
  assert.equal(s({ state: 'done', resolved: true }), 'done')
  const look = p => plain(client.projectLook(p))
  assert.deepEqual(look({ id: 'p_1', icon: 'book-open', color: 'green' }), { icon: 'book-open', color: 'green' })
  // An emoji stored before the library is shown as the icon that means the same; an unknown one gets the stand-in.
  assert.equal(look({ id: 'p_1', icon: '🧠', color: 'green' }).icon, 'brain')
  assert.equal(look({ id: 'p_1', icon: '🦄', color: 'green' }).icon, look({ id: 'p_1' }).icon)
  const fallback = look({ id: 'p_2' })
  assert.deepEqual(look({ id: 'p_2' }), fallback, 'the stand-in is stable')
  assert.ok(plain(client.PROJECT_ICON_NAMES).includes(fallback.icon))
  assert.ok(Object.keys(plain(client.PROJECT_TINTS)).includes(fallback.color))
  // A colour the client does not know falls back; the emoji stays.
  assert.equal(look({ id: 'p_2', icon: 'brain', color: 'black' }).icon, 'brain')
  assert.equal(look({ id: 'p_2', icon: 'brain', color: 'black' }).color, fallback.color)
  // Different projects usually look different.
  const looks = new Set(['p_a', 'p_b', 'p_c', 'p_d', 'p_e', 'p_f'].map(id => JSON.stringify(look({ id }))))
  assert.ok(looks.size >= 4)
  // The server's colour list and the client's tints are the same nine.
  assert.deepEqual(Object.keys(plain(client.PROJECT_TINTS)), ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'])
})

test('the timeline follows the clock: joined stretches, one label per moment, gaps that grow with the minutes, unique rows', () => {
  const m = minutes => Date.UTC(2026, 10, 13, 5, 0) + minutes * 60e3
  const act = (start, title, extra = {}) => ({ kind: 'activity', ref: 'hub#7', at: m(start), end: m(start + 10), title, apps: [title + '-app'], ...extra })
  // Newest first, as the tab sorts them: two contiguous windows of the same work, two others in the newest window, an event, a quiet hour.
  const rows = [act(20, 'A'), act(20, 'B'), act(10, 'A', { apps: ['A-app', 'A2-app'] }), act(10, 'C'), { kind: 'events', ref: 'p#1', at: m(5), end: m(5), lines: [] }, act(-60, 'D')]
  const out = plain(client.layoutTimeline(rows))
  // A at 10 and A at 20 are one stretch from 10 to 30, with both windows' apps.
  const a = out.filter(r => r.title === 'A')
  assert.equal(a.length, 1)
  assert.deepEqual([a[0].at, a[0].end], [m(10), m(30)])
  assert.deepEqual(a[0].apps, ['A-app', 'A2-app'])
  // Ordered by when each row ends, newest first; of two that end together, the one that started later is on top.
  assert.deepEqual(out.map(r => r.title ?? r.kind), ['B', 'A', 'C', 'events', 'D'])
  // B starts at 20, A at 10: different moments; C starts with A at 10: same moment, no label of its own, no extra space.
  assert.equal(out[2].sameMoment, true)
  assert.equal(out[2].gap, 0)
  assert.equal(out[1].sameMoment, false)
  // Space follows the minutes between rows, within 6..40 px: a quiet hour is long, a short pause is short.
  assert.equal(out[0].gap, 0)
  assert.equal(out[1].gap, 6)
  assert.equal(out[3].gap, 6)
  assert.equal(out[4].gap, 28)
  // A stretch that started earlier but ends later sits above an event in between.
  const long = plain(client.layoutTimeline([{ kind: 'events', ref: 'p#2', at: m(25), end: m(25), lines: [] }, act(20, 'G'), act(10, 'G')]))
  assert.deepEqual(long.map(r => r.title ?? r.kind), ['G', 'events'])
  const late = plain(client.layoutTimeline([act(300, 'E'), act(0, 'F')]))
  assert.equal(late[1].gap, 40)
  // Rows sharing a ref and a start are still told apart (the old key, ref + start, was not unique).
  assert.equal(new Set(out.map((r, i) => `${r.ref}:${r.at}:${i}`)).size, out.length)
  // The input is not changed.
  assert.equal(rows[0].at, m(20))
})

test('the client draws exactly the server\'s icon library, each icon from plain shapes', () => {
  const shapes = plain(client.PROJECT_ICON_SHAPES)
  assert.deepEqual(Object.keys(shapes).sort(), [...PROJECT_ICONS].sort())
  for (const [name, parts] of Object.entries(shapes)) {
    assert.ok(parts.length > 0, name)
    for (const [tag, attrs] of parts) {
      assert.ok(['path', 'circle', 'rect', 'line', 'polyline', 'ellipse', 'polygon'].includes(tag), `${name}: ${tag}`)
      for (const key of Object.keys(attrs)) assert.ok(!/^on/i.test(key) && key !== 'href' && key !== 'style', `${name}: ${key}`)
    }
  }
})
