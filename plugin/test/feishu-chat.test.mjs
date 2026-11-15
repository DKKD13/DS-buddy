import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, MIRA } from '../lib/store.js'
import { Actions } from '../lib/actions.js'
import { ensureHub, HUB_ID, HubActions, hubRolePrompt } from '../lib/hub.js'
import { PersonalMira } from '../lib/personal.js'
import { createHubTools } from '../lib/hub-tools.js'
import { waitingConversations } from '../lib/followups.js'

const T0 = Date.parse('2026-11-07T09:00:00+08:00'), MIN = 60_000
const DM = 'lark-chat.oc_dm', GROUP = 'lark-chat.oc_group', NAMED = 'lark-chat.oc_named'
const iso = at => new Date(at).toISOString()

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-feishu-chat-'))
  const store = new ProjectStore(root, { warn() {} }), hubStore = new ProjectStore(join(root, '_hub'), { warn() {} })
  store.load();hubStore.load();ensureHub(hubStore)
  const driver = { deliver() {}, status: () => 'idle', turnOf: () => undefined }
  const actions = new Actions(store, driver)
  const personal = new PersonalMira(hubStore, driver, store, actions)
  t.after(() => { personal.close();rmSync(root, { recursive: true, force: true }) })
  // A Feishu observation as the device entrance stores it.
  let n = 0
  const say = ({ at, text, chat = DM, title = '单聊', me = false, id = 'om_' + ++n, version = at }) => hubStore.append(HUB_ID, {
    type: 'observation.accepted', eventId: `lark:${id}:${version}${me ? ':me' : ''}`, source: 'lark', occurredAt: at, app: '飞书', title, text,
    correlationId: chat, important: !me, deviceId: 'mac-1', deviceName: '我的 Mac', trust: 'external', receivedAt: at })
  return { store, hubStore, driver, actions, personal, say }
}

function story(f) {
  // A direct chat collected before chats were titled with the other side: nothing in the owner's own lines names her.
  const a = f.say({ at: T0, text: '陈工：明天的部署你几点方便？' })
  const b = f.say({ at: T0 + 2 * MIN, text: '林一（我）：下午三点以后都行', me: true })
  f.say({ at: T0 + 3 * MIN, text: '陈工：那就三点', id: 'om_edit', version: 1 })
  const c = f.say({ at: T0 + 3 * MIN, text: '陈工：那就三点半', id: 'om_edit', version: 2 }) // edited: the latest version stands for it
  const d = f.say({ at: T0 + 5 * MIN, text: '林一（我）：好，我来发通知', me: true })
  const g = f.say({ at: T0 + 4 * MIN, text: '李四：周报记得交', chat: GROUP, title: '达标讨论群' })
  const n = f.say({ at: T0 + 6 * MIN, text: '林一（我）：收到', chat: NAMED, title: '与赵六的单聊', me: true })
  // Not Feishu, not a conversation.
  const screen = f.hubStore.append(HUB_ID, { type: 'observation.accepted', eventId: 'screen:1', source: 'screen', occurredAt: T0 + MIN, app: '飞书', title: '陈工', text: '屏幕上的字', deviceId: 'mac-1', deviceName: '我的 Mac', trust: 'observation', receivedAt: T0 + MIN })
  return { a, b, c, d, g, n, screen }
}

test('the collected Feishu conversations are listed newest first and found by who speaks in them, not only by their title', t => {
  const f = setup(t);story(f)
  const all = f.personal.feishuChat()
  assert.deepEqual(all.conversations.map(c => [c.conversation, c.title, c.people, c.messages, c.mine]),
    [[NAMED, '与赵六的单聊', [], 1, 1], [DM, '单聊', ['陈工'], 4, 2], [GROUP, '达标讨论群', ['李四'], 1, 0]])
  assert.deepEqual([all.total, all.hasMore, all.conversations[1].firstAt, all.conversations[1].lastAt], [3, false, iso(T0), iso(T0 + 5 * MIN)])
  // Her name is in no title and in none of the owner's lines there; the chat is still found, whole.
  assert.deepEqual(f.personal.feishuChat({ query: '陈工' }).conversations.map(c => c.conversation), [DM])
  assert.deepEqual(f.personal.feishuChat({ query: '赵六' }).conversations.map(c => c.conversation), [NAMED])
  assert.deepEqual(f.personal.feishuChat({ query: '没有这个人' }), { conversations: [], total: 0, hasMore: false })
  assert.deepEqual(f.personal.feishuChat({ limit: 1 }).conversations.map(c => c.conversation), [NAMED])
  assert.equal(f.personal.feishuChat({ limit: 1 }).hasMore, true)
  assert.deepEqual(f.personal.feishuChat({ since: iso(T0 + 6 * MIN) }).conversations.map(c => c.conversation), [NAMED])
  // Listing shows no message text, so it hands out no evidence.
  assert.equal(f.hubStore.get(HUB_ID).events.some(e => e.type === 'personal.evidence.provided'), false)
})

test('one Feishu conversation is read in order, both sides, the owner\'s words marked, and what was read can be cited', t => {
  const f = setup(t), s = story(f)
  const chat = f.personal.feishuChat({ conversation: DM }, 's-hub')
  assert.deepEqual([chat.conversation, chat.title, chat.people, chat.total, chat.hasEarlier], [DM, '单聊', ['陈工'], 4, false])
  assert.deepEqual(chat.messages.map(m => [m.ref, m.at, m.mine, m.trust, m.text]), [
    [`hub#${s.a.seq}`, iso(T0), false, 'external', '陈工：明天的部署你几点方便？'],
    [`hub#${s.b.seq}`, iso(T0 + 2 * MIN), true, 'external', '林一（我）：下午三点以后都行'],
    [`hub#${s.c.seq}`, iso(T0 + 3 * MIN), false, 'external', '陈工：那就三点半'],
    [`hub#${s.d.seq}`, iso(T0 + 5 * MIN), true, 'external', '林一（我）：好，我来发通知'],
  ])
  assert.deepEqual(f.hubStore.get(HUB_ID).events.findLast(e => e.type === 'personal.evidence.provided').refs, chat.messages.map(m => m.ref))
  // The newest ones first; earlier ones by asking for what came before.
  const tail = f.personal.feishuChat({ conversation: DM, limit: 2 })
  assert.deepEqual([tail.messages.map(m => m.ref), tail.total, tail.hasEarlier], [[`hub#${s.c.seq}`, `hub#${s.d.seq}`], 4, true])
  const head = f.personal.feishuChat({ conversation: DM, limit: 2, until: tail.messages[0].at })
  assert.deepEqual([head.messages.map(m => m.ref), head.hasEarlier], [[`hub#${s.a.seq}`, `hub#${s.b.seq}`], false])
  // A long message is cut the way a search hit is, and says so.
  f.say({ at: T0 + 9 * MIN, text: '陈工：' + '长'.repeat(1300) })
  const long = f.personal.feishuChat({ conversation: DM, limit: 1 }).messages[0]
  assert.deepEqual([long.text.length, long.truncated], [1200, true])
  assert.throws(() => f.personal.feishuChat({ conversation: 'lark-chat.oc_none' }), /没有收集到这个飞书会话/)
  assert.throws(() => f.personal.feishuChat({ conversation: DM, since: iso(T0 + 60 * MIN) }), /没有收集到这个飞书会话/)
  assert.throws(() => f.personal.feishuChat({ conversation: DM, limit: 101 }), /1–100/)
  assert.throws(() => f.personal.feishuChat({ conversation: DM, since: '2026-11-07 09:00' }), /带时区/)
  assert.throws(() => f.personal.feishuChat({ since: iso(T0 + MIN), until: iso(T0) }), /时间范围无效/)
})

test('a search hit on a Feishu message says which conversation it belongs to, and the owed-reply worker still sees the same conversations', t => {
  const f = setup(t), s = story(f)
  const hits = f.personal.search({ query: '部署' }).items
  assert.deepEqual(hits.map(h => [h.ref, h.conversation]), [[`hub#${s.a.seq}`, DM]])
  // Nothing but a Feishu message carries one.
  assert.equal(f.personal.source(`hub#${s.a.seq}`).conversation, DM)
  assert.equal('conversation' in f.personal.source(`hub#${s.screen.seq}`), false)
  // The group line still waits for nobody's reply by the worker's own rules; the direct chat was answered.
  assert.deepEqual(waitingConversations(f.hubStore.get(HUB_ID)).map(c => [c.id, c.asks.length]), [[GROUP, 1]])
})

test('the assistant has the tool, only in its own conversation, and is told to read a conversation whole', async t => {
  const f = setup(t);story(f)
  const hubActions = new HubActions(f.hubStore, f.driver, f.store, f.actions)
  const tools = createHubTools({ defineTool: d => d, hubStore: f.hubStore, hubDriver: f.driver, hubActions, projects: f.store, projectDriver: f.driver, personal: f.personal })
  const tool = tools.find(x => x.definition.name === 'hub_feishu_chat')
  assert.ok(tool)
  await assert.rejects(tool.definition.execute({}, { agent: { id: 's-other' } }), /只在个人助理会话里可用/)
  f.hubStore.append(HUB_ID, { type: 'session.bound', key: MIRA, sessionId: 's-hub', generation: 1 })
  const listed = JSON.parse(await tool.definition.execute({ query: '陈工' }, { agent: { id: 's-hub' } }))
  assert.deepEqual(listed.conversations.map(c => c.conversation), [DM])
  const read = JSON.parse(await tool.definition.execute({ conversation: DM, limit: 3 }, { agent: { id: 's-hub' } }))
  assert.deepEqual([read.messages.length, read.hasEarlier, read.messages.at(-1).mine], [3, true, true])
  const called = f.hubStore.get(HUB_ID).events.filter(e => e.type === 'tool.called').map(e => [e.tool, e.ok])
  assert.deepEqual(called, [['hub_feishu_chat', false], ['hub_feishu_chat', true], ['hub_feishu_chat', true]])
  assert.match(hubRolePrompt(f.hubStore.get(HUB_ID)), /用hub_feishu_chat找到那个会话整段按顺序读/)
})
