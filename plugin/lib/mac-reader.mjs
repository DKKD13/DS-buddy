/**
 * v4: the read-only file reader on the owner's own computer. The personal assistant runs on another machine and
 * cannot reach this one. Like Claude Code's Remote Control and Codex's remote hosts, this side dials out, waits for
 * a request and answers it from local files; it never opens a port. What may be read is decided here and only here:
 * the folders listed in this machine's private config. The other machine can ask, it cannot widen that list.
 * Nothing is written, nothing is run. Node built-ins only.
 */
import { appendFileSync, realpathSync, renameSync, statSync } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

export const READER_OPS = ['roots', 'list', 'search', 'read']
const ROOT_NAME = /^[a-z][a-z0-9-]{0,31}$/
const CHUNK = 1024 * 1024
const SNIPPET_BEFORE = 100, SNIPPET_AFTER = 220
/** How much text on each side of what is returned is also checked for keys (and never returned). */
const PAD = 600
/** A run this long of base64-ish characters is an embedded image or blob, not prose: it is skipped, not returned. */
const BLOB = /[A-Za-z0-9+/=_-]{400,}/g

/** Never served, wherever the folder list points: places and names that hold keys. Checked on every path segment. */
const DENY_SEGMENT = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.lark-cli', 'keychains'])
const DENY_NAME = [
  /\.env(\..+)?$/i, /\.(pem|key|p12|pfx|enc|keychain|keychain-db)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^(auth|credentials?|secrets?)(\.(json|ya?ml|toml|env|txt|ini|conf))?$/i,
  /^(device-token|runtime-token|\.netrc|\.npmrc|\.pypirc)$/i,
]
const denied = rel => rel.split(sep).some(part => DENY_SEGMENT.has(part.toLowerCase()) || DENY_NAME.some(re => re.test(part)))
/** Inside the whole home folder (全部文件): ~/Library (mail, messages, browser and app data) and anything hidden (dot folders hold settings and keys). */
const wholeOff = rel => { const parts = rel.split(sep).filter(Boolean);return parts[0] === 'Library' || parts.some(part => part.startsWith('.')) }

/**
 * What looks like a key is replaced before text leaves this machine. Mechanical patterns only; over-masking is fine.
 * Each entry: the pattern, and whether its first group is a prefix that stays readable (the key's name, "Bearer").
 */
const MASKS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, false],
  // Three or more lines of nothing but base64 (and the shorter last line): the body of a key or a certificate.
  [/(?:[A-Za-z0-9+/=]{40,76}(?:\\+[rn]|\s)+){3,}[A-Za-z0-9+/=]{0,76}/g, false],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, false],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, true],
  [/\b(ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/g, true],
  [/\bAKIA[0-9A-Z]{16}\b/g, false],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, true],
  [/((?:(?:api|access|private|secret|auth|app|client|signing|encryption)[_-]?(?:key|secret|token)|secret|token|passw(?:or)?d|authorization|credentials?)["'\\]*\s*[:=]\s*["'\\]*)([^\s"'\\,;&]{8,})/gi, true],
  [/([?&](?:access_token|token|code|key|secret|signature|sig)=)[^&\s"'\\]{6,}/gi, true],
]
const MARK = '[已打码]'

/** Every stretch of `text` that is not shown, as [start, end, what to show instead]: keys, and (if asked) embedded data. */
function hidden(text, blobs = false) {
  const spans = []
  for (const [pattern, keepsPrefix] of MASKS) for (const match of text.matchAll(pattern)) spans.push([match.index + (keepsPrefix ? match[1].length : 0), match.index + match[0].length, MARK])
  if (blobs) for (const match of text.matchAll(BLOB)) spans.push([match.index, match.index + match[0].length, `[略过 ${match[0].length} 字节的编码数据]`])
  spans.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push(span)
  }
  return merged
}
/**
 * `text.slice(from, to)` with the hidden stretches replaced. The stretches are found in the whole text, so one that
 * starts before `from` or ends after `to` still counts: the caller passes more text than it shows.
 */
function shown(text, spans, from = 0, to = text.length) {
  let out = '', at = from
  for (const [start, end, instead] of spans) {
    if (end <= from || start >= to) continue
    out += text.slice(at, Math.max(at, start)) + instead
    at = Math.min(to, end)
  }
  return out + text.slice(at, to)
}
export const maskSecrets = text => shown(text, hidden(text))

/** An error the asker may see word for word. Anything else is reported by its code only, so no local path leaks. */
const fail = message => Object.assign(new Error(message), { expected: true })
const iso = ms => new Date(ms).toISOString()
const whole = (value, fallback, min, max) => Number.isInteger(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback
/** A model often sends "" for a parameter it does not use: that is the same as leaving it out. */
const given = value => typeof value === 'string' ? value.trim() : ''

/** How many bytes at the end of `bytes` are the start of a UTF-8 character whose rest is missing. */
function brokenTail(bytes) {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back]
    if (byte < 0x80) return 0
    if (byte >= 0xc0) return back < (byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2) ? back : 0
  }
  return 0
}
/** Bytes to text: a character cut at either end is dropped, not shown as garbage. */
function decode(bytes) {
  let start = 0
  while (start < Math.min(3, bytes.length) && (bytes[start] & 0xc0) === 0x80) start++
  return new TextDecoder().decode(bytes.subarray(start, bytes.length - brokenTail(bytes)))
}

/**
 * Up to `want` bytes of prose from `window`, with embedded blobs replaced by a short note.
 * `consumed` is how far into the window the answer reaches: reading on from there misses nothing.
 */
function squeeze(window, want, final = false) {
  const parts = []
  let position = 0, used = 0, prose = false
  const take = end => {
    const size = Math.min(end - position, want - used)
    if (size > 0) { parts.push(window.subarray(position, position + size));used += size;position += size;prose = true }
    return position === end
  }
  let full = false
  for (const run of window.toString('latin1').matchAll(BLOB)) {
    if (!take(run.index)) { full = true;break }
    parts.push(Buffer.from(`[略过 ${run[0].length} 字节的编码数据]`));prose = false
    position = run.index + run[0].length
  }
  if (!full) take(window.length)
  let bytes = Buffer.concat(parts)
  // A cut through prose can split a character: it is left for the next read. At the very end of the file there is
  // no next read, so a broken last character is simply consumed (and dropped when the bytes become text).
  const cut = prose && !(final && position === window.length) ? brokenTail(bytes) : 0
  if (cut) bytes = bytes.subarray(0, bytes.length - cut)
  return { bytes, consumed: position - cut }
}

export class MacReader {
  /**
   * @param {object} options
   * @param {{name: string, label: string, path: string}[]} options.roots the folders this machine allows
   * @param {string} [options.logFile] every request is noted here, on this machine
   */
  constructor({ roots, logFile, now = Date.now, maxRequests = 60, windowMs = 5 * 60_000, budgetMs = 10_000, home: homeDir = homedir() }) {
    if (!Array.isArray(roots) || !roots.length || roots.length > 20) throw Error('roots 需要 1 到 20 个文件夹')
    const home = realpathSync(homeDir)
    this.folders = new Map()
    for (const root of roots) {
      if (!ROOT_NAME.test(root?.name ?? '') || this.folders.has(root.name)) throw Error(`文件夹名无效或重复：${root?.name}`)
      if (typeof root.label !== 'string' || !root.label.trim() || root.label.length > 60) throw Error(`文件夹 ${root.name} 需要一个 60 字以内的说明`)
      const dir = realpathSync(root.path)
      if (!statSync(dir).isDirectory()) throw Error(`${root.name} 不是文件夹`)
      // The whole home folder is a root only when this machine's owner marked it `whole` (全部文件); then ~/Library and every
      // hidden folder stay out (see wholeOff). Anything above the home folder is never a root.
      if (root.whole === true) { if (dir !== home) throw Error(`${root.name} 标为全部文件，路径必须正好是个人目录`) }
      else if (dir === home || home.startsWith(dir.endsWith(sep) ? dir : dir + sep)) throw Error(`${root.name} 太宽：不能放行整个个人目录或它的上级`)
      if (denied(dir)) throw Error(`${root.name} 指向存密钥的位置，不能放行`)
      this.folders.set(root.name, { name: root.name, label: root.label.trim(), dir, whole: root.whole === true })
    }
    this.logFile = logFile;this.now = now;this.maxRequests = maxRequests;this.windowMs = windowMs;this.budgetMs = budgetMs
    this.times = [];this.noted = 0
  }

  /** What the other side is told about the folders: a name and a description, never the local path. */
  describe() { return [...this.folders.values()].map(({ name, label, whole }) => ({ name, label, ...(whole ? { whole: true } : {}) })) }

  /** Whether a place inside `folder` is never served: key places anywhere, and in the whole home folder also ~/Library and hidden folders. */
  blocked(folder, rel) { return denied(rel) || (folder.whole && wholeOff(rel)) }

  /** One request. Refuses past the rate limit; every outcome is noted in the local log. */
  async handle(op, args) {
    const started = this.now()
    this.times = this.times.filter(at => at > started - this.windowMs)
    try {
      if (this.times.length >= this.maxRequests) throw fail('读得太频繁了，过几分钟再试')
      this.times.push(started)
      if (!READER_OPS.includes(op)) throw fail(`op 只能是 ${READER_OPS.join('、')}`)
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('参数无效')
      const data = await this[op](args)
      this.note(op, args, 'ok')
      return data
    } catch (error) {
      this.note(op, args, error.expected ? `refused: ${error.message}` : `failed: ${error.code ?? 'ERROR'}`)
      throw error
    }
  }

  note(op, args, outcome) {
    if (!this.logFile) return
    const what = [args?.root, args?.path, args?.query && `q=${args.query}`, args?.name && `name=${args.name}`, Number.isInteger(args?.offset) && `@${args.offset}`].filter(Boolean).join(' ')
    try {
      if (this.noted++ % 500 === 0 && statSync(this.logFile, { throwIfNoEntry: false })?.size > 5 * 1024 * 1024) renameSync(this.logFile, this.logFile + '.1')
      appendFileSync(this.logFile, `${iso(this.now())} ${op} ${JSON.stringify(what).slice(0, 300)} ${outcome}\n`, { mode: 0o600 })
    } catch { /* the log never fails a read */ }
  }

  /** Resolve root + relative path to a real location inside that root; symlinks that lead out are refused. */
  async locate(rootName, path = '') {
    const folder = this.folders.get(rootName)
    if (!folder) throw fail(typeof rootName === 'string' && rootName ? `没有名为「${rootName.slice(0, 40)}」的文件夹；先用 roots 看有哪些` : '要先用 root 说明读哪个文件夹；用 roots 看有哪些')
    if (typeof path !== 'string' || path.length > 1000 || path.includes('\0')) throw fail('path 无效')
    const inside = target => target === folder.dir || target.startsWith(folder.dir + sep)
    const target = resolve(folder.dir, path)
    if (!inside(target)) throw fail('path 必须在这个文件夹里面')
    let real
    try { real = await realpath(target) } catch { throw fail('没有这个文件或目录') }
    if (!inside(real)) throw fail('path 必须在这个文件夹里面')
    const rel = relative(folder.dir, real)
    if (rel && denied(rel)) throw fail('这个位置存的是密钥一类的东西，不提供')
    if (rel && folder.whole && wholeOff(rel)) throw fail('个人目录里的「资源库」（Library）和隐藏文件夹不提供')
    return { folder, real, rel, stat: await stat(real) }
  }

  async roots() { return { roots: this.describe() } }

  async list({ root, path, limit }) {
    const at = await this.locate(root, path)
    if (!at.stat.isDirectory()) throw fail('这是文件，不是目录；用 read 读它')
    const entries = []
    for (const item of await readdir(at.real, { withFileTypes: true })) {
      // Links, sockets and the like are not listed: only real files and folders.
      if (!(item.isFile() || item.isDirectory()) || this.blocked(at.folder, join(at.rel, item.name))) continue
      const info = await stat(join(at.real, item.name)).catch(() => null)
      if (info) entries.push({ name: item.name, dir: item.isDirectory(), ...(item.isFile() ? { size: info.size } : {}), mtime: iso(info.mtimeMs), at: info.mtimeMs })
    }
    entries.sort((a, b) => b.at - a.at)
    const cap = whole(limit, 100, 1, 300)
    return { root, path: at.rel, total: entries.length, truncated: entries.length > cap, entries: entries.slice(0, cap).map(({ at: _at, ...entry }) => entry) }
  }

  /** Files under a folder, newest first: by content (`query`), by name, by modified time, or any mix. */
  async search({ root, path, query, name, since, until, limit }) {
    const at = await this.locate(root, path)
    const needle = given(query), part = given(name).toLowerCase()
    if (needle && (needle.length < 2 || needle.length > 200)) throw fail('query 要 2 到 200 个字')
    const from = given(since) ? Date.parse(since) : -Infinity, to = given(until) ? Date.parse(until) : Infinity
    if (Number.isNaN(from) || Number.isNaN(to)) throw fail('since、until 要写成 ISO 8601 时间')
    const deadline = this.now() + this.budgetMs
    // Walk without following links; a single file is searched as itself.
    const files = [], pending = at.stat.isDirectory() ? [at.rel] : []
    const consider = (rel, info) => {
      // Whole milliseconds, so `continueWith.until` can name a point between two files exactly.
      const at = Math.floor(info.mtimeMs)
      if (part && !rel.toLowerCase().includes(part)) return
      if (at < from || at > to) return
      files.push({ path: rel, size: info.size, at })
    }
    if (at.stat.isFile()) consider(at.rel, at.stat)
    let walked = true
    while (pending.length) {
      if (files.length >= 50_000) { walked = false;break }
      const dir = pending.pop()
      for (const item of await readdir(join(at.folder.dir, dir), { withFileTypes: true }).catch(() => [])) {
        const rel = join(dir, item.name)
        // In the whole home folder, installed dependencies are skipped too: they are not the owner's files and would eat the budget.
        if (this.blocked(at.folder, rel) || (at.folder.whole && item.name === 'node_modules')) continue
        if (item.isDirectory()) pending.push(rel)
        else if (item.isFile()) { const info = await stat(join(at.folder.dir, rel)).catch(() => null);if (info) consider(rel, info) }
      }
    }
    files.sort((a, b) => b.at - a.at || (a.path < b.path ? -1 : 1))
    const show = file => ({ path: file.path, size: file.size, mtime: iso(file.at) })
    if (!needle) {
      const cap = whole(limit, 30, 1, 100)
      return { root, total: files.length, complete: walked, truncated: files.length > cap, files: files.slice(0, cap).map(show) }
    }
    const cap = whole(limit, 10, 1, 20), found = [], unfinished = []
    let scanned = 0, last, cut = false
    for (const file of files) {
      // Stopping (enough found, or out of time) happens only between files of different times, so carrying on with
      // `continueWith.until` repeats nothing and skips nothing. The first file is always searched.
      if (last && file.at !== last.at && (found.length >= cap || this.now() > deadline)) break
      // A file that was started is given extra time to finish, so one very large file cannot starve the search.
      const result = await this.scan(join(at.folder.dir, file.path), needle, deadline + this.budgetMs * 1.5).catch(() => null)
      scanned++;last = file
      if (result?.partial) cut = true
      if (result?.hits.length) found.push({ ...show(file), ...(result.partial ? { partial: true } : {}), hits: result.hits })
      else if (result?.partial) unfinished.push(file.path)
    }
    const more = !walked || scanned < files.length
    return {
      root, query: needle, scannedFiles: scanned, totalFiles: files.length, complete: !more && !cut,
      // Files are left (time or count ran out): the same search with this `until` carries on with older files.
      ...(more && last ? { continueWith: { until: iso(last.at - 1) } } : {}),
      // Too large to search to the end in time, and nothing found in the part that was searched.
      ...(unfinished.length ? { unfinished: unfinished.slice(0, 20) } : {}),
      files: found,
    }
  }

  /**
   * Up to three places in one file where `needle` occurs (letters match in either case), each with a snippet.
   * A place inside a key or inside embedded data is not reported at all, so a search cannot be used to guess a key.
   */
  async scan(file, needle, stopAt) {
    const key = Buffer.from(needle, 'utf8'), anyCase = /[a-z]/i.test(needle)
    const lowered = anyCase ? key.toString('latin1').toLowerCase() : null
    const handle = await open(file, 'r'), hits = []
    let partial = false
    try {
      const { size } = await handle.stat()
      const chunk = Buffer.allocUnsafe(CHUNK + key.length)
      let position = 0, carry = 0, tried = -Infinity
      while (hits.length < 3) {
        const { bytesRead } = await handle.read(chunk, carry, CHUNK, position)
        if (!bytesRead) break
        const view = chunk.subarray(0, carry + bytesRead), base = position - carry
        // Not text (the same test read uses): nothing in it is shown.
        if (position === 0 && view.subarray(0, 4096).includes(0)) break
        const hay = anyCase ? view.toString('latin1').toLowerCase() : view
        for (let from = 0; hits.length < 3;) {
          const found = hay.indexOf(anyCase ? lowered : key, from)
          if (found < 0) break
          const offset = base + found
          from = found + key.length
          // A second place inside the previous snippet adds nothing.
          if (offset - tried <= SNIPPET_AFTER) continue
          tried = offset
          const snippet = await this.snippet(handle, offset, key.length)
          if (snippet) hits.push({ offset, snippet })
        }
        position += bytesRead
        carry = Math.min(key.length - 1, view.length)
        chunk.copy(chunk, 0, view.length - carry, view.length)
        if (position < size && this.now() > stopAt) { partial = true;break }
      }
    } finally { await handle.close() }
    return { hits, partial }
  }

  /** The text around one place, secrets masked; null when the place itself lies in a key or in embedded data. */
  async snippet(handle, offset, length) {
    const from = Math.max(0, offset - SNIPPET_BEFORE - PAD), bytes = Buffer.allocUnsafe(offset - from + length + SNIPPET_AFTER + PAD)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, from)
    // Extra text on both sides is looked at, not shown: a key that starts before the snippet is still recognised.
    const cut = at => Math.min(Math.max(at - from, 0), bytesRead)
    const part = (start, end) => decode(bytes.subarray(cut(start), cut(end)))
    const head = part(from, offset - SNIPPET_BEFORE), before = part(offset - SNIPPET_BEFORE, offset), word = part(offset, offset + length)
    const after = part(offset + length, offset + length + SNIPPET_AFTER), tail = part(offset + length + SNIPPET_AFTER, Infinity)
    const text = head + before + word + after + tail, at = head.length + before.length, end = at + word.length
    const spans = hidden(text, true)
    if (spans.some(([start, stop]) => start < end && stop > at)) return null
    return shown(text, spans, head.length, end + after.length).replace(/\s+/g, ' ').slice(0, 400)
  }

  /** A stretch of one text file from a byte offset; `nextOffset` carries on where this stopped. */
  async read({ root, path, offset, max_bytes: maxBytes }) {
    if (!given(path)) throw fail('read 需要 path')
    const at = await this.locate(root, path)
    if (!at.stat.isFile()) throw fail('这不是文件；目录用 list 看')
    const size = at.stat.size, start = offset ?? 0
    if (!Number.isInteger(start) || start < 0 || start > size) throw fail(`offset 要在 0 到 ${size} 之间`)
    // Some text before and after the stretch is looked at, not returned: a key that starts before the offset or ends
    // after the cut is still recognised, so reading from the middle of a key shows nothing of it.
    const lead = Math.min(start, PAD)
    const handle = await open(at.real, 'r')
    try {
      const raw = Buffer.allocUnsafe(Math.min(lead + CHUNK, size - start + lead))
      const { bytesRead } = await handle.read(raw, 0, raw.length, start - lead)
      const window = raw.subarray(Math.min(lead, bytesRead), bytesRead)
      if (window.subarray(0, 4096).includes(0)) throw fail('这不是文本文件，读不了')
      const { bytes, consumed } = squeeze(window, whole(maxBytes, 12_000, 500, 30_000), bytesRead < raw.length || start + window.length >= size)
      const head = decode(raw.subarray(0, Math.min(lead, bytesRead))), body = decode(bytes)
      const text = head + body + decode(window.subarray(consumed, consumed + PAD))
      const nextOffset = start + consumed
      return { root, path: at.rel, size, mtime: iso(at.stat.mtimeMs), offset: start, nextOffset, eof: nextOffset >= size, text: shown(text, hidden(text), head.length, head.length + body.length) }
    } finally { await handle.close() }
  }
}

/** The loop that keeps this machine reachable: ask the Mira machine for work, answer it, ask again. */
export class MacReaderClient {
  constructor({ reader, serverUrl, token, fetch: fetcher = fetch, holdMs = 40_000, log = () => {} }) {
    this.reader = reader;this.origin = new URL(serverUrl).origin;this.token = token;this.fetcher = fetcher;this.holdMs = holdMs;this.log = log
    this.stopping = new AbortController();this.served = 0;this.lastError = ''
  }

  async post(operation, body, timeoutMs) {
    const response = await this.fetcher(`${this.origin}/api/desktop/files/${operation}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.stopping.signal]),
      headers: { Authorization: 'Bearer ' + this.token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw Object.assign(Error(`设备入口返回 ${response.status}`), { status: response.status })
    return response.json()
  }

  /** One wait for work and, if a request came, its answer. */
  async once() {
    const { request } = await this.post('poll', { roots: this.reader.describe() }, this.holdMs)
    if (!request) return false
    let answer
    try { answer = { id: request.id, ok: true, data: await this.reader.handle(request.op, request.args) } }
    catch (error) { answer = { id: request.id, ok: false, error: error.expected ? error.message : `读取失败（${error.code ?? '内部错误'}）` } }
    await this.post('result', answer, 20_000)
    this.served++
    return true
  }

  async run() {
    let wait = 0
    while (!this.stopping.signal.aborted) {
      try { await this.once();wait = 0;this.lastError = '' } catch (error) {
        if (this.stopping.signal.aborted) break
        this.lastError = String(error?.message ?? error).slice(0, 200)
        // No such entrance (an older Mira) or a refused token will not fix itself in seconds.
        wait = error.status === 404 || error.status === 401 ? 60_000 : Math.min(30_000, Math.max(5_000, wait * 2))
        await new Promise(resolve => { const timer = setTimeout(resolve, wait);this.stopping.signal.addEventListener('abort', () => { clearTimeout(timer);resolve() }, { once: true }) })
      }
    }
  }

  stop() { this.stopping.abort() }
}
