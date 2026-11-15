import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore } from '../lib/store.js'
import { Actions } from '../lib/actions.js'
import { ProjectIcons, parseIcon, ownerIcon, PROJECT_COLORS, PROJECT_ICONS, ICON_SYSTEM } from '../lib/project-icons.js'
import { ensureHub } from '../lib/hub.js'

function setup(t, answers = []) {
  const root = mkdtempSync(join(tmpdir(), 'mira-icons-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new ProjectStore(root, { warn() {} }); store.load()
  const driver = { deliver() {}, status: () => 'idle', childrenOf: () => [], memberModel: () => null }
  const actions = new Actions(store, driver)
  const asked = []
  const complete = async request => { asked.push(request); const next = answers.shift(); if (next instanceof Error) throw next; return next ?? '' }
  const icons = new ProjectIcons({ store, complete, logger: { warn() {} } })
  return { root, store, actions, icons, asked }
}

test('the model\'s answer is used only when the icon is in the library and the colour is in the list', () => {
  assert.deepEqual(parseIcon('{"icon":"book-open","color":"green"}'), { icon: 'book-open', color: 'green' })
  assert.deepEqual(parseIcon('好的：{"icon":"palette","color":"orange"} 就这样'), { icon: 'palette', color: 'orange' })
  assert.equal(parseIcon('{"icon":"book-open","color":"black"}'), null)
  assert.equal(parseIcon('{"icon":"📚","color":"green"}'), null, 'an emoji is not a library icon')
  assert.equal(parseIcon('{"icon":"Book-Open","color":"green"}'), null)
  assert.equal(parseIcon('{"icon":"book","color":"green"}'), null)
  assert.equal(parseIcon('not json'), null)
  assert.equal(parseIcon('{broken'), null)
  assert.equal(parseIcon(undefined), null)
  assert.equal(PROJECT_COLORS.length, 9)
  assert.equal(PROJECT_ICONS.length, 40)
  assert.equal(new Set(PROJECT_ICONS).size, 40)
  // The model is shown the whole library by name.
  for (const name of PROJECT_ICONS) assert.ok(ICON_SYSTEM.includes(name), name)
  assert.match(ICON_SYSTEM, /一律不理/)
})

test('a project without an icon gets one from the model, once; the pick survives a restart and does not wake anyone', async t => {
  const s = setup(t, ['{"icon":"book-open","color":"green"}', '{"icon":"palette","color":"orange"}'])
  const a = s.actions.createProject({ name: '学习', instructions: '每天读论文\n第二行不送' }).projectId
  const b = s.actions.createProject({ name: '设计打磨' }).projectId
  await s.icons.tick()
  assert.deepEqual([s.store.get(a).icon, s.store.get(a).color], ['book-open', 'green'])
  assert.deepEqual([s.store.get(b).icon, s.store.get(b).color], ['palette', 'orange'])
  // The model saw the name and the instructions as data.
  assert.match(s.asked[0].input, /项目名：学习\n项目说明：每天读论文/)
  assert.equal(s.asked[0].system, ICON_SYSTEM)
  assert.match(s.asked[1].input, /项目说明：（无）/)
  // Nothing more to pick.
  await s.icons.tick()
  assert.equal(s.asked.length, 2)
  const event = s.store.get(a).events.findLast(e => e.type === 'project.icon')
  assert.deepEqual(event.by, { kind: 'assistant' })
  assert.equal(event.to, undefined)
  const replay = new ProjectStore(s.root, { warn() {} }); replay.load()
  assert.deepEqual([replay.get(a).icon, replay.get(a).color], ['book-open', 'green'])
})

test('a bad answer or a failing model leaves the default look, and the project is not asked again until restart', async t => {
  const s = setup(t, ['{"icon":"学习","color":"green"}', new Error('model down')])
  const a = s.actions.createProject({ name: '甲' }).projectId
  const b = s.actions.createProject({ name: '乙' }).projectId
  await s.icons.tick()
  assert.equal(s.store.get(a).icon, undefined)
  assert.equal(s.store.get(b).icon, undefined)
  await s.icons.tick()
  assert.equal(s.asked.length, 2)
  // A fresh process tries again.
  const again = new ProjectIcons({ store: s.store, complete: async () => '{"icon":"flask-conical","color":"teal"}' })
  await again.tick()
  assert.equal(s.store.get(a).icon, 'flask-conical')
})

test('at most two projects per round, and the personal assistant\'s own log and the trash are never asked about', async t => {
  const s = setup(t, [['folder', 'gray'], ['package', 'red'], ['database', 'orange'], ['layers', 'yellow']].map(([icon, color]) => JSON.stringify({ icon, color })))
  ensureHub(s.store)
  const ids = ['一', '二', '三'].map(name => s.actions.createProject({ name }).projectId)
  const gone = s.actions.createProject({ name: '要删的' }).projectId
  await s.actions.deleteProject({ projectId: gone })
  await s.icons.tick()
  assert.equal(s.asked.length, 2)
  await s.icons.tick()
  assert.equal(s.asked.length, 3)
  assert.deepEqual(ids.map(id => s.store.get(id).icon), ['folder', 'package', 'database'])
  assert.ok(!s.asked.some(r => /要删的/.test(r.input)))
  await s.icons.tick()
  assert.equal(s.asked.length, 3)
})

test('the owner\'s choice is checked, saved, and never replaced by the model, even one already asking', async t => {
  const s = setup(t)
  const a = s.actions.createProject({ name: '求职' }).projectId
  assert.throws(() => s.actions.setProjectIcon({ projectId: a, icon: '求职', color: 'blue' }), /图标库/)
  assert.throws(() => s.actions.setProjectIcon({ projectId: a, icon: '💼', color: 'blue' }), /图标库/)
  assert.throws(() => s.actions.setProjectIcon({ projectId: a, icon: 'briefcase', color: 'black' }), /颜色/)
  assert.throws(() => s.actions.setProjectIcon({ projectId: 'p_none', icon: 'briefcase', color: 'blue' }), /没有这个项目/)
  ensureHub(s.store)
  assert.throws(() => s.actions.setProjectIcon({ projectId: 'hub', icon: 'briefcase', color: 'blue' }), /个人助理/)
  assert.deepEqual(s.actions.setProjectIcon({ projectId: a, icon: 'briefcase', color: 'blue' }), { ok: true, icon: 'briefcase', color: 'blue' })
  assert.deepEqual(s.store.get(a).events.findLast(e => e.type === 'project.icon').by, { kind: 'human', id: 'owner' })
  assert.deepEqual(ownerIcon({ icon: 'brain', color: 'pink' }), { icon: 'brain', color: 'pink' })
  // Already has one: the model is not asked.
  await s.icons.tick()
  assert.equal(s.asked.length, 0)
  // The owner picks while the model is answering: the owner's stays.
  const b = s.actions.createProject({ name: '记忆实验' }).projectId
  let release
  const slow = new ProjectIcons({ store: s.store, complete: () => new Promise(resolve => { release = resolve }) })
  const round = slow.tick()
  await new Promise(r => setTimeout(r, 5))
  s.actions.setProjectIcon({ projectId: b, icon: 'brain', color: 'purple' })
  release('{"icon":"folder","color":"gray"}')
  await round
  assert.deepEqual([s.store.get(b).icon, s.store.get(b).color], ['brain', 'purple'])
  assert.equal(s.store.get(b).events.filter(e => e.type === 'project.icon').length, 1)
})

test('icons tell projects apart: the model is told which are taken, a taken pick is retried once, and a model-picked clash is re-picked', async t => {
  const s = setup(t, ['{"icon":"search","color":"blue"}', '{"icon":"search","color":"teal"}', '{"icon":"compass","color":"teal"}'])
  const a = s.actions.createProject({ name: '开源研究' }).projectId
  const b = s.actions.createProject({ name: '竞品研究' }).projectId
  await s.icons.tick()
  assert.equal(s.store.get(a).icon, 'search')
  // The second project was told search is taken; it answered search anyway, was asked once more, and took compass.
  assert.match(s.asked[0].input, /选一个不一样的：（还没有）/)
  assert.match(s.asked[1].input, /选一个不一样的：search/)
  assert.match(s.asked[2].input, /你刚才选的图标 search已经被别的项目用了/)
  assert.equal(s.store.get(b).icon, 'compass')
  // A second clash is given up: the project keeps its stand-in.
  const c = s.actions.createProject({ name: '第三个研究' }).projectId
  const stubborn = new ProjectIcons({ store: s.store, complete: async () => '{"icon":"search","color":"blue"}' })
  await stubborn.tick()
  assert.equal(s.store.get(c).icon, undefined)
  // Two projects already wearing the same model-picked icon (picked before this check existed): the later one is re-picked.
  const d = s.actions.createProject({ name: '旧的重复' }).projectId
  s.store.append(d, { type: 'project.icon', icon: 'search', color: 'blue', by: { kind: 'assistant' } })
  const answers = [['globe', 'green'], ['target', 'yellow']].map(([icon, color]) => JSON.stringify({ icon, color }))
  const fixer = new ProjectIcons({ store: s.store, complete: async () => answers.shift() })
  await fixer.tick()
  assert.equal(s.store.get(a).icon, 'search', 'the first one keeps it')
  assert.equal(s.store.get(c).icon, 'globe', 'a fresh process asks again for the one that gave up')
  assert.equal(s.store.get(d).icon, 'target', 'the later twin is re-picked')
  // An icon the owner picked is never re-picked, even when another project wears it; it wins over a model-picked twin.
  s.actions.setProjectIcon({ projectId: c, icon: 'compass', color: 'pink' })
  const again = new ProjectIcons({ store: s.store, complete: async () => '{"icon":"rocket","color":"purple"}' })
  await again.tick()
  assert.deepEqual([s.store.get(c).icon, s.store.get(c).color], ['compass', 'pink'])
  assert.equal(s.store.get(b).icon, 'rocket', 'the model-picked twin of an owner pick moves')
  assert.equal(s.store.get(c).iconBy, 'human')
  assert.equal(s.store.get(d).iconBy, 'assistant')
})

test('an emoji the model picked before the library is replaced by a library icon; one the owner picked stays', async t => {
  const s = setup(t, ['{"icon":"search","color":"blue"}', '{"icon":"brain","color":"purple"}'])
  const a = s.actions.createProject({ name: '开源研究' }).projectId
  const b = s.actions.createProject({ name: '手选的' }).projectId
  s.store.append(a, { type: 'project.icon', icon: '🔍', color: 'blue', by: { kind: 'assistant' } })
  s.store.append(b, { type: 'project.icon', icon: '🧠', color: 'purple', by: { kind: 'human', id: 'owner' } })
  await s.icons.tick()
  assert.deepEqual([s.store.get(a).icon, s.store.get(a).iconBy], ['search', 'assistant'])
  assert.deepEqual([s.store.get(b).icon, s.store.get(b).iconBy], ['🧠', 'human'])
  assert.equal(s.asked.length, 1)
})

test('colours tell projects apart too: the free ones are named, a taken colour is retried once, then the first free one is used; repeats only once all nine are used', async t => {
  const s = setup(t, ['{"icon":"book-open","color":"teal"}', '{"icon":"brain","color":"teal"}', '{"icon":"brain","color":"teal"}'])
  const make = name => s.actions.createProject({ name }).projectId
  const a = make('学习'), b = make('记忆')
  await s.icons.tick()
  assert.equal(s.store.get(a).color, 'teal')
  assert.match(s.asked[0].input, /还没人用的颜色：gray red orange yellow green teal blue purple pink/)
  assert.match(s.asked[1].input, /还没人用的颜色：gray red orange yellow green blue purple pink/)
  assert.match(s.asked[2].input, /你刚才选的颜色 teal已经被别的项目用了/)
  assert.deepEqual([s.store.get(b).icon, s.store.get(b).color], ['brain', 'gray'], 'still taken after the retry: the first free colour')
  // A model-picked colour twin from before is re-picked.
  const k = make('写代码')
  s.store.append(k, { type: 'project.icon', icon: 'code', color: 'teal', by: { kind: 'assistant' } })
  await new ProjectIcons({ store: s.store, complete: async () => '{"icon":"code","color":"red"}' }).tick()
  assert.deepEqual([s.store.get(k).icon, s.store.get(k).color], ['code', 'red'])
  // Once all nine colours are in use, a repeat is fine and nobody is re-picked for it.
  for (const [i, color] of ['orange', 'yellow', 'green', 'blue', 'purple', 'pink'].entries()) s.store.append(make('填色' + i), { type: 'project.icon', icon: ['film', 'plane', 'house', 'coins', 'heart', 'globe'][i], color, by: { kind: 'assistant' } })
  const j = make('第十个')
  const last = []
  await new ProjectIcons({ store: s.store, complete: async r => { last.push(r); return '{"icon":"rocket","color":"teal"}' } }).tick()
  assert.deepEqual([s.store.get(j).icon, s.store.get(j).color], ['rocket', 'teal'])
  assert.equal(last.length, 1)
  assert.match(last[0].input, /都用过了，随便选/)
  // Two projects now share teal, but with every colour in use that is not a clash: nobody is asked again.
  const quiet = []
  await new ProjectIcons({ store: s.store, complete: async r => { quiet.push(r); return '{"icon":"bot","color":"gray"}' } }).tick()
  assert.equal(quiet.length, 0)
})

test('a colour the owner picked wins over a model-picked twin made earlier', async t => {
  const s = setup(t)
  const early = s.actions.createProject({ name: '早的' }).projectId
  const mine = s.actions.createProject({ name: '我的' }).projectId
  s.store.append(early, { type: 'project.icon', icon: 'film', color: 'pink', by: { kind: 'assistant' } })
  s.actions.setProjectIcon({ projectId: mine, icon: 'headphones', color: 'pink' })
  await new ProjectIcons({ store: s.store, complete: async () => '{"icon":"film","color":"orange"}' }).tick()
  assert.deepEqual([s.store.get(early).icon, s.store.get(early).color], ['film', 'orange'])
  assert.deepEqual([s.store.get(mine).icon, s.store.get(mine).color], ['headphones', 'pink'])
})
