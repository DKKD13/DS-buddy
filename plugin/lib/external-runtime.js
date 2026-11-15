import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const EXTERNAL_PROVIDERS = ['claude', 'codex']
export const RUNTIME_LABELS = { dsh: 'DSH', claude: 'Claude Code', codex: 'Codex' }

// A runner that is signed out, or whose sign-in expired, fails with its own English text (E2E #17: 「Your access token
// could not be refreshed…」 in 进展). Matched on the runner's own failure text only; anything else passes through.
const SIGNED_OUT = /refresh token|access token|sign(ed)? ?in|log(ged)? ?(in|out)|oauth|authenticat|unauthori[sz]ed|\b401\b/i

/** The runner's sign-in failure, said as what happened and the way out; other errors unchanged. */
export function signInError(runtime, error) {
  if (!EXTERNAL_PROVIDERS.includes(runtime) || !SIGNED_OUT.test(String(error?.message ?? error))) return error
  const label = RUNTIME_LABELS[runtime]
  return new Error(`这台机器上的 ${label} 没登录或登录已过期。${runtime === 'codex' ? '在这台机器上运行 codex login 重新登录' : `在这台机器上重新登录 ${label} `}后再试，或者在任务里把执行方式换回 DSH。`, { cause: error })
}

const MCP_PATH = fileURLToPath(new URL('./external-mcp.js', import.meta.url))
const MAX_ERROR = 4000
/** Said to a runner that picks its own earlier session of this task back up, in place of the "new session" notice. */
export const RETURN_NOTICE = '## 回到这个任务\n这个任务之前由你做过一段，现在又交回给你。你自己的对话记录还在，但你不在的这段时间里，别的执行者可能动过任务卡和工作区，项目配置也可能改过（以这次给你的角色说明为准）。先 inbox_read，再看任务卡和工作区现在的样子，然后接着做；不用在回复里宣布这件事。'

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

function schemaValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const result = {}, required = []
  for (const [key, child] of Object.entries(value)) {
    if (key === 'required' && typeof child === 'boolean') continue
    if (key === 'properties') {
      result.properties = {}
      for (const [name, property] of Object.entries(child)) {
        result.properties[name] = schemaValue(property)
        if (property?.required === true) required.push(name)
      }
    } else if (key === 'items') result.items = schemaValue(child)
    else result[key] = child
  }
  if (required.length) result.required = required
  return result
}

function jsonSchema(parameters) {
  if (!parameters || typeof parameters !== 'object') return { type: 'object', properties: {} }
  return { ...schemaValue({ type: 'object', properties: parameters }), additionalProperties: false }
}

/** What any program needs to run at all: where things are, who it runs as, language, network route, certificates. */
const ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TMPDIR', 'TZ',
  'http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY', 'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
])
/** Locale and desktop-session names, and the runners' own settings (their keys and endpoints are theirs to have). */
const ENV_PREFIXES = ['LC_', 'XDG_', 'ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_']
/** Markers of the Claude Code session this server may itself have been started from; a child must not inherit them. */
const ENV_NEVER = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT'])

/**
 * The environment an outside runner starts with. Only the names above are passed on; everything else this server
 * was started with (its own model keys, token file locations, whatever a shell profile exported) stays here.
 * This keeps secrets out of a child's environment by default. It is not a sandbox: the runner still runs as the
 * same user and can read that user's files.
 */
export function runnerEnv(env) {
  const result = {}
  for (const [key, value] of Object.entries(env)) {
    if (ENV_NEVER.has(key) || key.startsWith('CLAUDECODE_')) continue
    if (ENV_NAMES.has(key) || ENV_PREFIXES.some(prefix => key.startsWith(prefix))) result[key] = value
  }
  return result
}

function codexMcpArgs(socketPath) {
  return ['-c', `mcp_servers.mira-project.command=${tomlString(process.execPath)}`,
    '-c', `mcp_servers.mira-project.args=${JSON.stringify([MCP_PATH, socketPath])}`,
    '-c', 'mcp_servers.mira-project.startup_timeout_sec=30',
    '-c', 'mcp_servers.mira-project.tool_timeout_sec=120']
}

/** A path or name typed as it is when a shell reads it as one plain word, quoted otherwise. */
function commandWord(value) {
  return /^[A-Za-z0-9_.\/-]+$/.test(value) ? value : shellQuote(value)
}

function commandFor(provider, sessionId, cwd, profile, bridge, executable = provider) {
  if (!sessionId) return null
  const resume = provider === 'claude'
    ? `${commandWord(executable)} --mcp-config ${shellQuote(bridge.configPath)} --strict-mcp-config --resume ${shellQuote(sessionId)}`
    : `${commandWord(executable)} ${profile ? `--profile ${shellQuote(profile)} ` : ''}${codexMcpArgs(bridge.socketPath).map(shellQuote).join(' ')} resume ${shellQuote(sessionId)}`
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume
}

export function runtimeView(binding) {
  if (!binding) return null
  return {
    provider: binding.runtime ?? 'dsh',
    label: RUNTIME_LABELS[binding.runtime ?? 'dsh'] ?? binding.runtime,
    node: binding.node ?? 'local',
    externalSessionId: binding.externalSessionId ?? null,
    takeoverCommand: binding.takeoverCommand ?? null,
  }
}

export class ExternalRuntime {
  constructor(ctx, store, driver, actions, tools, options = {}) {
    this.ctx = ctx
    this.store = store
    this.driver = driver
    this.actions = actions
    this.tools = tools
    this.root = options.root
    this.executables = { claude: 'claude', codex: 'codex', ...(options.executables ?? {}) }
    this.profiles = options.profiles ?? {}
    this.spawn = options.spawn ?? spawn
    this.timeoutMs = options.timeoutMs ?? 20 * 60_000
    this.inactivityMs = options.inactivityMs ?? 10 * 60_000
    this.active = new Map()
    this.bridges = new Map()
    this.stopped = false
    this.checked = null
  }

  /** Which outside runners this machine can actually start; the page greys out the rest. Looked up at most once a minute. */
  available() {
    const now = Date.now()
    if (this.checked && now - this.checked.at < 60_000) return this.checked.value
    const runnable = file => { try { accessSync(file, constants.X_OK); return true } catch { return false } }
    const value = {}
    for (const provider of EXTERNAL_PROVIDERS) {
      const executable = this.executables[provider]
      value[provider] = executable.includes('/')
        ? runnable(executable)
        : (process.env.PATH ?? '').split(delimiter).some(dir => dir && runnable(join(dir, executable)))
    }
    this.checked = { at: now, value }
    return value
  }

  provider(project, key) {
    if (!key.startsWith('w:')) return 'dsh'
    const thread = project.threads.get(key.slice(2))
    const member = project.members.find(m => m.id === thread?.assignee)
    // v4 harness: a task's own choice (set any time from its page) wins over its member's default.
    return thread?.runner ?? member?.runtimeSelection?.provider ?? 'dsh'
  }

  handles(project, key) {
    return EXTERNAL_PROVIDERS.includes(this.provider(project, key))
  }

  ensure(project, key) {
    const provider = this.provider(project, key)
    if (!EXTERNAL_PROVIDERS.includes(provider)) throw new Error('这个成员没有配置外部 runtime')
    const previous = project.sessions.get(key)
    if (previous && previous.runtime === provider && (previous.configRevision ?? 0) === (project.configRevision ?? 0)) return { binding: previous, continuity: false, returning: false }
    const sessionId = `external-${randomUUID()}`
    const thread = project.threads.get(key.slice(2))
    // Coming back to a runner that already worked on this task picks its own session up again, so switching away
    // and back does not cost it what it knew.
    const earlier = this.earlierSession(project, key, provider)
    this.store.append(project.id, {
      type: 'session.bound', key, sessionId, runtime: provider, node: 'local', assignee: thread?.assignee,
      generation: (previous?.generation ?? 0) + 1, continuity: previous !== undefined,
      configRevision: project.configRevision ?? 0, ...(earlier ? { externalSessionId: earlier } : {}),
    })
    return { binding: project.sessions.get(key), continuity: previous !== undefined, returning: earlier !== null }
  }

  /** The runner's own session this task last used with this runner, if it ever had one. */
  earlierSession(project, key, provider) {
    let found = null
    for (const event of project.events) {
      if (event.key !== key || event.runtime !== provider || !event.externalSessionId) continue
      if (event.type === 'runtime.session' || event.type === 'session.bound') found = event.externalSessionId
    }
    return found
  }

  toolList(key) {
    return this.tools.filter(({ role }) => role === 'any' || role === 'worker').map(({ definition }) => ({
      name: definition.name,
      description: definition.description ?? '',
      inputSchema: jsonSchema(definition.parameters),
    }))
  }

  async startBridge(project, key, binding) {
    const dir = mkdtempSync(join(tmpdir(), 'mira-runtime-'))
    chmodSync(dir, 0o700)
    const socketPath = join(dir, 'bridge.sock')
    const configDir = join(this.root, project.id, binding.sessionId)
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
    const configPath = join(configDir, 'mcp.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: { 'mira-project': {
      command: process.execPath, args: [MCP_PATH, socketPath],
    } } }), { mode: 0o600 })
    const callPrefix = randomUUID()
    const tools = this.tools.filter(({ role }) => role === 'any' || role === 'worker')
    const server = createServer(async (req, res) => {
      const reply = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(value))
      }
      try {
        if (req.method !== 'POST') { reply(405, { error: 'method not allowed' }); return }
        if (req.url === '/tools') { reply(200, { tools: this.toolList(key) }); return }
        if (req.url !== '/call') { reply(404, { error: 'not found' }); return }
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 1_000_000) throw new Error('工具请求过大')
        }
        const input = JSON.parse(body)
        const tool = tools.find(({ definition }) => definition.name === input.name)
        if (!tool) throw new Error('这个工具不对当前执行者开放')
        const text = await tool.definition.execute(input.args ?? {}, {
          agent: { id: binding.sessionId }, callId: `external-${callPrefix}-${input.clientId ?? 'native'}-${input.callId || randomUUID()}`, concludeTurn() {},
        })
        reply(200, { text: typeof text === 'string' ? text : JSON.stringify(text) })
      } catch (error) {
        reply(400, { error: String(error?.message ?? error).slice(0, MAX_ERROR) })
      }
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve() })
    })
    chmodSync(socketPath, 0o600)
    return {
      socketPath, configPath, closed: false,
      close: async function () {
        if (this.closed) return
        this.closed = true
        server.closeAllConnections?.()
        await new Promise(resolve => server.close(() => resolve()))
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  async bridgeFor(project, key, binding) {
    const id = `${project.id}|${key}|${binding.sessionId}`
    if (!this.bridges.has(id)) this.bridges.set(id, await this.startBridge(project, key, binding))
    return this.bridges.get(id)
  }

  async closeBridges(projectId, key, keepSessionId) {
    for (const [id, bridge] of this.bridges) {
      if (!id.startsWith(`${projectId}|${key}|`) || id.endsWith(`|${keepSessionId}`)) continue
      await bridge.close().catch(() => {})
      this.bridges.delete(id)
    }
  }

  noteSession(project, key, binding, externalSessionId, cwd, bridge) {
    if (!externalSessionId || binding.externalSessionId === externalSessionId) return
    const takeoverCommand = commandFor(binding.runtime, externalSessionId, cwd, this.profiles[binding.runtime], bridge, this.executables[binding.runtime])
    this.store.append(project.id, {
      type: 'runtime.session', key, sessionId: binding.sessionId, runtime: binding.runtime,
      externalSessionId, takeoverCommand,
    })
  }

  /** The runner got going this turn (it printed more than a bare verdict), so a failure from here on is not a failed resume. */
  started(project, key) {
    const active = this.active.get(`${project.id}|${key}`)
    if (active) active.started = true
  }

  noteEvent(project, key, kind, value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (!text) return
    this.store.append(project.id, { type: 'runtime.event', key, kind, text: text.slice(0, 20_000) })
  }

  async runProcess(project, key, binding, command, args, cwd, onLine, onStart) {
    const child = this.spawn(command, args, {
      cwd, env: runnerEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    const active = this.active.get(`${project.id}|${key}`)
    if (active) active.child = child
    // A runner that exits before reading what it is sent (a failed resume does) must not take this process down with it.
    child.stdin.on('error', () => {})
    onStart?.(child)
    let stderr = '', timer, inactivity
    const kill = () => {
      if (child.exitCode !== null || child.signalCode) return
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch { /* the process already exited */ }
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode) return
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch { /* the process already exited */ }
      }, 5000).unref()
    }
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-MAX_ERROR) })
    const resetInactivity = () => {
      clearTimeout(inactivity)
      inactivity = setTimeout(kill, this.inactivityMs)
    }
    timer = setTimeout(kill, this.timeoutMs)
    resetInactivity()
    try {
      const result = await new Promise((resolve, reject) => {
        let failure
        child.once('error', reject)
        lines.on('line', line => {
          resetInactivity()
          if (!line.trim()) return
          try { onLine(line, child) } catch (error) { failure = error; kill() }
        })
        child.once('close', (code, signal) => {
          if (failure) reject(failure)
          else if (code !== 0) reject(new Error(`${binding.runtime} 执行失败（exit ${code ?? signal}）${stderr.trim() ? `：${stderr.trim()}` : ''}`))
          else resolve()
        })
      })
      return result
    } finally {
      clearTimeout(timer)
      clearTimeout(inactivity)
      lines.close()
    }
  }

  async runClaude(project, key, binding, prompt, cwd, bridge, resume = binding.externalSessionId) {
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
      '--permission-mode', 'bypassPermissions', '--disallowedTools', 'AskUserQuestion',
      '--mcp-config', bridge.configPath, '--strict-mcp-config']
    if (resume) args.push('--resume', resume)
    let output = '', sawResult = false, resultError = ''
    await this.runProcess(project, key, binding, this.executables.claude, args, cwd, (line, child) => {
      const event = JSON.parse(line)
      if (event.type !== 'result') this.started(project, key)
      const sessionId = event.session_id
      if (sessionId) this.noteSession(project, key, binding, sessionId, cwd, bridge)
      if (event.type === 'assistant') {
        const blocks = event.message?.content ?? []
        for (const block of blocks) {
          if (block.type === 'text' && block.text) output = block.text
          if (block.type === 'tool_use') this.noteEvent(project, key, 'tool', { tool: block.name, input: block.input })
        }
      }
      if (event.type === 'control_request') {
        const response = { type: 'control_response', response: {
          subtype: 'success', request_id: event.request_id,
          response: { behavior: 'allow', updatedInput: event.request?.input ?? {} },
        } }
        child.stdin.write(JSON.stringify(response) + '\n')
      }
      if (event.type === 'result') {
        sawResult = true
        if (event.result) output = event.result
        if (event.is_error) resultError = event.result || 'Claude Code 返回了错误'
        child.stdin.end()
      }
    }, child => {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n')
    }).catch(error => { throw resultError ? new Error(resultError) : error })
    if (!sawResult) throw new Error('Claude Code 没有返回完整回合')
    if (resultError) throw new Error(resultError)
    return { output }
  }

  async runCodex(project, key, binding, prompt, cwd, bridge, resume = binding.externalSessionId) {
    const args = this.profiles.codex ? ['--profile', this.profiles.codex, 'exec'] : ['exec']
    if (resume) args.push('resume', resume)
    args.push('--json', '--dangerously-bypass-approvals-and-sandbox', ...codexMcpArgs(bridge.socketPath), prompt)
    let output = '', failure = ''
    await this.runProcess(project, key, binding, this.executables.codex, args, cwd, line => {
      const event = JSON.parse(line)
      if (event.type !== 'error' && event.type !== 'turn.failed') this.started(project, key)
      if (event.type === 'thread.started') this.noteSession(project, key, binding, event.thread_id, cwd, bridge)
      if (event.type === 'item.completed') {
        const item = event.item ?? {}
        if (item.item_type === 'agentMessage' || item.item_type === 'agent_message' || item.type === 'agent_message') {
          if (item.text) output = item.text
        } else this.noteEvent(project, key, 'tool', item)
      }
      if (event.type === 'turn.failed') failure = event.error?.message || 'Codex 返回了错误'
      if (event.type === 'error') failure = event.message || failure
    }, child => child.stdin.end()).catch(error => { throw failure ? new Error(failure) : error })
    if (failure) throw new Error(failure)
    return { output }
  }

  async run({ project, key, unread, reason, notice, addressed }) {
    if (this.stopped) throw new Error('外部 runtime 已停止')
    const { binding, continuity, returning } = this.ensure(project, key)
    const thread = project.threads.get(key.slice(2))
    const cwd = thread?.workspace?.cwd ?? project.cwd ?? join(this.store.root, project.id)
    mkdirSync(cwd, { recursive: true })
    const turn = { projectId: project.id, key, platform: false, replied: false, readThrough: 0 }
    this.driver.turns.set(binding.sessionId, turn)
    await this.closeBridges(project.id, key, binding.sessionId)
    const bridge = await this.bridgeFor(project, key, binding)
    const slot = { child: null, started: false }
    this.active.set(`${project.id}|${key}`, slot)
    try {
      const attempt = (extra, resume) => {
        const prompt = [
          this.driver.text.rolePrompt(project, key),
          `你这次由 ${RUNTIME_LABELS[binding.runtime]} 执行。平台工具在名为 mira-project 的 MCP 服务里。先 inbox_read 读取收件箱。最终文字不会自动进入项目记录；要对用户说就用 post_message，要更新任务就用 update_card，不需要回复就用 no_reply。你只能操作当前任务。`,
          this.driver.text.wakeText(project, key, unread, reason, extra),
        ].join('\n\n')
        return binding.runtime === 'claude'
          ? this.runClaude(project, key, binding, prompt, cwd, bridge, resume)
          : this.runCodex(project, key, binding, prompt, cwd, bridge, resume)
      }
      const resume = binding.externalSessionId ?? null
      let result
      try {
        result = await attempt(returning ? RETURN_NOTICE : notice || continuity ? this.driver.text.continuityNotice(project, key) : '', resume)
      } catch (error) {
        // The runner could not reopen its own session (its record was cleaned up, or the work folder moved) and gave
        // up before doing anything: start a fresh one, once. A failure after it got going is a real failure.
        if (!resume || slot.started || this.stopped) throw signInError(binding.runtime, error)
        this.ctx.logger?.warn?.(`${RUNTIME_LABELS[binding.runtime]} 没能接上原来的会话，改为新开一个`, error)
        result = await attempt(this.driver.text.continuityNotice(project, key), null).catch(error => { throw signInError(binding.runtime, error) })
      }
      if (addressed && !turn.replied && result.output.trim()) {
        this.actions.assistantPost(project, key, result.output)
        turn.platform = true
        turn.replied = true
      }
      this.noteEvent(project, key, 'result', result.output)
      return { binding, turn, unanswered: addressed && !turn.replied }
    } finally {
      this.driver.turns.delete(binding.sessionId)
      this.active.delete(`${project.id}|${key}`)
    }
  }

  /**
   * The command that reopens this task's Claude Code / Codex session in a terminal, with the project tools attached.
   * Made when asked for, because the bridge it points at does not outlive a restart of this process.
   */
  async takeover(project, key) {
    if (this.stopped) throw new Error('外部 runtime 已停止')
    const binding = project.sessions.get(key)
    if (!binding || !EXTERNAL_PROVIDERS.includes(binding.runtime) || !binding.externalSessionId) throw new Error('这个任务还没有可以接着做的 Claude Code / Codex 会话')
    const thread = project.threads.get(key.slice(2))
    const cwd = thread?.workspace?.cwd ?? project.cwd ?? join(this.store.root, project.id)
    const bridge = await this.bridgeFor(project, key, binding)
    return {
      provider: binding.runtime, label: RUNTIME_LABELS[binding.runtime],
      command: commandFor(binding.runtime, binding.externalSessionId, cwd, this.profiles[binding.runtime], bridge, this.executables[binding.runtime]),
      busy: this.active.has(`${project.id}|${key}`),
    }
  }

  async stop() {
    this.stopped = true
    for (const { child } of this.active.values()) {
      if (child && child.exitCode === null && !child.signalCode) {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
          else child.kill('SIGTERM')
        } catch { /* the process already exited */ }
      }
    }
    this.active.clear()
    for (const bridge of this.bridges.values()) await bridge.close().catch(() => {})
    this.bridges.clear()
  }
}
