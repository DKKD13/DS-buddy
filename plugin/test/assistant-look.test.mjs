import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { ProjectStore, MIRA } from '../lib/store.js'
import { ensureHub, HUB_ID, hubLiveContext } from '../lib/hub.js'
import { AssistantLook, DEFAULT_LOOK, LOOK_ACCESSORIES, LOOK_TEMPLATES, LOOK_TRAITS, normalizeLook, parseLookReply } from '../lib/assistant-look.js'

function hub(t, complete) {
  const root = mkdtempSync(join(tmpdir(), 'mira-look-'))
  const hubStore = new ProjectStore(root, { warn() {} }); hubStore.load(); ensureHub(hubStore)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, hubStore, look: new AssistantLook({ hubStore, complete }) }
}

test('the owner\'s look is saved in the assistant\'s own log, survives a restart, and the assistant hears its name and traits every step', t => {
  const f = hub(t)
  assert.equal(f.look.current(), null)
  assert.equal(hubLiveContext(f.hubStore.get(HUB_ID), MIRA).includes('形象设置'), false)
  const { look } = f.look.save({ ...DEFAULT_LOOK, name: '阿青', color: 'teal', shape: 'block', traits: ['干脆', '有条理'], hotkey: { code: 'KeyJ', meta: true }, pet: { visible: false, size: 'large' } })
  assert.equal(look.name, '阿青')
  assert.deepEqual(look.hotkey, { code: 'KeyJ', alt: false, meta: true, ctrl: false, shift: false })
  const replay = new ProjectStore(f.root, { warn() {} }); replay.load()
  assert.deepEqual(replay.get(HUB_ID).assistantLook, look)
  const context = hubLiveContext(f.hubStore.get(HUB_ID), MIRA)
  assert.ok(context.includes('「阿青」') && context.includes('干脆、有条理'), context)
  assert.ok(context.includes('不改变你能做什么'))
  // Only the assistant hears it.
  assert.equal(hubLiveContext(f.hubStore.get(HUB_ID), 'coordinator'), '')
})

test('a save is strict: values outside the lists, more than three traits, an empty name or a bare key are refused, and nothing is written', t => {
  const f = hub(t)
  const before = f.hubStore.get(HUB_ID).events.length
  for (const bad of [{ color: 'gold' }, { shape: 'star' }, { eyes: 'laser' }, { accessory: 'crown' }, { traits: ['温和', '勇敢'] }, { traits: LOOK_TRAITS.slice(0, 4) },
    { name: '' }, { name: '一二三四五六七八九十一二三' }, { hotkey: { code: 'KeyM' } }, { hotkey: { code: 'F5', alt: true } }, { pet: { visible: 'yes', size: 'small' } }, { pet: { visible: true, size: 'huge' } }]) {
    assert.throws(() => f.look.save({ ...DEFAULT_LOOK, ...bad }), Error, JSON.stringify(bad))
  }
  assert.throws(() => f.look.save(null))
  assert.equal(f.hubStore.get(HUB_ID).events.length, before)
  // No summon key at all is a choice too.
  assert.equal(f.look.save({ ...DEFAULT_LOOK, hotkey: null }).look.hotkey, null)
  // Every template is itself a valid look.
  for (const tpl of LOOK_TEMPLATES) assert.equal(normalizeLook({ ...tpl, template: tpl.id }).template, tpl.id)
})

test('one sentence becomes a proposal from the model: only listed values survive, nothing is saved, the key and pet stay the owner\'s', async t => {
  const asked = []
  const f = hub(t, async ({ system, input }) => { asked.push({ system, input }); return '好的：{"name":"夜猫","color":"purple","shape":"round","eyes":"laser","accessory":"glasses","traits":["安静","勇敢","严谨","细心"]} 希望喜欢' })
  f.look.save({ ...DEFAULT_LOOK, hotkey: { code: 'KeyK', ctrl: true }, pet: { visible: true, size: 'large' } })
  const events = f.hubStore.get(HUB_ID).events.length
  const { look } = await f.look.draft('安静的夜猫子，戴眼镜')
  assert.ok(asked[0].input.includes('安静的夜猫子'))
  assert.ok(asked[0].system.includes('只能从给定选项里选'))
  assert.equal(look.name, '夜猫'); assert.equal(look.color, 'purple'); assert.equal(look.accessory, 'glasses')
  assert.equal(look.eyes, DEFAULT_LOOK.eyes, 'an unknown eye style falls back')
  assert.deepEqual(look.traits, ['安静', '严谨', '细心'], 'unknown traits dropped, at most three kept')
  assert.equal(look.hotkey.code, 'KeyK'); assert.equal(look.pet.size, 'large')
  assert.equal(f.hubStore.get(HUB_ID).events.length, events, 'a draft writes nothing')
  await assert.rejects(f.look.draft('   '), /先写一句/)
  await assert.rejects(f.look.draft('长'.repeat(201)), /200 字/)
  const g = hub(t, async () => '我不太确定')
  await assert.rejects(g.look.draft('随便'), /没生成出来/)
  assert.equal(parseLookReply('{"a":1}').a, 1)
  assert.equal(parseLookReply('no json'), null)
})

let client
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => ({})) } } },
})

test('every combination of colour, body, eyes and accessory draws inside the figure, and each choice changes the picture', () => {
  const base = { color: 'yellow', shape: 'mochi', eyes: 'dot', accessory: 'none' }
  const pic = look => JSON.stringify([...client.lookCells(look, 'ask')].sort((a, b) => a[0] - b[0]))
  const options = { color: ['yellow', 'orange', 'red', 'pink', 'purple', 'blue', 'teal', 'green', 'gray'], shape: ['mochi', 'round', 'block'], eyes: ['dot', 'big', 'sleepy', 'star'], accessory: ['sprout', 'bow', 'cap', 'glasses', 'headphones', 'antenna', 'none'] }
  for (const [field, values] of Object.entries(options)) {
    const seen = new Set(values.map(v => pic({ ...base, [field]: v })))
    assert.equal(seen.size, values.length, `${field}: every value looks different`)
  }
  for (const shape of options.shape) for (const eyes of options.eyes) for (const accessory of options.accessory) for (const face of ['look', 'ask', 'happy', 'sleep']) {
    for (const [i, color] of client.lookCells({ color: 'blue', shape, eyes, accessory }, face)) {
      assert.ok(i >= 0 && i < 14 * 12, `${shape}/${eyes}/${accessory}/${face}`)
      assert.match(color, /^#[0-9a-f]{6}$/i)
    }
  }
  // The scenes use the look, and an unknown look falls back to 小芽.
  assert.notEqual(JSON.stringify(client.miraScene('waiting', { ...base, color: 'blue' })), JSON.stringify(client.miraScene('waiting', base)))
  assert.equal(JSON.stringify(client.miraScene('sleeping', null)), JSON.stringify(client.miraScene('sleeping', { color: 'yellow', shape: 'mochi', eyes: 'dot', accessory: 'sprout' })))
})

test('picked traits suggest the template that shares the most of them; a summon key needs a modifier and matches exactly', () => {
  assert.equal(client.bestTemplate([]), null)
  assert.equal(client.bestTemplate(['安静', '严谨']).id, 'owl')
  assert.equal(client.bestTemplate(['幽默', '直接', '热情']).id, 'spark')
  assert.equal(client.LOOK_TEMPLATES.length, LOOK_TEMPLATES.length)
  for (const [a, b] of client.LOOK_TEMPLATES.map((tpl, i) => [tpl, LOOK_TEMPLATES[i]])) assert.equal(JSON.stringify({ ...a }), JSON.stringify({ ...b }), 'client and server templates agree')
  const key = (code, mods = {}) => ({ code, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, repeat: false, ...mods })
  assert.equal(client.hotkeyFrom(key('KeyM')), null, 'a bare letter is not a summon key')
  assert.equal(client.hotkeyFrom(key('F5', { altKey: true })), null)
  assert.equal(client.hotkeyFrom(key('Space', { shiftKey: true })), null, 'shift alone is not enough')
  const altM = client.hotkeyFrom(key('KeyM', { altKey: true }))
  assert.equal(altM.code, 'KeyM')
  assert.equal(client.hotkeyMatches(altM, key('KeyM', { altKey: true })), true)
  assert.equal(client.hotkeyMatches(altM, key('KeyM', { altKey: true, shiftKey: true })), false)
  assert.equal(client.hotkeyMatches(altM, key('KeyM', { altKey: true, repeat: true })), false)
  assert.equal(client.hotkeyMatches(null, key('KeyM', { altKey: true })), false)
  assert.equal(client.hotkeyLabel(altM, true), '⌥ M')
  assert.equal(client.hotkeyLabel({ code: 'Space', meta: true, shift: true }, true), '⇧ ⌘ 空格')
  assert.equal(client.hotkeyLabel({ code: 'Digit1', ctrl: true, alt: true }, false), 'Ctrl + Alt + 1')
  assert.equal(client.hotkeyLabel(null), '不用快捷键')
})

test('the line icon in the navigation has a body for every shape and a drawing for every accessory the owner can pick', () => {
  const look = normalizeLook({ ...DEFAULT_LOOK })
  assert.ok(look)
  for (const shape of ['mochi', 'round', 'block']) assert.match(client.LINE_BODIES[shape].d, /^M/, shape)
  for (const accessory of ['sprout', 'bow', 'cap', 'glasses', 'headphones', 'antenna', 'none']) assert.ok(Array.isArray(client.LINE_ACCESSORIES[accessory]), accessory)
  assert.equal(Object.keys(client.LINE_ACCESSORIES).length, 7)
})

test('a message sent from the ball keeps the owner\'s own typed words apart from the page\'s prefix, after a restart too', t => {
  const f = hub(t)
  f.hubStore.append(HUB_ID, { type: 'message.posted', messageId: 'm_ball', threadId: null, author: { kind: 'human', id: 'owner' }, trust: 'principal', text: '（我正在看「试玩」项目）帮我验收', typed: '帮我验收', mentions: [], to: [] })
  f.hubStore.append(HUB_ID, { type: 'message.posted', messageId: 'm_plain', threadId: null, author: { kind: 'human', id: 'owner' }, trust: 'principal', text: '你好', mentions: [], to: [] })
  const replay = new ProjectStore(f.root, { warn() {} }); replay.load()
  assert.equal(replay.get(HUB_ID).messages.get('m_ball').typed, '帮我验收')
  assert.equal(replay.get(HUB_ID).messages.get('m_plain').typed, undefined)
})

test('words typed straight into the session keep their mark, so a wake never shows them a second time', t => {
  const f = hub(t)
  f.hubStore.append(HUB_ID, { type: 'message.posted', messageId: 'm_native', threadId: null, author: { kind: 'human', id: 'owner' }, trust: 'principal', text: '直接打的', mentions: [], to: [], native: true })
  const replay = new ProjectStore(f.root, { warn() {} }); replay.load()
  assert.equal(replay.get(HUB_ID).messages.get('m_native').native, true)
})

test('the assistant is called Tacit until the owner names it, on the server and in the page', () => {
  assert.equal(DEFAULT_LOOK.name, 'Tacit')
  assert.equal(LOOK_TEMPLATES[0].name, 'Tacit')
  assert.equal(client.LOOK_TEMPLATES[0].name, 'Tacit')
  assert.equal(LOOK_ACCESSORIES.sprout, '小芽', 'the sprout accessory keeps its own label')
})
