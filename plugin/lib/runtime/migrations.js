/** Trusted offline schema upgrade. Never called by plugin startup or a node. */
import { PostgresRuntime, RuntimeError } from './postgres.js'

const BASE = ['meta', 'projects', 'events', 'commands', 'wake_targets', 'lease_receipts']
const EXTENSIONS = [
  { tables: ['node_meta', 'nodes', 'node_events', 'node_commands', 'node_runs', 'node_locations'], component: 'mira-execution-nodes' },
  { tables: ['github_meta', 'github_sources', 'github_deliveries'], component: 'mira-github-events' },
]
const fail = (code, message) => { throw new RuntimeError(code, message) }

/**
 * Default is a read-only plan (with bounded table locks for a consistent view).
 * apply requires the trusted operator to have actually stopped every writer,
 * supervisor and execution process, including webhooks and scheduled tasks.
 * The DB cannot attest that a process on another host has stopped. Outstanding
 * claims/runs are refused even after expiry; this function never clears them.
 */
export async function migrateV2ToV3(pool, { schema, apply = false, writersStopped = false, lockTimeoutMs = 5000 } = {}) {
  if (typeof schema !== 'string' || !schema) fail('INVALID_INPUT', '升级需要明确指定独立schema')
  const runtime = new PostgresRuntime(pool, { schema }), s = runtime.s
  if (typeof apply !== 'boolean' || typeof writersStopped !== 'boolean' || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 100 || lockTimeoutMs > 60000) fail('INVALID_INPUT', '升级参数无效')
  if (apply && !writersStopped) fail('OFFLINE_REQUIRED', '先停止控制面、webhook、调度、节点监督者及实际执行进程，再显式声明 writersStopped')
  try {
    return await runtime.transaction(async c => {
      await c.query("SELECT set_config('lock_timeout',$1,true)", [lockTimeoutMs + 'ms'])
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mira-runtime/schema/' + runtime.schema])
      if (!(await c.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [runtime.schema])).rowCount) fail('SCHEMA_NOT_FOUND', 'schema不存在，升级不会创建新库')
      const relations = new Map((await c.query('SELECT relname,relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1', [runtime.schema])).rows.map(r => [r.relname, r.relkind]))
      if (relations.get('meta') !== 'r') fail('FOREIGN_SCHEMA', 'schema没有本组件的普通meta表，保持原样')
      let meta = (await c.query(`SELECT component,version FROM ${s}.meta WHERE singleton`)).rows[0]
      if (meta?.component !== 'mira-projects-runtime') fail('FOREIGN_SCHEMA', 'schema不属于Mira运行时，保持原样')
      if (![2, 3].includes(meta.version)) fail('SCHEMA_VERSION', '只支持显式v2到v3升级')
      if (BASE.some(name => relations.get(name) !== 'r')) fail('SCHEMA_INCOMPLETE', '基础表缺失或类型不符，不能升级')
      const extensions = EXTENSIONS.filter(ext => ext.tables.some(name => relations.has(name)))
      for (const ext of extensions) if (ext.tables.some(name => relations.get(name) !== 'r')) fail('SCHEMA_INCOMPLETE', '扩展表不完整，不能升级')
      // Follow the runtime's node/source -> project lock order, including for
      // plans run while services are online. Locks drain in-flight writes and
      // prevent new claims during the transaction. Offline operation is still
      // required: an already initialized v2 client could write after COMMIT.
      const tables = [...extensions.flatMap(ext => ext.tables), ...BASE]
      await c.query(`LOCK TABLE ${tables.map(name => `${s}."${name}"`).join(',')} IN ACCESS EXCLUSIVE MODE`)
      meta = (await c.query(`SELECT component,version FROM ${s}.meta WHERE singleton`)).rows[0]
      if (meta?.component !== 'mira-projects-runtime') fail('FOREIGN_SCHEMA', 'schema所有权已变化')
      if (![2, 3].includes(meta.version)) fail('SCHEMA_VERSION', 'schema版本已变化')
      for (const ext of extensions) {
        const row = (await c.query(`SELECT component,version FROM ${s}."${ext.tables[0]}" WHERE singleton`)).rows[0]
        if (row?.component !== ext.component || row.version !== 1) fail('SCHEMA_VERSION', '扩展所有权或版本不兼容')
      }
      const hold = (await c.query(`SELECT a.attnotnull,format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attname='execution_hold' AND NOT a.attisdropped`, [runtime.schema + '.wake_targets'])).rows[0]
      if (meta.version === 2 && hold) fail('SCHEMA_VERSION', 'v2已有execution_hold，拒绝猜测或覆盖它的含义')
      if (meta.version === 3 && (!hold || hold.type !== 'text' || hold.attnotnull)) fail('SCHEMA_INCOMPLETE', 'v3执行占用字段不完整')
      const rows = {}
      for (const name of tables.filter(name => name !== 'meta')) rows[name] = (await c.query(`SELECT count(*)::text AS n FROM ${s}."${name}"`)).rows[0].n
      if (meta.version === 3) return { schema: runtime.schema, state: 'current', from: 3, to: 3, ready: true, blockers: [], rows }
      const blockers = []
      if ((await c.query(`SELECT 1 FROM ${s}.wake_targets WHERE lease_owner IS NOT NULL OR lease_until IS NOT NULL OR claimed_through IS NOT NULL OR read_through IS NOT NULL LIMIT 1`)).rowCount) blockers.push('legacy-claims')
      if (extensions.some(ext => ext.tables.includes('nodes'))) {
        if ((await c.query(`SELECT 1 FROM ${s}.nodes WHERE connected_until>clock_timestamp() LIMIT 1`)).rowCount) blockers.push('connected-nodes')
        if ((await c.query(`SELECT 1 FROM ${s}.node_runs WHERE state IN('assigned','running') LIMIT 1`)).rowCount) blockers.push('unfinished-node-runs')
      }
      const result = { schema: runtime.schema, state: 'planned', from: 2, to: 3, ready: blockers.length === 0, blockers, rows,
        requiresStoppedWriters: true, steps: ['add nullable text execution_hold', 'advance schema version to 3 atomically'] }
      if (!apply) return result
      if (blockers.length) fail('MIGRATION_BUSY', '旧认领、节点连接或执行实例尚未结束；升级不会替你清除或确认它们')
      await c.query(`ALTER TABLE ${s}.wake_targets ADD COLUMN execution_hold text`)
      await c.query(`UPDATE ${s}.meta SET version=3 WHERE singleton`)
      return { ...result, state: 'applied' }
    })
  } catch (error) {
    if (error.code === '55P03' || error.code === '40P01') fail('MIGRATION_BUSY', '等待数据库锁超时或锁冲突，升级已回滚，可在写入停止后重试')
    throw error
  }
}
