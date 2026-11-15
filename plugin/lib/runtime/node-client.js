import { request, createServer } from 'node:http'

export class NodeClient {
  constructor(socketPath, token) { this.socketPath = socketPath;this.token = token }
  rpc(value, { timeoutMs = value.op === 'tool' && value.tool?.startsWith('device_') ? 75000 : 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, path: '/rpc', method: 'POST', agent: false, headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' } }, res => {
        const chunks = [];let size = 0
        res.on('data', chunk => { size += chunk.length;if (size > 8 * 1024 * 1024) req.destroy(new Error('Node response exceeds limit'));else chunks.push(chunk) })
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (res.statusCode !== 200) { const error = new Error(result.error ?? 'Node request failed');error.code = result.code;reject(error) }
            else resolve(result)
          } catch { reject(new Error('Invalid node response')) }
        })
        res.on('error', reject)
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Node request timed out')))
      req.on('error', reject);req.end(JSON.stringify(value))
    })
  }
  /** Loopback model adapter inside a network-disabled container, via one UDS. */
  async modelBridge(port = 18400) {
    const server = createServer((incoming, response) => {
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') { response.writeHead(404);response.end();return }
      const outgoing = request({ socketPath: this.socketPath, path: '/model', method: 'POST', agent: false, headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' } }, upstream => {
        response.writeHead(upstream.statusCode, { 'content-type': upstream.headers['content-type'] ?? 'application/json' })
        upstream.pipe(response)
      })
      let size = 0
      incoming.on('data', chunk => { size += chunk.length;if (size > 2 * 1024 * 1024) { outgoing.destroy();response.destroy() } })
      incoming.pipe(outgoing)
      outgoing.setTimeout(190000, () => outgoing.destroy())
      outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502);response.end() })
      response.on('close', () => { if (!response.writableEnded) outgoing.destroy() })
    })
    await new Promise((resolve, reject) => { server.once('error', reject);server.listen(port, '127.0.0.1', resolve) })
    return server
  }
}
