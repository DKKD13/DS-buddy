/**
 * v4: the read-only file reader on the owner's computer, as a process. It dials out to Mira's device entrance (the
 * same SSH tunnel and device token the sensor uses), waits for a read request from the personal assistant and
 * answers it from the folders listed in this machine's private config. Stopping this process is the hard off switch.
 *
 * Usage: node lib/mac-reader-main.mjs <private config.json>
 * config: { serverUrl, tokenFile, roots: [{ name, label, path, whole? }], log? }  (whole: the home folder itself, 全部文件)   (paths may start with ~/)
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MacReader, MacReaderClient } from './mac-reader.mjs'

const file = process.argv[2]
if (!file) { console.error('usage: mira-reader <config.json>');process.exit(2) }
const privateText = path => {
  const stat = statSync(path)
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error(`${path} 须为当前用户私有文件`)
  return readFileSync(path, 'utf8')
}
const expand = path => typeof path === 'string' && (path === '~' || path.startsWith('~/')) ? join(homedir(), path.slice(1)) : path
const config = JSON.parse(privateText(file))
const reader = new MacReader({ roots: (config.roots ?? []).map(root => ({ ...root, path: expand(root?.path) })), logFile: expand(config.log) })
const tokenFile = expand(config.tokenFile)
const client = new MacReaderClient({ reader, serverUrl: config.serverUrl, token: () => privateText(tokenFile).trim() })
const report = () => console.log(new Date().toISOString(), JSON.stringify({ folders: reader.describe().map(root => root.name), served: client.served, lastError: client.lastError }))
report()
const timer = setInterval(report, 60_000)
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { clearInterval(timer);client.stop() })
await client.run()
process.exit(0)
