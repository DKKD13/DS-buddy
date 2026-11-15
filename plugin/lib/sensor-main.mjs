/**
 * v4: the always-on sensor on the owner's machine. It reads that machine's sources (Feishu first, with the owner's
 * own lark-cli login) into the durable device outbox and hands them to Mira's device entrance. It reads nothing
 * while Mira's side has collection off for this device, and keeps unsent records across restarts and outages.
 *
 * Usage: node lib/sensor-main.mjs <private config.json>
 * config: { serverUrl, deviceId, tokenFile, outbox, larkCli?, screenpipe?: { dbPath, imageRoot } }
 */
import { readFileSync, statSync } from 'node:fs'
import { ObservationClient, ObservationRunner, ScreenpipeObservationSource } from './observation-client.js'
import { LarkMessageSource, runLarkCli } from './lark-source.js'

const file = process.argv[2]
if (!file) { console.error('usage: mira-sensor <config.json>');process.exit(2) }
const privateText = path => {
  const stat = statSync(path)
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error(`${path} 须为当前用户私有文件`)
  return readFileSync(path, 'utf8')
}
const config = JSON.parse(privateText(file))
const client = new ObservationClient({ directory: config.outbox, serverUrl: config.serverUrl, deviceId: config.deviceId, token: () => privateText(config.tokenFile).trim() })
const larkRun = args => runLarkCli(args, { bin: config.larkCli || 'lark-cli' })
// Whose messages are the owner's: the account lark-cli is logged in as on this machine.
let self
try { const auth = await larkRun(['auth', 'status']);const user = auth?.identities?.user;if (user?.openId) self = { openId: user.openId, name: user.userName } } catch { /* unmarked until the next start */ }
const sources = [new LarkMessageSource({ run: larkRun, self })]
// The screen, as Screenpipe on this machine records it: once a minute, every window seen, text only (images stay here).
if (config.screenpipe) sources.push(new ScreenpipeObservationSource({ dbPath: config.screenpipe.dbPath, imageRoot: config.screenpipe.imageRoot, intervalMs: 60_000, perWindow: true, maxText: 3000 }))
const runner = new ObservationRunner({ client, sources })
runner.start()
const report = () => { const s = client.status();console.log(new Date().toISOString(), JSON.stringify({ enabled: s.policy.enabled, queued: s.queueEvents, captured: s.captured, lastSentAt: s.lastSentAt, lastError: s.lastError || '' })) }
report()
const timer = setInterval(report, 60_000)
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { clearInterval(timer);await runner.stop();client.close();process.exit(0) })
