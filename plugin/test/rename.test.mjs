import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore, COORDINATOR, MIRA, MIRA_MEMBER, PERSONAL_NAME, workerKey } from '../lib/store.js'
import { Actions } from '../lib/actions.js'
import { snapshot } from '../lib/http.js'
import { ensureHub, HUB_ID, hubRolePrompt } from '../lib/hub.js'
import { renderItem, rolePrompt } from '../lib/protocol.js'
import { Driver } from '../lib/driver.js'

const OLD = 'Mira'
const coordinator = { id: COORDINATOR, kind: 'assistant', role: 'coordinator', name: '项目助理', persona: '接话' }
const owner = { id: 'owner', kind: 'human', name: '我' }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-rename-'))
  const store = new ProjectStore(root, { warn() {} }), hubStore = new ProjectStore(join(root, '_hub'), { warn() {} })
  store.load(); hubStore.load()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const driver = { deliver() {}, status: () => 'idle', childrenOf: () => [], memberModel: () => null }
  return { root, store, hubStore, driver, actions: new Actions(store, driver) }
}

test('logs written under the old name read with today\'s names, and the workspace folder keeps its old one', async t => {
  const f = fixture(t)
  // A project and a hub exactly as they were written before the rename.
  f.store.append('p_old', { type: 'project.created', name: '老项目', instructions: '', nonce: 'aaaa1111', members: [owner, coordinator, { ...MIRA_MEMBER, name: OLD }] })
  f.hubStore.append(HUB_ID, { type: 'project.created', hub: true, name: `${OLD} 总管`, instructions: '', nonce: 'bbbb2222', members: [owner, { ...MIRA_MEMBER, name: OLD }] })
  const names = store => store.get(store === f.hubStore ? HUB_ID : 'p_old').members.find(m => m.id === MIRA).name
  assert.equal(names(f.store), '记忆助理')
  assert.equal(names(f.hubStore), PERSONAL_NAME)
  assert.equal(f.hubStore.get(HUB_ID).name, PERSONAL_NAME)
  assert.equal(f.hubStore.get(HUB_ID).initialName, `${OLD} 总管`, 'the folder on disk is not renamed')
  // An old settings save carries the old name too.
  f.store.append('p_old', { type: 'project.configured', name: '老项目', instructions: '只做测试', members: [owner, coordinator, { ...MIRA_MEMBER, name: OLD }] })
  assert.equal(names(f.store), '记忆助理')
  // A page still open from before the rename sends the old name back: accepted as "unchanged", never stored again.
  const members = () => f.store.get('p_old').members.filter(m => m.kind === 'assistant').map(({ id, name, persona }) => ({ id, name, persona }))
  await f.actions.configureProject({ projectId: 'p_old', expectedRevision: f.store.get('p_old').configRevision, name: '老项目', instructions: '只做测试',
    members: members().map(m => m.id === MIRA ? { ...m, name: OLD } : m) })
  assert.equal(names(f.store), '记忆助理')
  // The same after a restart.
  const replay = new ProjectStore(f.root, { warn() {} }); replay.load()
  assert.equal(replay.get('p_old').members.find(m => m.id === MIRA).name, '记忆助理')
  // A hub created today is born with the new name.
  const fresh = fixture(t); ensureHub(fresh.hubStore)
  assert.equal(fresh.hubStore.get(HUB_ID).name, PERSONAL_NAME)
  assert.equal(fresh.hubStore.get(HUB_ID).members.find(m => m.id === MIRA).name, PERSONAL_NAME)
  assert.match(hubRolePrompt(fresh.hubStore.get(HUB_ID)), /# 个人助理\n你是用户的个人助理（平台内部叫总管；你以前的名字是 Mira，用户说 Mira 一般是叫你）/)
})

test('the owner can still call her by the old name, and the new name works the same', t => {
  const f = fixture(t)
  const { projectId } = f.actions.createProject({ name: '点名' })
  const project = f.store.get(projectId)
  assert.equal(project.members.find(m => m.id === MIRA).name, '记忆助理')
  for (const text of ['@记忆助理 记一下', `@${OLD} 记一下`, '@mira 记一下', '记忆助理，你记了什么？', `${OLD}，你记了什么？`]) assert.deepEqual(f.store.mentions(project, text), [MIRA], text)
  for (const text of [`让 ${OLD} 念一下`, '让记忆助理念一下', '项目助理和记忆助理谁在？']) assert.deepEqual(f.store.mentions(project, text), [], text)
  // The coordinator is told both names mean her, and may not brush off a line that already @'d her under either.
  assert.match(rolePrompt(project, COORDINATOR), /喊了记忆助理的名字（她以前叫 Mira，用户说 Mira 也是指她）却没 @ 她/)
  assert.match(rolePrompt(project, MIRA), /的记忆助理（你以前的名字是 Mira，用户说 Mira 就是叫你）/)
  for (const [said, answer] of [[`@${OLD} 记一下：回复只要结论`, `这件事归 ${OLD} 记，她已被点名。`], ['@记忆助理 记一下：回复只要结论', '这件事归记忆助理记，她已被点名。']]) {
    f.actions.ownerPost({ projectId, text: said })
    assert.throws(() => f.actions.assistantPost(project, COORDINATOR, answer), /用户已经 @记忆助理了/, answer)
  }
})

test('what the personal assistant passes into a task is signed 个人助理, not with the project member that shares its id', t => {
  const f = fixture(t)
  const { projectId } = f.actions.createProject({ name: '带话' })
  const project = f.store.get(projectId)
  const { threadId } = f.actions.openThread(project, { title: '写简介', brief: '100 字以内', assignee: '工程师' })
  const { messageId } = f.actions.miraRelay({ projectId, threadId, text: '用户说标题再短一点', sourceRef: 'hub#7' })
  const event = project.events.find(e => e.messageId === messageId)
  assert.match(renderItem(project, event), /from="个人助理" trust="relay"/)
  const row = snapshot(f.store, f.driver, projectId).project.threads[0].timeline.find(r => r.id === messageId)
  assert.equal(row.author.name, PERSONAL_NAME)
  assert.equal(row.author.id, MIRA)
  // The memory assistant's own messages keep her name.
  f.actions.ownerPost({ projectId, text: '@记忆助理 记一下：标题要短' })
  f.actions.assistantPost(project, MIRA, '记下了。')
  const chat = snapshot(f.store, f.driver, projectId).project.chat.at(-1)
  assert.deepEqual([chat.author.id, chat.author.name], [MIRA, '记忆助理'])
  assert.match(rolePrompt(project, workerKey(threadId)), /from="个人助理" 的消息是用户的个人助理按他的要求转达的话/)
  // After a restart the label is still there.
  const replay = new ProjectStore(f.root, { warn() {} }); replay.load()
  assert.equal(snapshot(replay, f.driver, projectId).project.threads[0].timeline.find(r => r.id === messageId).author.name, PERSONAL_NAME)
})

test('a Session titled under the old name gets today\'s name when it comes up; a title the owner gave stays', t => {
  const f = fixture(t)
  f.store.append('p_old', { type: 'project.created', name: '老项目', instructions: '', nonce: 'aaaa1111', members: [owner, coordinator, { ...MIRA_MEMBER, name: OLD }] })
  f.hubStore.append(HUB_ID, { type: 'project.created', hub: true, name: `${OLD} 总管`, instructions: '', nonce: 'bbbb2222', members: [owner, { ...MIRA_MEMBER, name: OLD }] })
  let n = 0
  const comesUp = (store, projectId, key, title) => {
    const renamed = [], sessionId = `s-${++n}`
    const titles = { get: () => title === undefined ? undefined : { title }, rename: (_session, next) => { renamed.push(next) } }
    const driver = new Driver({ logger: { warn() {} }, get: name => name === 'sessionTitle' ? titles : undefined }, store, c => c)
    store.append(projectId, { type: 'session.bound', key, sessionId, assignee: key === MIRA ? MIRA : 'coordinator' })
    driver.registerScoped({ id: sessionId, ctx: { on: () => () => {}, systemPrompt: { section() {} } }, session: { requestHeader: () => undefined } })
    return renamed
  }
  // The personal assistant's conversation, and a project's memory assistant.
  assert.deepEqual(comesUp(f.hubStore, HUB_ID, MIRA, `${OLD} 总管 · ${OLD}`), [PERSONAL_NAME])
  assert.deepEqual(comesUp(f.store, 'p_old', MIRA, `老项目 · ${OLD}`), ['老项目的记忆助理'])
  // The `项目 · 成员` shape of before 2026-11-15 gets today's title too: the project conversation is the project's name.
  assert.deepEqual(comesUp(f.store, 'p_old', MIRA, '老项目 · 记忆助理'), ['老项目的记忆助理'])
  assert.deepEqual(comesUp(f.store, 'p_old', COORDINATOR, '老项目 · 项目助理'), ['老项目'])
  // Already today's, the owner's own title, no title yet, or another member's Session: left alone.
  assert.deepEqual(comesUp(f.hubStore, HUB_ID, MIRA, PERSONAL_NAME), [])
  assert.deepEqual(comesUp(f.hubStore, HUB_ID, MIRA, '我的助理'), [])
  assert.deepEqual(comesUp(f.store, 'p_old', MIRA, undefined), [])
  assert.deepEqual(comesUp(f.store, 'p_old', COORDINATOR, `聊聊 · ${OLD}`), [])
  // A new conversation is named with today's names from the start.
  const named = []
  const driver = new Driver({ logger: { warn() {} }, get: () => ({ rename: (_session, title) => { named.push(title) } }) }, f.store, c => c)
  driver.nameSession({ id: 's-hub', session: {} }, f.hubStore.get(HUB_ID), undefined, f.hubStore.get(HUB_ID).members.find(m => m.id === MIRA))
  driver.nameSession({ id: 's-mem', session: {} }, f.store.get('p_old'), undefined, f.store.get('p_old').members.find(m => m.id === MIRA))
  assert.deepEqual(named, [PERSONAL_NAME, '老项目的记忆助理'])
})
