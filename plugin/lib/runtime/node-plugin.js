/** One prebound DSH session inside a container, with no database or model key. */
import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ProjectStore } from '../store.js'
import { createTools, visibleTo } from '../tools.js'
import { rolePrompt, wakeText, continuityNotice, NUDGE, UNANSWERED } from '../protocol.js'
import { NodeClient } from './node-client.js'
import { readWorkspaceFile, FILE_CHUNK_BYTES } from '../files.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const NATIVE = new Set(['read', 'read_image', 'write', 'edit', 'bash', 'grep', 'glob'])

export async function applyContainerNode(ctx) {
  const remote = new NodeClient(process.env.MIRA_NODE_SOCKET, process.env.MIRA_NODE_CAPABILITY)
  const hello = await remote.rpc({ op: 'hello' }), store = new ProjectStore('', ctx.logger)
  let after = 0
  while (after < hello.throughSeq) {
    const page = await remote.rpc({ op: 'events', after, through: hello.throughSeq })
    if (page.readThrough <= after) throw new Error('Node event replay made no progress')
    for (const event of page.events) store.apply(event)
    after = page.readThrough
  }
  const project = store.get(hello.projectId), turn = { platform: false, replied: false, end: null, error: null }
  const defs = createTools({ defineTool: d => d, store, driver: {}, actions: {}, files: hello.projectFiles ? {} : null, devices: hello.projectDevices ? {} : null }).filter(t => visibleTo(store, t.role)({ agent: { id: hello.sessionId } }))
  const platform = new Set(defs.map(t => t.definition.name)), allowed = new Set([...platform, ...(hello.nativeExecution ? NATIVE : [])])
  const preset = 'mira-container-session'
  let controller, presetReady = false, running = false
  ctx.tools.guard(exec => exec.agent?.id !== hello.sessionId || !allowed.has(exec.name) ? 'Container node only permits its assigned session capabilities' : undefined)
  ctx.on('session/event', (session, event) => {
    if (session.id === hello.sessionId && event.type === 'turn/end') turn.end = event.data.reason.kind
  })
  ctx.on('agent/created', ({ agent }) => {
    if (agent.id !== hello.sessionId) return
    const inherited = ctx.tools.schemas().map(tool => tool.name).filter(name => name !== 'run_code')
    if (inherited.length) agent.ctx.tools.restrict({ deny: inherited })
    agent.ctx.tools.presentAs('native')
    agent.ctx.systemPrompt.section({ name: 'mira-projects:container-role', order: 10100, interpolate: false, text: rolePrompt(project, hello.key) })
    agent.ctx.on('agent/error', ({ error }) => { turn.error = error || new Error('DSH turn failed') })
    for (const { definition } of defs) agent.ctx.tools.register(defineTool({ ...definition, execute: async (args, exec) => {
      const requestId = 'tool-' + digest(agent.id + '/' + exec.callId)
      let blobSha
      if (definition.name === 'inbox_read') return (await remote.rpc({ op: 'inbox', requestId, limit: args.limit, peek: args.peek })).text
      if (definition.name === 'artifact_publish') {
        const bytes = await readWorkspaceFile('/workspace/project', args.source_path ?? args.path), chunks = []
        for (let offset = 0; offset < bytes.length; offset += FILE_CHUNK_BYTES) chunks.push((await remote.rpc({ op: 'fileChunk', data: bytes.subarray(offset, offset + FILE_CHUNK_BYTES).toString('base64') })).sha256)
        const sha256 = digest(bytes)
        await remote.rpc({ op: 'fileAssemble', chunks, sha256, size: bytes.length })
        blobSha = sha256
      }
      const saved = await remote.rpc(blobSha ? { op: 'publishArtifact', requestId, args, blobSha } : { op: 'tool', requestId, tool: definition.name, args })
      turn.platform ||= saved.value.platform;turn.replied ||= saved.value.replied
      if (saved.value.concluded) exec.concludeTurn?.()
      return saved.value.result
    } }))
    const nativeRecord = (exec, stage, ok) => remote.rpc({ op: 'native', requestId: 'native-' + digest(agent.id + '/' + exec.callId + '/' + stage),
      callId: exec.callId, tool: exec.name, stage, fingerprint: digest(JSON.stringify(exec.arguments)), ...(stage === 'finished' ? { ok } : {}) })
    agent.ctx.on('tools/pre-execute', async (exec, next) => {
      if (NATIVE.has(exec.name)) await nativeRecord(exec, 'started')
      return next()
    }, { prepend: true })
    agent.ctx.on('tools/post-execute', async (exec, result, next) => {
      if (NATIVE.has(exec.name)) await nativeRecord(exec, 'finished', !result.isError)
      return next()
    })
  })
  ctx.inject(['agentPresets'], presetCtx => {
    presetCtx.effect(async () => {
      const plugins = [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a Mira project assistant.', complete: true, includeRuntimeContext: false } },
        { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
        ...(hello.nativeExecution ? [{ id: 'bash', name: '@deepseek-ai/dsh-tool-bash' }, { id: 'fs', name: '@deepseek-ai/dsh-tool-fs' }, { id: 'search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } }] : []),
      ]
      const dispose = await presetCtx.agentPresets.register({ id: preset, plugins })
      presetReady = true
      return () => { presetReady = false;return dispose() }
    }, 'mira node: isolated session preset')
  })
  ctx.inject(['sessionController'], webCtx => {
    webCtx.effect(() => { controller = webCtx.sessionController;return () => { controller = null } }, 'mira node: session controller')
  })
  const run = async () => {
    if (!hello.resume) {
      const created = await controller.create({ sessionId: hello.sessionId, cwd: '/workspace/project', agentPreset: preset })
      if (created.sessionId !== hello.sessionId) throw new Error('DSH did not honor the assigned session id')
    }
    const resolved = await controller.resolveAgent(hello.sessionId)
    if ('error' in resolved) throw resolved.error
    const agent = resolved.agent
    const unexpected = agent.ctx.tools.schemas().map(t => t.name).filter(name => !allowed.has(name))
    if (unexpected.length) throw new Error('Container preset exposed unexpected tools: ' + unexpected.join(','))
    await ctx.sessions.flush(agent.session)
    await remote.rpc({ op: 'ready' })
    const unread = store.unread(project, hello.key)
    const addressed = unread.some(e => e.type === 'message.posted' && e.author?.kind === 'human' && e.to?.includes(hello.key))
    const deliver = async text => {
      turn.end = null
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'mira-projects-container' } }))
      await agent.whenIdle();await ctx.sessions.flush(agent.session)
      if (turn.error || turn.end !== 'completed') throw turn.error || new Error('DSH did not complete the node turn normally')
    }
    await deliver(wakeText(project, hello.key, unread, 'container', hello.resume ? '' : project.sessions.get(hello.key)?.continuity ? continuityNotice(project, hello.key) : ''))
    let nudged = false, unanswered = false
    if (!turn.platform) { nudged = true;await deliver(NUDGE) }
    else if (addressed && !turn.replied) { nudged = true;unanswered = true;await deliver(UNANSWERED) }
    if (!turn.platform) throw new Error('Node wake ended without a platform tool')
    await remote.rpc({ op: 'complete', turn: { silent: false, nudged, unanswered } })
    // The supervisor must still verify Docker has stopped before it acknowledges.
    setImmediate(() => process.exit(0))
  }
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (running || !controller || !presetReady) return
      running = true;clearInterval(timer)
      ctx.agents.withoutInitiator(run).catch(error => { console.error('mira node failed:', error.message);ctx.logger.warn('mira node failed', error);setImmediate(() => process.exit(1)) })
    }, 100)
    return () => clearInterval(timer)
  }, 'mira node: one assigned wake')
}
