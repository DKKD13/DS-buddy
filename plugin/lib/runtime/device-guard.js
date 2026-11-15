/** Root PID1 watchdog. Device commands run as the configured non-root user. */
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { spawn } from 'node:child_process'

const input = JSON.parse(readFileSync('/request.json', 'utf8'))
if (!Number.isSafeInteger(input.uid) || input.uid < 1 || !Number.isSafeInteger(input.gid) || input.gid < 1) process.exit(71)
const operationMs = input.args?.timeoutMs ?? (input.op === 'exec' ? 10000 : 5000)
if (!Number.isSafeInteger(operationMs) || operationMs < 100 || operationMs > 60000) process.exit(71)
let polling = false, child, done = false
function exit() { process.exit(70) }
async function health() {
  if (Date.now() >= input.grant.expiresAt) exit()
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: '/run/mira/control.sock', path: '/health', method: 'POST', agent: false, headers: { authorization: 'Bearer ' + input.healthToken } }, res => {
      let value = '';res.setEncoding('utf8');res.on('data', data => { value += data;if (value.length > 1024) req.destroy() })
      res.on('end', () => { try { res.statusCode === 200 && JSON.parse(value).valid === true ? resolve() : reject(new Error('revoked')) } catch { reject(new Error('closed')) } })
      res.on('error', reject)
    });req.setTimeout(1000, () => req.destroy());req.on('error', reject);req.end()
  })
}
try { await health() } catch { exit() }
// PID1 exits the whole namespace, including setsid/background descendants.
// This clock begins after preparation and remains independent of network IO.
const operationTimer = setTimeout(() => process.exit(72), operationMs)
const timer = setInterval(async () => {
  if (polling || done) return
  polling = true
  try { await health() } catch { exit() } finally { polling = false }
}, 250)
try {
  child = spawn(process.execPath, ['/opt/mira/plugin/lib/runtime/device-worker.js'], { uid: input.uid, gid: input.gid, stdio: ['pipe','pipe','pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/tmp' } })
  const output = [];let size = 0
  child.stdout.on('data', b => { size += b.length;if (size > 1024 * 1024) exit();output.push(b) })
  child.stderr.on('data', () => {})
  child.on('error', exit)
  child.on('close', code => {
    done = true;clearInterval(timer);clearTimeout(operationTimer)
    try { const result = JSON.parse(Buffer.concat(output).toString('utf8'));if (code !== 0 || !result || typeof result.ok !== 'boolean') exit();process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0)) }
    catch { exit() }
  })
  child.stdin.on('error', exit)
  child.stdin.end(JSON.stringify({ op: input.op, args: input.args, grant: input.grant }))
} catch { exit() }
