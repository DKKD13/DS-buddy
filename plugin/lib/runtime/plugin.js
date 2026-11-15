/** Explicit opt-in lab profile; it never mirrors or imports the JSONL store. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ProjectStore } from '../store.js'
import { snapshot } from '../http.js'
import { PostgresRuntime } from './postgres.js'
import { ProjectControl } from './control.js'
import { PostgresSessionHost } from './host.js'
import { DeviceBroker } from './device-broker.js'
import { createFileBlobs, postgresBlobLock } from '../storage.js'
import { BlobMaintenance, liveBlobKeysFromRows } from '../blob-maintenance.js'

const respond = (value, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export async function applyPostgresLab(ctx, config) {
  if (!config.runtimeSchema) throw new Error('Postgres lab requires an explicit isolated schema')
  if (!process.env.MIRA_PG_CONFIG || !process.env.MIRA_PG_MODULE) throw new Error('Postgres lab requires private Pool configuration and pg module paths')
  const module = await import(pathToFileURL(process.env.MIRA_PG_MODULE).href)
  const Pool = module.Pool ?? module.default.Pool
  const pool = new Pool({ ...JSON.parse(readFileSync(process.env.MIRA_PG_CONFIG, 'utf8')), max: 8, connectionTimeoutMillis: 5000 })
  const runtime = new PostgresRuntime(pool, { schema: config.runtimeSchema })
  try { await runtime.initialize() } catch (error) { await pool.end();throw error }
  let blobs
  try {
    if (!process.env.DSH_HOME && !config.runtimeFiles) throw new Error('Postgres file storage needs an explicit DSH_HOME or runtimeFiles root')
    blobs = await createFileBlobs({ backend: config.runtimeFileBackend ?? 'fs', root: config.runtimeFiles ?? join(process.env.DSH_HOME, 'mira-runtime-files', config.runtimeSchema),
      quotaBytes: config.runtimeFileQuotaBytes, lock: postgresBlobLock(pool, config.runtimeSchema), configPath: process.env.MIRA_S3_CONFIG })
    if (config.runtimeFileQuotaBytes !== undefined || config.runtimeFileGcIntervalMs !== undefined) {
      const maintenance = new BlobMaintenance(blobs, { quotaBytes: config.runtimeFileQuotaBytes, retentionMs: config.runtimeFileRetentionMs,
        liveKeys: async () => liveBlobKeysFromRows((await pool.query(`SELECT project_id,data FROM ${runtime.s}.events WHERE event_type=ANY($1)`, [['file.published', 'repository.imported']])).rows, blobs) })
      const timer = setInterval(() => maintenance.collect().catch(error => ctx.logger.warn('项目文件GC失败', error)), config.runtimeFileGcIntervalMs ?? 60 * 60 * 1000)
      timer.unref();ctx.effect(() => () => clearInterval(timer), 'mira runtime: file maintenance')
    }
  } catch (error) { await pool.end();throw error }
  const control = new ProjectControl(runtime, { blobs })
  let devices
  try { if(config.runtimeDevices){devices=new DeviceBroker(control);await devices.initialize()} } catch(error){await pool.end();throw error}
  const host = new PostgresSessionHost(ctx, control, { defineTool,
    makeMessage: content => createUserMessage({ content, source: { kind: 'mira-projects-runtime' } }) })
  // Also fence old sessions restored outside the claim loop. A persisted DSH
  // session is not permission to execute without a current host-owned lease.
  ctx.effect(() => ctx.tools.guard(exec => {
    const slot = host.slots.get(exec.agent?.id)
    return !slot || slot.lost || host.stopped ? 'Postgres lab requires a current host-owned project claim' : undefined
  }), 'mira runtime: profile execution boundary')
  ctx.on('agent/created', ({ agent }) => host.register(agent))
  ctx.on('session/event', (session, event) => host.observe(session, event))
  ctx.inject(['agentPresets'], presetCtx => {
    presetCtx.effect(async () => {
      const dispose = await presetCtx.agentPresets.register({ id: host.preset, name: 'Mira Postgres platform lab', plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a Mira project assistant.', complete: true, includeRuntimeContext: false } },
        { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
      ] })
      host.presetReady = true
      return async () => { host.presetReady = false;await host.stop();await dispose() }
    }, 'mira runtime: platform-only preset')
  })
  ctx.inject(['sessionController'], webCtx => {
    webCtx.effect(() => {
      host.controller = webCtx.sessionController
      return () => { host.controller = null }
    }, 'mira runtime: DSH controller')
  })
  if(config.runtimeHost!==false)ctx.effect(() => host.start(), 'mira runtime: claim loop')
  ctx.effect(() => async () => { await host.stop();await pool.end() }, 'mira runtime: database lifecycle')
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/mira-runtime/state', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    const url = new URL(request.url), projectId = url.searchParams.get('projectId')
    const store = new ProjectStore('', ctx.logger)
    const events = await pool.query(`SELECT data FROM ${runtime.s}.events ORDER BY project_id,seq`)
    for (const row of events.rows) store.apply(JSON.parse(row.data))
    store.rev = events.rowCount
    const wakes = (await pool.query(`SELECT project_id,key,lease_owner IS NOT NULL AND lease_until>clock_timestamp() AS active,
      requested_through>GREATEST(cursor,announced_through) AS queued FROM ${runtime.s}.wake_targets`)).rows
    const driver = {
      status: (id, key) => {
        const wake = wakes.find(row => row.project_id === id && row.key === key)
        return wake?.active ? 'running' : wake?.queued ? 'queued' : 'idle'
      }, childrenOf: () => [], memberModel: () => null,
    }
    const deviceExecutions = await devices?.executionStates([...store.projects.values()])
    const value=snapshot(store,driver,projectId,undefined,undefined,deviceExecutions)
    if(devices&&value.project)value.project.devices=await devices.snapshot(projectId)
    return respond({ ...value, runtime: { kind: 'postgres-lab', nativeExecution: false, containerized: false, hub: false } })
  } }), 'mira runtime: owner state')
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/mira-runtime/action', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    try {
      const body = await request.json(), { projectId: supplied, requestId = randomUUID(), expectedSeq, ...command } = body
      const projectId = supplied ?? (command.op === 'createProject' ? 'p_' + createHash('sha256').update(requestId).digest('hex').slice(0, 24) : undefined)
      const result = await control.submit(projectId, { kind: 'owner' }, command, { requestId, expectedSeq })
      return respond({ ...result.value, projectId, headSeq: result.headSeq, replayed: result.replayed })
    } catch (error) { return respond({ error: String(error?.message ?? error), code: error.code ?? 'INVALID_INPUT' }, 400) }
  } }), 'mira runtime: owner commands')
}
