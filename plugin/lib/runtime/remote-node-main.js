/** Run with a private provisioned configuration, outside all worker mounts. */
import { readFileSync, appendFileSync } from 'node:fs'
import { RemoteContainerNode } from './remote-node.js'

if (!process.env.MIRA_NODE_CONFIG) throw new Error('MIRA_NODE_CONFIG must point to a private node configuration')
const config = JSON.parse(readFileSync(process.env.MIRA_NODE_CONFIG, 'utf8'))
const node = new RemoteContainerNode({ ...config, ca: readFileSync(config.caFile), onChange: value => {
  if (config.eventFile) appendFileSync(config.eventFile, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 })
} })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => node.stop())
try { await node.run() }
catch (error) { console.error('Remote node stopped:', error.code ?? '', error.message);process.exitCode = 1 }
