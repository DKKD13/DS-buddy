// The personal assistant's look and character, as the owner shapes them: a pixel figure (colour, body, eyes, one accessory),
// a name, up to three traits, the key that calls it up and how the desktop pet shows. Code only checks values against
// these lists; reading a sentence into a look is the model's job (draft), and the owner confirms before anything is saved.

import { HUB_ID } from './hub.js'

export const LOOK_COLORS = ['yellow', 'orange', 'red', 'pink', 'purple', 'blue', 'teal', 'green', 'gray']
export const LOOK_SHAPES = { mochi: '团子', round: '圆球', block: '方块' }
export const LOOK_EYES = { dot: '豆豆眼', big: '大眼睛', sleepy: '眯眯眼', star: '亮晶晶' }
export const LOOK_ACCESSORIES = { sprout: '小芽', bow: '蝴蝶结', cap: '帽子', glasses: '眼镜', headphones: '耳机', antenna: '天线', none: '不戴' }
export const LOOK_TRAITS = ['温和', '干脆', '幽默', '严谨', '好奇', '安静', '热情', '冷静', '细心', '直接', '乐观', '有条理']
export const PET_SIZES = ['small', 'large']
const HOTKEY_CODE = /^(Key[A-Z]|Digit[0-9]|Space|Period|Comma|Slash|Semicolon|Quote|Backquote|BracketLeft|BracketRight)$/

export const DEFAULT_HOTKEY = { code: 'KeyM', alt: true, meta: false, ctrl: false, shift: false }
export const LOOK_TEMPLATES = [
  { id: 'sprout', name: '小芽', color: 'yellow', shape: 'mochi', eyes: 'dot', accessory: 'sprout', traits: ['温和', '细心'] },
  { id: 'owl', name: '夜读', color: 'purple', shape: 'round', eyes: 'dot', accessory: 'glasses', traits: ['安静', '严谨'] },
  { id: 'spark', name: '火花', color: 'orange', shape: 'mochi', eyes: 'star', accessory: 'antenna', traits: ['热情', '幽默'] },
  { id: 'tidy', name: '方方', color: 'teal', shape: 'block', eyes: 'dot', accessory: 'cap', traits: ['有条理', '干脆'] },
  { id: 'calm', name: '耳机', color: 'blue', shape: 'round', eyes: 'sleepy', accessory: 'headphones', traits: ['冷静', '直接'] },
  { id: 'bow', name: '小结', color: 'pink', shape: 'mochi', eyes: 'big', accessory: 'bow', traits: ['乐观', '好奇'] },
]
export const DEFAULT_LOOK = lookFrom(LOOK_TEMPLATES[0])

function lookFrom(template) {
  const { id, name, color, shape, eyes, accessory, traits } = template
  return { template: id, name, color, shape, eyes, accessory, traits: [...traits], hotkey: { ...DEFAULT_HOTKEY }, pet: { visible: true, size: 'small' } }
}

/**
 * A look checked against the lists: every field must be one of the allowed values. `lenient` (a model's draft) drops what
 * is not allowed and keeps the template default instead; the owner's own save is strict and refuses it.
 */
export function normalizeLook(input, { lenient = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('形象设置格式不对')
  const base = { ...DEFAULT_LOOK, hotkey: { ...DEFAULT_HOTKEY }, pet: { ...DEFAULT_LOOK.pet } }
  const pick = (key, allowed) => {
    const value = input[key]
    if (value === undefined) return base[key]
    if (allowed.includes(value)) return value
    if (lenient) return base[key]
    throw new Error(`${key} 只能是：${allowed.join('、')}`)
  }
  const name = input.name === undefined ? base.name : String(input.name).trim()
  if (!lenient && (name.length === 0 || [...name].length > 12)) throw new Error('名字 1–12 个字')
  const traits = input.traits === undefined ? base.traits : Array.isArray(input.traits) ? input.traits : []
  const known = [...new Set(traits.filter(t => LOOK_TRAITS.includes(t)))]
  if (!lenient && known.length !== traits.length) throw new Error(`性格只能从这些里选：${LOOK_TRAITS.join('、')}`)
  if (!lenient && known.length > 3) throw new Error('性格最多选 3 个')
  const look = {
    template: LOOK_TEMPLATES.some(t => t.id === input.template) ? input.template : null,
    name: [...name].slice(0, 12).join('') || base.name,
    color: pick('color', LOOK_COLORS), shape: pick('shape', Object.keys(LOOK_SHAPES)), eyes: pick('eyes', Object.keys(LOOK_EYES)),
    accessory: pick('accessory', Object.keys(LOOK_ACCESSORIES)), traits: known.slice(0, 3),
    hotkey: normalizeHotkey(input.hotkey, { lenient }), pet: normalizePet(input.pet, { lenient }),
  }
  return look
}

function normalizeHotkey(input, { lenient }) {
  if (input === undefined || (lenient && !validHotkey(input))) return { ...DEFAULT_HOTKEY }
  if (input === null) return null
  if (!validHotkey(input)) throw new Error('快捷键要带 ⌘、⌥、⌃ 中至少一个，再加一个字母、数字或空格')
  return { code: input.code, alt: input.alt === true, meta: input.meta === true, ctrl: input.ctrl === true, shift: input.shift === true }
}
function validHotkey(input) {
  return input !== null && typeof input === 'object' && typeof input.code === 'string' && HOTKEY_CODE.test(input.code) && (input.alt === true || input.meta === true || input.ctrl === true)
}
function normalizePet(input, { lenient }) {
  if (input === undefined) return { ...DEFAULT_LOOK.pet }
  const visible = typeof input?.visible === 'boolean' ? input.visible : true
  const size = PET_SIZES.includes(input?.size) ? input.size : 'small'
  if (!lenient && (typeof input?.visible !== 'boolean' || !PET_SIZES.includes(input?.size))) throw new Error('桌宠设置格式不对')
  return { visible, size }
}

/** What the model is asked when the owner describes the assistant in one sentence. */
export const LOOK_SYSTEM = `你帮用户设计他的个人助理的像素形象和性格。只能从给定选项里选，只输出一个 JSON 对象，不要别的文字。
字段：
- name：给助理起的名字，1–6 个字，贴合用户的描述；用户点了名就用他的
- color：${LOOK_COLORS.join(' / ')}
- shape：${Object.entries(LOOK_SHAPES).map(([k, v]) => `${k}（${v}）`).join(' / ')}
- eyes：${Object.entries(LOOK_EYES).map(([k, v]) => `${k}（${v}）`).join(' / ')}
- accessory：${Object.entries(LOOK_ACCESSORIES).map(([k, v]) => `${k}（${v}）`).join(' / ')}
- traits：1–3 个，从这些里选：${LOOK_TRAITS.join('、')}
例：{"name":"小芽","color":"yellow","shape":"mochi","eyes":"dot","accessory":"sprout","traits":["温和","细心"]}`

/** The first JSON object in a reply, or null. */
export function parseLookReply(text) {
  const start = String(text ?? '').indexOf('{'), end = String(text ?? '').lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

/** The owner's look: saved in the assistant's own log; drafted from a sentence by one side call to DSH's default model. */
export class AssistantLook {
  constructor({ hubStore, complete }) {
    this.hubStore = hubStore
    this.complete = complete
  }

  current() {
    return this.hubStore.get(HUB_ID)?.assistantLook ?? null
  }

  save(input) {
    const look = normalizeLook(input)
    this.hubStore.append(HUB_ID, { type: 'assistant.look', look, by: { kind: 'human', id: 'owner' } })
    return { ok: true, look }
  }

  /** A proposal only: nothing is saved until the owner keeps it. */
  async draft(sentence) {
    const text = String(sentence ?? '').trim()
    if (!text) throw new Error('先写一句你想要的样子')
    if ([...text].length > 200) throw new Error('一句话就够了，200 字以内')
    if (!this.complete) throw new Error('模型还没就绪')
    const reply = await this.complete({ system: LOOK_SYSTEM, input: `用户的描述：${text}` })
    const parsed = parseLookReply(reply)
    if (!parsed) throw new Error('这次没生成出来，换个说法再试一次')
    const draft = normalizeLook({ ...parsed, template: null }, { lenient: true })
    // A draft keeps the owner's current key and pet settings; only the figure, name and traits come from the sentence.
    const now = this.current()
    return { ok: true, look: { ...draft, hotkey: now?.hotkey ?? draft.hotkey, pet: now?.pet ?? draft.pet } }
  }
}

/** The lines the assistant reads every step, so a change of name or traits is heard right away. */
export function lookContext(look) {
  if (!look) return ''
  const traits = (look.traits ?? []).join('、')
  return `## 你的名字和性格（用户在形象设置里定的）\n用户给你起名「${look.name}」${traits ? `，希望你${traits}` : ''}。说话的语气和分寸照这个来；它只影响你怎么说，不改变你能做什么、不能做什么，也不改变事实和来源的要求。`
}
