import { request } from 'node:http'
import { createInterface } from 'node:readline'

const socketPath = process.argv[2]
if (!socketPath) throw new Error('MIRA runtime socket is required')

function callParent(path, body) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const value = JSON.parse(data)
          if (res.statusCode !== 200) reject(new Error(value.error || `MIRA bridge returned ${res.statusCode}`))
          else resolve(value)
        } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(120_000, () => req.destroy(new Error('MIRA bridge request timed out')))
    req.end(JSON.stringify(body ?? {}))
  })
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

async function handle(message) {
  if (!message || typeof message !== 'object') return
  const { id, method, params } = message
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (id === undefined) return
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mira-project', version: '1.0.0' },
        instructions: '这些工具只操作当前项目任务。被唤醒后先 inbox_read；对用户说话用 post_message；交付用 update_card。',
      } })
      return
    }
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return }
    if (method === 'tools/list') {
      const result = await callParent('/tools', {})
      send({ jsonrpc: '2.0', id, result })
      return
    }
    if (method === 'tools/call') {
      try {
        const value = await callParent('/call', { name: params?.name, args: params?.arguments ?? {}, callId: String(id), clientId: process.pid })
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(value.text ?? '') }] } })
      } catch (error) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true } })
      }
      return
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message ?? error) } })
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  if (!line.trim()) return
  try { handle(JSON.parse(line)) } catch { /* malformed input is not a JSON-RPC request */ }
})
