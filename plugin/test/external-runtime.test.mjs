import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, workerKey } from '../lib/store.js'
import { Driver } from '../lib/driver.js'
import { Actions } from '../lib/actions.js'
import { createTools } from '../lib/tools.js'
import { ExternalRuntime, runtimeView } from '../lib/external-runtime.js'
import { normalizeMembers } from '../lib/members.js'
import { snapshot } from '../lib/http.js'

const FAKE_CLI = String.raw`
import { spawn } from 'node:child_process'
import { readFileSync, appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const provider = args.includes('exec') ? 'codex' : 'claude'
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\n')
let mcpCommand, mcpArgs
if (provider === 'claude') {
  const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'))
  const server = config.mcpServers['mira-project']
  mcpCommand = server.command;mcpArgs = server.args
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.once('line', () => { lines.close();run().catch(fail) })
} else {
  const entry = args.find(value => value.startsWith('mcp_servers.mira-project.args='))
  mcpCommand = process.execPath;mcpArgs = JSON.parse(entry.slice('mcp_servers.mira-project.args='.length))
  run().catch(fail)
}
function fail(error) { console.error(error);process.exit(1) }
async function run() {
  const child = spawn(mcpCommand, mcpArgs, { stdio: ['pipe', 'pipe', 'ignore'] })
  const pending = new Map()
  let id = 0
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', line => {
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
  const listed = await rpc('tools/list', {})
  if (!listed.result.tools.some(tool => tool.name === 'update_card')) throw new Error('update_card missing')
  const call = async (name, args) => {
    const response = await rpc('tools/call', { name, arguments: args })
    if (response.result.isError) throw new Error(response.result.content[0].text)
    return response.result.content[0].text
  }
  await call('inbox_read', {})
  await call('update_card', { state: 'review_ready', summary: provider + ' 已完成' })
  await call('post_message', { text: provider + ' 已交付' })
  child.stdin.end();child.kill()
  const sessionId = process.env.FAKE_SESSION || (provider === 'claude' ? 'native-claude-1' : 'native-codex-1')
  if (provider === 'claude') {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }))
    console.log(JSON.stringify({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'call-1', name: 'mcp__mira-project__post_message', input: {} }] } }))
    console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId, result: '最终回答', is_error: false }))
    process.stdin.end()
  } else {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: sessionId }))
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'command-1', item_type: 'commandExecution', command: 'true', status: 'completed' } }))
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'message-1', item_type: 'agentMessage', text: '最终回答' } }))
    console.log(JSON.stringify({ type: 'turn.completed', usage: {} }))
  }
}
`

for (const provider of ['claude', 'codex']) {
  test(`${provider}: external turns call scoped tools, resume natively and survive replay`, async t => {
    const root = mkdtempSync(join(tmpdir(), `mira-external-${provider}-`))
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
    const external = new ExternalRuntime(ctx, store, driver, actions, tools, {
      root: join(root, 'runtime'),
      // The runner's environment is an allow-list, so the stand-in's own switches are handed over here, by the test.
      spawn: (_command, args, options) => spawn(process.execPath, [fakePath, ...args], { ...options, env: { ...options.env, ...Object.fromEntries(['FAKE_LOG', 'FAKE_SESSION'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])) } }),
      timeoutMs: 20_000, inactivityMs: 10_000,
    })
    driver.external = external
    t.after(async () => { await external.stop();delete process.env.FAKE_LOG;rmSync(root, { recursive: true, force: true }) })

    const { projectId } = actions.createProject({ name: '外部执行' })
    const project = store.get(projectId)
    project.members.find(member => member.id === 'engineer').runtimeSelection = { provider, deviceId: 'local' }
    const { threadId } = actions.openThread(project, { title: '验证接入', brief: '走一遍', assignee: '工程师' })
    const key = workerKey(threadId)
    const slot = { running: false, again: false, reason: 'spawn', wokenThrough: 0 }
    await driver.run(projectId, key, slot)
    const binding = project.sessions.get(key)
    const nativeId = provider === 'claude' ? 'native-claude-1' : 'native-codex-1'
    assert.equal(binding.runtime, provider)
    assert.equal(binding.externalSessionId, nativeId)
    assert.match(binding.takeoverCommand, new RegExp(`resume.*${nativeId}`))
    assert.equal(project.threads.get(threadId).state, 'review_ready')
    assert.equal(project.cursors.get(key) > 0, true)
    assert.equal(project.turns.get(key).failed, false)
    assert.equal(project.events.some(event => event.type === 'runtime.event' && event.kind === 'tool'), true)

    actions.ownerPost({ projectId, threadId, text: '再说一句' })
    slot.reason = 'message'
    await driver.run(projectId, key, slot)
    const replies = project.threads.get(threadId).messageIds.map(id => project.messages.get(id)).filter(message => message.author.kind === 'assistant')
    assert.equal(replies.length, 2)
    assert.equal(replies.every(message => message.text === `${provider} 已交付`), true)
    const invocations = readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(invocations.length, 2)
    if (provider === 'claude') {
      assert.deepEqual(invocations[1].slice(-2), ['--resume', nativeId])
      assert.equal(invocations[1].includes(nativeId) && invocations[0].includes(nativeId), false)
    } else {
      assert.deepEqual(invocations[1].slice(0, 3), ['exec', 'resume', nativeId])
      assert.deepEqual(invocations[0].slice(0, 1), ['exec'])
    }

    const view = snapshot(store, driver, projectId).project.threads[0]
    assert.equal(view.runtime.provider, provider)
    assert.equal(view.runtime.externalSessionId, nativeId)
    assert.equal(view.runtime.takeoverCommand, binding.takeoverCommand)
    assert.equal(view.timeline.some(row => row.text?.startsWith('外部执行：')), true)

    const replay = new ProjectStore(join(root, 'data'), { warn() {} })
    replay.load()
    assert.deepEqual(runtimeView(replay.get(projectId).sessions.get(key)), runtimeView(binding))
  })
}

test('runtime selection is restricted to local workers', () => {
  const previous = [
    { id: 'owner', kind: 'human', name: '我' },
    { id: 'coordinator', kind: 'assistant', role: 'coordinator', name: '项目助理', persona: '', active: true },
    { id: 'engineer', kind: 'assistant', role: 'worker', name: '工程师', persona: '', active: true },
    { id: 'mira', kind: 'assistant', role: 'memory', name: 'Mira', persona: '', active: true },
  ]
  const input = previous.filter(member => member.kind === 'assistant').map(({ id, name, role, persona }) => ({ id, name, role, persona }))
  const configured = normalizeMembers(input.map(member => member.id === 'engineer' ? { ...member, runtimeSelection: { provider: 'codex', deviceId: 'local' } } : member), previous)
  assert.deepEqual(configured.find(member => member.id === 'engineer').runtimeSelection, { provider: 'codex', deviceId: 'local' })
  assert.throws(() => normalizeMembers(input.map(member => member.id === 'coordinator' ? { ...member, runtimeSelection: { provider: 'claude' } } : member), previous), /只有执行者/)
  assert.throws(() => normalizeMembers(input.map(member => member.id === 'engineer' ? { ...member, runtimeSelection: { provider: 'other' } } : member), previous), /运行方式/)
})
