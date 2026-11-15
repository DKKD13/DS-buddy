#!/usr/bin/env node
/** Trusted offline entry point. Credentials are read only from private files. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { migrateV2ToV3 } from './migrations.js'
import { RuntimeError } from './postgres.js'

let pool
try {
  const { values } = parseArgs({ options: {
    schema: { type: 'string' }, apply: { type: 'boolean' }, 'writers-stopped': { type: 'boolean' },
    'lock-timeout-ms': { type: 'string', default: '5000' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('node migrate-cli.js --schema SCHEMA [--apply --writers-stopped] [--lock-timeout-ms 5000]\nDefault: plan only. Stop all old writers and execution processes before applying.\nPrivate connection: MIRA_PG_CONFIG; installed pg module: MIRA_PG_MODULE.')
  } else {
    if (!values.schema) throw new RuntimeError('INVALID_INPUT', '必须明确指定 --schema')
    if (values.apply && !values['writers-stopped']) throw new RuntimeError('OFFLINE_REQUIRED', '实际升级前必须停止所有旧服务和执行进程，再传 --writers-stopped')
    if (!process.env.MIRA_PG_CONFIG || !process.env.MIRA_PG_MODULE) throw new RuntimeError('INVALID_INPUT', '缺少私有数据库配置或pg模块路径')
    const pg = await import(pathToFileURL(process.env.MIRA_PG_MODULE).href)
    const Pool = pg.Pool ?? pg.default.Pool
    pool = new Pool({ ...JSON.parse(readFileSync(process.env.MIRA_PG_CONFIG, 'utf8')), max: 1, connectionTimeoutMillis: 5000 })
    const result = await migrateV2ToV3(pool, { schema: values.schema, apply: values.apply ?? false,
      writersStopped: values['writers-stopped'] ?? false, lockTimeoutMs: Number(values['lock-timeout-ms']) })
    console.log(JSON.stringify(result))
    if (!result.ready) process.exitCode = 2
  }
} catch (error) {
  // Driver/parser/module errors can include connection URLs or private config.
  console.error(JSON.stringify({ state: 'failed', code: error instanceof RuntimeError ? error.code : 'UNAVAILABLE',
    error: error instanceof RuntimeError ? error.message : '数据库升级未完成；未公开底层连接或驱动错误' }))
  process.exitCode = 1
} finally { if (pool) await pool.end() }
