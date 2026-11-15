/** Container PID 1: a private profile, local model bridge, and one real DSH. */
import { mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { NodeClient } from './node-client.js'
import { createHash } from 'node:crypto'
import { checkoutRepository } from '../repositories.js'
import { MAX_FILE_BYTES } from '../files.js'

const token = process.env.MIRA_NODE_CAPABILITY, socket = process.env.MIRA_NODE_SOCKET
if (!token || !socket) throw new Error('Container node needs its scoped capability socket')
const remote = new NodeClient(socket, token), hello = await remote.rpc({ op: 'hello' })
let child, checking = false
const watchdog = setInterval(async () => {
  if (checking) return
  checking = true
  try { await remote.rpc({ op: 'health' }, { timeoutMs: 2500 }) }
  catch { child?.kill('SIGKILL');setTimeout(() => process.exit(1), 100) }
  finally { checking = false }
}, 2000)
const bridge = await remote.modelBridge()
const profile = '/workspace/.dsh/profiles/mira-node'
mkdirSync(profile, { recursive: true });mkdirSync('/workspace/project', { recursive: true })
if (hello.repository) {
  const options = { destination: '/workspace/project', repository: hello.repository, requireExisting: hello.resume,
    branch: 'codex/mira-' + createHash('sha256').update(hello.projectId + '/' + hello.key).digest('hex').slice(0, 24),
    assertCurrent: () => remote.rpc({ op: 'health' }, { timeoutMs: 2500 }) }
  try { await checkoutRepository(options) }
  catch (error) {
    if (error.code !== 'REPOSITORY_DATA_REQUIRED') throw error
    const chunks = [];let offset = 0, size = 0
    while (true) {
      const part = await remote.rpc({ op: 'fileReadChunk', file_id: hello.repository.fileId, revision: hello.repository.fileRevision, offset })
      if (part.file.sha256 !== hello.repository.sha256) throw new Error('Repository bytes differ from the bound snapshot')
      const bytes = Buffer.from(part.data, 'base64');size += bytes.length
      if (size > MAX_FILE_BYTES) throw new Error('Repository bundle exceeds the file limit')
      chunks.push(bytes)
      if (part.nextOffset === null) break
      if (!Number.isSafeInteger(part.nextOffset) || part.nextOffset <= offset) throw new Error('Repository transfer made no progress')
      offset = part.nextOffset
    }
    await checkoutRepository({ ...options, bytes: Buffer.concat(chunks, size) })
  }
}
writeFileSync(profile + '/package.json', JSON.stringify({ name: 'mira-container-node-profile', private: true, type: 'module',
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-mira-projects'] } },
  dependencies: { '@deepseek-ai/dsh-base': '0.2.1-rc.5', '@deepseek-ai/dsh-web-app': '0.2.1-rc.5', 'dsh-mira-projects': 'file:/opt/mira/plugin' } }))
if (!existsSync(profile + '/node_modules')) symlinkSync('/opt/dsh/node_modules', profile + '/node_modules')
writeFileSync(profile + '/cordis.patch.yml', JSON.stringify([
  { id: 'mira-projects', config: { runtime: 'container-node' } },
  { id: 'hmr', disabled: true },
  { id: 'tool-working-directory', disabled: true },
  { id: 'llm-pi-ai', config: { providers: { node: { apiKeyEnv: 'MIRA_NODE_CAPABILITY', api: 'openai-completions', baseURL: 'http://127.0.0.1:18400/v1',
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' }, models: [{ id: hello.model, contextWindow: 262144, maxTokens: 16384 }] } } } },
  { id: 'agent-default-model', config: { provider: 'node', model: hello.model } },
]))
child = spawn('node', ['/opt/dsh/lib/bin.js', '--profile', 'mira-node', '--no-open', '--host', '127.0.0.1', '--port', '18080'], { cwd: '/workspace/project', stdio: 'inherit', env: process.env })
const deadline = setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000)
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => { clearTimeout(watchdog);clearTimeout(deadline);bridge.close();if (code !== 0) console.error('DSH child exited:', code, signal);process.exit(code === 0 ? 0 : 1) })
child.on('error', () => { bridge.close();process.exit(1) })
