/**
 * v4: how the personal assistant reads files on the owner's own computer. This machine cannot reach that computer.
 * A small reader there (mac-reader.mjs) dials in through the device entrance, waits, and answers one read request at
 * a time: the shape of Claude Code's Remote Control and Codex's remote hosts, where the computer dials out and
 * nothing dials in. This side only carries the request and the answer. Which folders may be read is decided on the
 * computer; nothing here can widen it. Only the assistant's tool asks; the web page can look at the state and choose a
 * mode within what the computer offers: off (paused), on (the listed folders only) or all (also the whole home folder,
 * if the computer offers it).
 */
import { randomUUID } from 'node:crypto'

const HUB_ID = 'hub'
export const MAC_FILE_OPS = ['roots', 'list', 'search', 'read']
export const MAC_FILE_MODES = ['on', 'all', 'off']
const TEXTS = ['root', 'path', 'query', 'name', 'since', 'until'], NUMBERS = ['offset', 'limit', 'max_bytes']
const ROOT_NAME = /^[a-z][a-z0-9-]{0,31}$/

/** The owner's switch: on (listed folders, the default), all (also the whole home folder) or off. */
export function macFilesMode(hub) {
  const set = (hub?.events ?? []).filter(e => e.type === 'macfiles.mode').at(-1)
  return MAC_FILE_MODES.includes(set?.mode) ? set.mode : 'on'
}

const HINTS = {
  paused: '用户在「助理设置 → 电脑文件」里暂停了读取。如实告诉用户要先在那里恢复，不要换别的办法去读。',
  folders: '用户现在只放行了指定的几个文件夹。要读个人目录里的其他文件，如实告诉用户：在「助理设置 → 电脑文件」切换到「全部文件」。不要换别的办法去读。',
  offline: '现在连不上用户的电脑：电脑可能关机、睡眠或断网，或者电脑上的读取器没有运行。如实告诉用户，等电脑开着再试，不要换别的办法去读。',
  timeout: '电脑没有在限定时间内回应，可能刚睡眠或断网。可以稍后再试一次；还不行就如实告诉用户。',
}

export class MacFiles {
  constructor({ hubStore, holdMs = 25_000, timeoutMs = 45_000, maxChars = 40_000, now = Date.now }) {
    Object.assign(this, { hubStore, holdMs, timeoutMs, maxChars, now })
    /** The reader that polled last: { deviceId, name, roots, seenAt }. */
    this.node = null
    /** That reader's open poll, waiting for work. */
    this.waiter = null
    /** Requests no poll has picked up yet (the reader is busy with another one). */
    this.queue = []
    /** Requests handed to a reader and not answered yet, by id. */
    this.inflight = new Map()
    /** The last few requests, for the settings page. Kept in memory only. */
    this.recent = []
  }

  mode() { return macFilesMode(this.hubStore.get(HUB_ID)) }

  /** A reader counts as connected while its poll is open or it polled a moment ago. */
  connected() { return this.node !== null && (this.waiter !== null || this.now() - this.node.seenAt < this.holdMs + 20_000) }

  /** The reader's wait for work: answered at once when a request is queued, otherwise held open for a while. */
  poll(device, body, signal) {
    const roots = body?.roots
    if (!Array.isArray(roots) || roots.length > 20 || roots.some(root => !ROOT_NAME.test(root?.name ?? '') || typeof root.label !== 'string' || root.label.length > 60)) throw Error('roots 无效')
    this.node = { deviceId: device.deviceId, name: device.name, roots: roots.map(({ name, label, whole }) => ({ name, label, ...(whole === true ? { whole: true } : {}) })), seenAt: this.now() }
    // One reader at a time: an older open poll is let go.
    this.waiter?.give(null)
    const queued = this.queue.shift()
    if (queued) return { request: this.handOver(queued, device.deviceId) }
    return new Promise(resolve => {
      const waiter = { deviceId: device.deviceId, give: request => {
        clearTimeout(timer);signal?.removeEventListener('abort', release)
        if (this.waiter === waiter) this.waiter = null
        resolve({ request })
      } }
      const release = () => waiter.give(null)
      const timer = setTimeout(release, this.holdMs)
      timer.unref?.()
      signal?.addEventListener('abort', release, { once: true })
      this.waiter = waiter
    })
  }

  handOver(item, deviceId) {
    this.inflight.set(item.id, { deviceId, settle: item.settle })
    return { id: item.id, op: item.op, args: item.args }
  }

  /** The reader's answer. Only the device that was handed the request may answer it. */
  result(device, body) {
    const pending = typeof body?.id === 'string' ? this.inflight.get(body.id) : undefined
    if (!pending || pending.deviceId !== device.deviceId) return { accepted: false }
    if (this.node?.deviceId === device.deviceId) this.node.seenAt = this.now()
    pending.settle(body.ok === true ? { ok: true, data: body.data } : { ok: false, error: typeof body.error === 'string' ? body.error : '读取失败' })
    return { accepted: true }
  }

  /**
   * One read, asked by the assistant's tool. Arguments are checked for shape only; what they mean, and whether the
   * path is allowed, is the reader's call. Not being able to read is an answer (ok:false with a hint), not an error.
   */
  async request(op, args = {}) {
    if (!MAC_FILE_OPS.includes(op)) throw new Error(`op 只能是 ${MAC_FILE_OPS.join('、')}`)
    const clean = {}
    for (const [key, value] of Object.entries(args ?? {})) {
      // A model fills parameters it does not use with "" or null: the same as leaving them out.
      if (value === undefined || value === null || value === '') continue
      if (TEXTS.includes(key)) { if (typeof value !== 'string' || value.length > 1000) throw new Error(`${key} 要是 1000 字以内的文字`) }
      else if (NUMBERS.includes(key)) { if (!Number.isInteger(value) || value < 0) throw new Error(`${key} 要是不小于 0 的整数`) }
      else throw new Error(`不接受参数 ${key}`)
      clean[key] = value
    }
    const started = this.now()
    const done = result => {
      this.recent.unshift({ at: new Date(started).toISOString(), op, root: clean.root, path: clean.path?.slice(0, 160), query: clean.query?.slice(0, 60), ok: result.ok, ...(result.ok ? {} : { error: result.error }), ms: this.now() - started })
      this.recent.length = Math.min(this.recent.length, 20)
      return result
    }
    for (const state of ['paused', 'offline']) if (state === 'paused' ? this.mode() === 'off' : !this.connected()) return done({ ok: false, error: state, hint: HINTS[state] })
    const wholeRoots = new Set(this.node.roots.filter(root => root.whole).map(root => root.name)), foldersOnly = this.mode() !== 'all'
    if (foldersOnly && wholeRoots.has(clean.root)) return done({ ok: false, error: 'folders_only', hint: HINTS.folders })
    const device = this.node.name
    const answer = await new Promise(resolve => {
      const item = { id: randomUUID(), op, args: clean, settle: value => {
        clearTimeout(timer);this.inflight.delete(item.id);this.queue = this.queue.filter(other => other !== item)
        resolve(value)
      } }
      const timer = setTimeout(() => item.settle(null), this.timeoutMs)
      timer.unref?.()
      const waiter = this.waiter
      if (waiter) waiter.give(this.handOver(item, waiter.deviceId))
      else this.queue.push(item)
    })
    if (!answer) return done({ ok: false, error: 'timeout', hint: HINTS.timeout })
    // The reader says why in its own words (no such folder, path outside the folder, a key file, too frequent).
    if (!answer.ok) return done({ ok: false, error: 'refused', hint: answer.error.slice(0, 300) })
    if (op === 'roots' && foldersOnly && Array.isArray(answer.data?.roots)) answer.data = { ...answer.data, roots: answer.data.roots.filter(root => !wholeRoots.has(root.name)) }
    const text = JSON.stringify(answer.data ?? null)
    return done(text.length > this.maxChars ? { ok: true, trust: 'untrusted', device, truncated: true, hint: '结果太长，只给了开头一部分；把 max_bytes 或 limit 调小再要一次', data: text.slice(0, this.maxChars) } : { ok: true, trust: 'untrusted', device, data: answer.data ?? null })
  }

  /** What the settings page shows: connected or not, which folders the computer offers, and the last few reads. */
  status() {
    return { mode: this.mode(), connected: this.connected(), device: this.node?.name ?? null, roots: this.node?.roots ?? [], whole: Boolean(this.node?.roots?.some(root => root.whole)),
      lastSeenAt: this.node ? new Date(this.node.seenAt).toISOString() : null, recent: this.recent }
  }

  /** The owner's pause switch on the settings page. It stops requests here; the hard switch is the reader itself. */
  setMode(mode) {
    if (!MAC_FILE_MODES.includes(mode)) throw new Error('只能是 on、all 或 off')
    if (!this.hubStore.get(HUB_ID)) throw new Error('个人助理还没有启用')
    this.hubStore.append(HUB_ID, { type: 'macfiles.mode', mode, by: 'owner' })
    return this.status()
  }

  /** On shutdown: let the open poll go and fail what is still waiting. */
  stop() {
    this.waiter?.give(null)
    for (const pending of [...this.inflight.values(), ...this.queue]) pending.settle(null)
  }
}
