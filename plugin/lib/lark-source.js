/**
 * v4: a device source for the owner's Feishu messages, read on the owner's machine with their own lark-cli login
 * (lark-cli keeps and refreshes it; no Feishu credential leaves that machine). Read-only: one cross-chat search over
 * a time window, as the user, plus one look at a direct chat's recent messages when it is not yet known who that chat
 * is with. Each read reaches back a little to cover search-index lag and minute-precision times; the device outbox
 * drops what it already sent.
 */
import { execFile } from 'node:child_process'

const ZONE = '+08:00', ZONE_MS = 8 * 3600_000
const problem = message => { const error = Error(message);error.code = 'LARK_SOURCE';return error }

/** Feishu's 'YYYY-MM-DD HH:MM[:SS]' local time (China) as epoch ms. */
export function larkTime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? ''))
  if (!m) throw problem('飞书消息时间格式无法识别')
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${ZONE}`)
}
const iso = ms => new Date(ms + ZONE_MS).toISOString().slice(0, 19) + ZONE
const directChat = m => m.chat_type === 'p2p' && typeof m.chat_id === 'string' && /^[\w-]{1,100}$/.test(m.chat_id)

const NAMED = { image: '图片', file: '文件', audio: '语音', media: '视频', sticker: '表情', share_chat: '群名片', share_user: '个人名片', system: '系统消息', interactive: '卡片' }
function textOf(m) {
  if (['text', 'post'].includes(m.msg_type) && typeof m.content === 'string') return m.content
  return `[${NAMED[m.msg_type] ?? m.msg_type ?? '消息'}]`
}

/** Run lark-cli with arguments (no shell) and parse its JSON output. */
export function runLarkCli(args, { bin = 'lark-cli', timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
    if (error && !stdout) return reject(problem('飞书读取失败：' + String(error.message).slice(0, 160)))
    try { resolve(JSON.parse(stdout)) } catch { reject(problem('飞书返回的不是 JSON')) }
  }))
}

export class LarkMessageSource {
  constructor({ run = runLarkCli, now = Date.now, firstSince, backfillMs = 72 * 3600_000, intervalMs = 120_000, overlapMs = 15 * 60_000, pageLimit = 20, minSplitMs = 10 * 60_000, stream = 'lark-messages', self } = {}) {
    Object.assign(this, { run, now, firstSince, backfillMs, intervalMs, overlapMs, pageLimit, minSplitMs, stream, self })
    this.lastRun = -Infinity
    /** Direct chat id → the name of who it is with ('' once looked for and not found). Kept for this run only. */
    this.partners = new Map()
  }

  /**
   * Who a direct chat is with. Feishu gives a direct chat no name and does not name the other side on the owner's own
   * messages, so the name comes from the other side's own messages: those already read, else one look at the chat's
   * recent ones. Not found or not readable is remembered too; the title then stays the plain one.
   */
  async partner(chat) {
    if (this.partners.has(chat)) return this.partners.get(chat)
    let name = ''
    try {
      const out = await this.run(['im', '+chat-messages-list', '--as', 'user', '--chat-id', chat, '--page-size', '50', '--no-reactions', '--format', 'json'])
      name = out?.data?.messages?.find(m => m?.sender?.name && m.sender.id !== this.self.openId)?.sender.name ?? ''
    } catch { /* the messages themselves are still sent */ }
    this.partners.set(chat, name)
    return name
  }

  /**
   * Every message in [start, end), handed to `take` window by window: a window with more than one read can carry is
   * split in halves until each half fits, earliest half first. What was taken stays queued even if a later read fails.
   */
  async read(start, end, take) {
    const args = ['im', '+messages-search', '--as', 'user', '--start', iso(start), '--end', iso(end), '--page-size', '50', '--page-all', '--page-limit', String(this.pageLimit), '--format', 'json']
    let out
    try { out = await this.run(args) } catch (error) { throw problem('飞书读取失败，下次重试：' + String(error?.message ?? error).slice(0, 160)) }
    if (out?.ok !== true || !Array.isArray(out?.data?.messages)) throw problem('飞书返回格式无效，下次重试')
    if (out.data.has_more !== true) return take(out.data.messages)
    if (end - start <= this.minSplitMs) throw problem('飞书这段时间消息太多，一次读不完；游标保留，下次重试')
    const middle = start + Math.floor((end - start) / 2)
    await this.read(start, middle, take)
    await this.read(middle, end, take)
  }

  async collect(client) {
    const now = this.now()
    if (now - this.lastRun < this.intervalMs) return
    this.lastRun = now
    const saved = client.checkpoint(this.stream)
    const start = saved?.since !== undefined ? saved.since - this.overlapMs : this.firstSince ?? now - this.backfillMs
    await this.read(start, now, async messages => {
      const rows = messages
        .filter(m => m && m.deleted !== true && typeof m.message_id === 'string' && /^[\w-]{1,80}$/.test(m.message_id))
        .map(m => ({ m, at: larkTime(m.create_time) }))
        .sort((a, b) => a.at - b.at || a.m.message_id.localeCompare(b.m.message_id))
      // Who each direct chat is with can only be told once the owner is known (otherwise their own name would be taken).
      const named = Boolean(this.self?.openId)
      if (named) for (const { m } of rows) if (directChat(m) && m.sender?.id !== this.self.openId && m.sender?.name) this.partners.set(m.chat_id, m.sender.name)
      for (const { m, at } of rows) {
        const partner = named && directChat(m) ? await this.partner(m.chat_id) : ''
        // The owner's own words, known from the login lark-cli reads with (never guessed from a name).
        const mine = Boolean(this.self?.openId) && m.sender?.id === this.self.openId
        const speaker = mine ? `${m.sender?.name || this.self.name || '我'}（我）` : m.sender?.name || '未知'
        // Which conversation it belongs to, and whether it reached the owner directly — a person's direct chat or an @ of
        // them — both from Feishu's own fields, so Mira can tell what still waits for the owner's reply.
        const conversation = typeof m.chat_id === 'string' && /^[\w-]{1,100}$/.test(m.chat_id) ? `lark-chat.${m.chat_id}` : undefined
        const toOwner = !mine && m.sender?.sender_type === 'user' && Boolean(this.self?.openId)
          && (m.chat_type === 'p2p' || Array.isArray(m.mentions) && m.mentions.some(x => x?.id === this.self.openId))
        try {
          client.enqueue({
          // An edited message has a new update time, so it arrives as a new version instead of conflicting with the old one;
          // the owner's marked messages get their own identity, so an earlier unmarked copy never conflicts either.
          eventId: `lark:${m.message_id}:${String(m.update_time || m.create_time).replace(/\D/g, '')}${mine ? ':me' : ''}`,
          source: 'lark', occurredAt: at, app: '飞书',
          title: String(m.chat_name || (m.chat_type === 'p2p' ? (partner ? `与${partner}的单聊` : '单聊') : '飞书会话')).slice(0, 400),
          text: `${speaker}：${textOf(m)}`.slice(0, 16000),
          ...(conversation ? { correlationId: conversation } : {}), important: toOwner,
          })
        } catch (error) {
          // The read reaches back 15 minutes, so it meets messages sent before these marks existed: same identity, older
          // content. That copy is already in Mira's hub; it stays as it was instead of stalling every later read.
          if (error?.code !== 'EVENT_CONFLICT') throw error
        }
      }
    })
    // Only a fully read window moves the place forward; the outbox drops anything sent twice.
    client.commitCheckpoint(this.stream, { since: now })
  }
}
