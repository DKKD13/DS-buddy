import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, workerKey } from '../lib/store.js'
import { Driver } from '../lib/driver.js'
import { Actions } from '../lib/actions.js'
import { createTools } from '../lib/tools.js'
import { ExternalRuntime, runtimeView } from '../lib/external-runtime.js'

// A stand-in for Claude Code: it does one turn through the project tools like the real one, logs how it was started
// and what it was told, and can be made to fail the two ways the real one does.
const FAKE_CLI = String.raw`
import { spawn } from 'node:child_process'
import { readFileSync, appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const log = prompt => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, prompt }) + '\n') }
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null
if (resume && process.env.FAKE_RESUME_FAILS) {
  // What Claude Code 2.1.318 really prints when the session to resume is gone: one verdict line, then exit 1.
  log(null)
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: resume }))
  console.error('No conversation found with session ID: ' + resume)
  process.exitCode = 1
} else {
  const server = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers['mira-project']
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.once('line', line => {
    lines.close()
    log(JSON.parse(line).message.content[0].text)
    run(server).catch(error => { console.error(error);process.exit(1) })
  })
}
async function run(server) {
  const sessionId = resume || process.env.FAKE_SESSION || 'native-claude-1'
  if (process.env.FAKE_DIES_AFTER_INIT) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }))
    console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', session_id: sessionId, result: '模型接口挂了', is_error: true }))
    process.exitCode = 1
    process.stdin.destroy()
    return
  }
  const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'ignore'] })
  const pending = new Map()
  let id = 0
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    const message = JSON.parse(line)
    const done = pending.get(message.id)
    if (done) { pending.delete(message.id);done(message) }
  })
  const rpc = (method, params) => new Promise(resolve => {
    const requestId = ++id
    pending.set(requestId, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
  })
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
  const call = async (name, input) => {
    const response = await rpc('tools/call', { name, arguments: input })
    if (response.result.isError) throw new Error(response.result.content[0].text)
  }
  await call('inbox_read', {})
  await call('post_message', { text: 'claude 已交付' })
  child.stdin.end();child.kill()
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }))
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId, result: '最终回答', is_error: false }))
  process.stdin.destroy()
}
`

const FAKE_ENV = ['FAKE_LOG', 'FAKE_SESSION', 'FAKE_RESUME_FAILS', 'FAKE_DIES_AFTER_INIT']

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-takeover-'))
  const fakePath = join(root, 'fake-cli.mjs'), logPath = join(root, 'argv.jsonl')
  writeFileSync(fakePath, FAKE_CLI)
  chmodSync(fakePath, 0o700)
  process.env.FAKE_LOG = logPath
  const store = new ProjectStore(join(root, 'data'), { warn() {} })
  store.load()
  const ctx = { logger: { warn() {} }, agents: { withoutInitiator: fn => fn(), get: () => undefined }, sessions: { flush: async () => {} }, get: () => undefined }
  const driver = new Driver(ctx, store, content => ({ content }))
  driver.schedule = () => {}
  const actions = new Actions(store, driver)
  const tools = createTools({ defineTool: definition => definition, store, driver, actions })
  const runtimes = []
  const runtime = options => {
    const made = new ExternalRuntime(ctx, store, driver, actions, tools, { root: join(root, `runtime-${runtimes.length}`), timeoutMs: 20_000, inactivityMs: 10_000, ...options })
    runtimes.push(made)
    return made
  }
  // The runner's environment is an allow-list, so the stand-in's own switches are handed over here, by the test.
  const fakeEnv = () => Object.fromEntries(FAKE_ENV.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  const external = runtime({ spawn: (_command, args, options) => spawn(process.execPath, [fakePath, ...args], { ...options, env: { ...options.env, ...fakeEnv() } }) })
  driver.external = external
  t.after(async () => {
    for (const made of runtimes) await made.stop()
    for (const name of FAKE_ENV) delete process.env[name]
    rmSync(root, { recursive: true, force: true })
  })
  const { projectId } = actions.createProject({ name: '外部执行' })
  const project = store.get(projectId)
  const engineer = project.members.find(member => member.id === 'engineer')
  engineer.runtimeSelection = { provider: 'claude', deviceId: 'local' }
  const { threadId } = actions.openThread(project, { title: '验证接手', brief: '走一遍', assignee: '工程师' })
  const key = workerKey(threadId), slot = { running: false, again: false, reason: 'spawn', wokenThrough: 0 }
  const turn = async text => {
    if (text) { actions.ownerPost({ projectId, threadId, text });slot.reason = 'message' }
    await driver.run(projectId, key, slot)
  }
  const invocations = () => readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse)
  return { root, store, project, projectId, engineer, threadId, key, external, runtime, turn, invocations }
}

/** POST to a bridge the way external-mcp.js does: JSON over its unix socket. */
function post(socketPath, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body ?? {}))
  })
}

test('available() says which outside runners this machine can start', t => {
  const { runtime } = setup(t)
  assert.deepEqual(runtime({ executables: { claude: process.execPath, codex: '/nonexistent/bin/codex' } }).available(), { claude: true, codex: false })
  assert.deepEqual(runtime({ executables: { claude: 'sh', codex: 'definitely-not-a-real-binary-xyz' } }).available(), { claude: true, codex: false })
})

test('the takeover command is made on demand, names the configured executable, and its bridge answers', async t => {
  const { project, key, external, runtime, turn } = setup(t)
  await turn()
  const binding = project.sessions.get(key)
  assert.equal(binding.externalSessionId, 'native-claude-1')
  assert.match(binding.takeoverCommand, /&& claude --mcp-config '/)

  // A second runtime over the same store is what a restart of the plugin leaves: the stored command points at a
  // bridge that is gone, so the page asks for a fresh one.
  const restarted = runtime({ executables: { claude: '/opt/my tools/claude-kth' } })
  const out = await restarted.takeover(project, key)
  assert.equal(out.provider, 'claude')
  assert.equal(out.label, 'Claude Code')
  assert.equal(out.busy, false)
  const shape = /^cd '.+' && '\/opt\/my tools\/claude-kth' --mcp-config '(.+)' --strict-mcp-config --resume 'native-claude-1'$/
  assert.match(out.command, shape)
  assert.equal(out.command.includes('bypassPermissions'), false)
  const [, socketPath] = JSON.parse(readFileSync(out.command.match(shape)[1], 'utf8')).mcpServers['mira-project'].args
  const listed = await post(socketPath, '/tools')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.tools.some(tool => tool.name === 'update_card'), true)
  const called = await post(socketPath, '/call', { name: 'update_card', args: { state: 'review_ready', summary: '人在终端里接着做完了' } })
  assert.equal(called.status, 200)
  assert.equal(project.threads.get(key.slice(2)).summary, '人在终端里接着做完了')

  assert.match((await runtime({ executables: { claude: '/usr/local/bin/claude-kth' } }).takeover(project, key)).command, /&& \/usr\/local\/bin\/claude-kth --mcp-config '/)
  await assert.rejects(external.takeover(project, 'w:no-such-task'), /还没有可以接着做/)
})

test('a task that comes back to Claude Code picks its own session up again', async t => {
  const { root, store, project, projectId, engineer, key, external, turn, invocations } = setup(t)
  await turn()
  const first = project.sessions.get(key)
  assert.equal(first.externalSessionId, 'native-claude-1')
  assert.equal(invocations()[0].args.includes('--resume'), false)
  assert.equal(invocations()[0].prompt.includes('回到这个任务'), false)

  // In between the task is handed to DSH, which binds its own session and knows nothing of Claude Code's.
  engineer.runtimeSelection = null
  store.append(projectId, { type: 'session.bound', key, sessionId: 'dsh-session-1', node: 'local', assignee: 'engineer', generation: 2, continuity: true, configRevision: project.configRevision ?? 0 })
  assert.equal(project.sessions.get(key).runtime, 'dsh')
  assert.equal(project.sessions.get(key).externalSessionId, null)
  await assert.rejects(external.takeover(project, key), /还没有可以接着做/)

  process.env.FAKE_SESSION = 'native-claude-should-not-be-used'
  engineer.runtimeSelection = { provider: 'claude', deviceId: 'local' }
  await turn('回来接着做')
  const back = project.sessions.get(key)
  assert.notEqual(back.sessionId, first.sessionId)
  assert.equal(back.runtime, 'claude')
  assert.equal(back.externalSessionId, 'native-claude-1')
  assert.equal(project.turns.get(key).failed, false)
  const runs = invocations()
  assert.equal(runs.length, 2)
  assert.deepEqual(runs[1].args.slice(-2), ['--resume', 'native-claude-1'])
  assert.match(runs[1].prompt, /## 回到这个任务/)
  assert.equal(runs[1].prompt.includes('Session Continuity Notice'), false)
  // The stored command stays empty when the runner keeps its session id; the page asks for one instead.
  assert.match((await external.takeover(project, key)).command, /--resume 'native-claude-1'$/)

  // A change of project settings alone also keeps the session, and the next ordinary turn says nothing special.
  project.configRevision = (project.configRevision ?? 0) + 1
  const again = external.ensure(project, key)
  assert.equal(again.returning, true)
  assert.equal(again.binding.externalSessionId, 'native-claude-1')
  assert.equal(external.ensure(project, key).returning, false)

  const replay = new ProjectStore(join(root, 'data'), { warn() {} })
  replay.load()
  assert.deepEqual(runtimeView(replay.get(projectId).sessions.get(key)), runtimeView(project.sessions.get(key)))
  assert.equal(external.earlierSession(replay.get(projectId), key, 'claude'), 'native-claude-1')
  assert.equal(external.earlierSession(replay.get(projectId), key, 'codex'), null)
})

test('a session that cannot be reopened is replaced by a fresh one, once; a failure after the start is not retried', async t => {
  const { project, key, turn, invocations } = setup(t)
  await turn()
  process.env.FAKE_RESUME_FAILS = '1'
  process.env.FAKE_SESSION = 'native-claude-2'
  await turn('再说一句')
  const runs = invocations()
  assert.equal(runs.length, 3)
  assert.deepEqual(runs[1].args.slice(-2), ['--resume', 'native-claude-1'])
  assert.equal(runs[2].args.includes('--resume'), false)
  assert.match(runs[2].prompt, /Session Continuity Notice/)
  assert.equal(project.turns.get(key).failed, false)
  assert.equal(project.sessions.get(key).externalSessionId, 'native-claude-2')
  assert.match(project.sessions.get(key).takeoverCommand, /--resume 'native-claude-2'$/)
  const replies = project.threads.get(key.slice(2)).messageIds.map(id => project.messages.get(id)).filter(message => message.author.kind === 'assistant')
  assert.equal(replies.length, 2)

  delete process.env.FAKE_RESUME_FAILS
  process.env.FAKE_DIES_AFTER_INIT = '1'
  await turn('第三句')
  assert.equal(invocations().length, 4)
  assert.deepEqual(invocations()[3].args.slice(-2), ['--resume', 'native-claude-2'])
  assert.equal(project.turns.get(key).failed, true)
  assert.equal(project.sessions.get(key).externalSessionId, 'native-claude-2')
})
