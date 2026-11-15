/** Pinned, verified TLS client; there is deliberately no insecure transport mode. */
import { request } from 'node:https'
import { createServer } from 'node:http'
import { chmod, unlink } from 'node:fs/promises'
import { checkServerIdentity } from 'node:tls'

export class NodeEndpoint {
  constructor({ url, ca, credential }) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !ca) throw new Error('Verified HTTPS origin and CA certificate are required')
    this.origin = parsed.origin;this.ca = ca;this.credential = credential
  }
  outgoing(path, credential, callback) {
    return request(new URL(path, this.origin), { method: 'POST', ca: this.ca, rejectUnauthorized: true, checkServerIdentity, minVersion: 'TLSv1.3', agent: false,
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' } }, callback)
  }
  rpc(input, { credential = this.credential, path = '/node', timeoutMs = 7000 } = {}) {
    return new Promise((resolve, reject) => {
      const req = this.outgoing(path, credential, res => {
        const chunks = [];let size = 0
        res.on('data', chunk => { size += chunk.length;if (size > 8 * 1024 * 1024) req.destroy();else chunks.push(chunk) })
        res.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (res.statusCode !== 200) { const error = new Error(value.error ?? 'Node request failed');error.code = value.code;reject(error) }
            else resolve(value)
          } catch { reject(Object.assign(new Error('Invalid node response'), { code: 'NETWORK' })) }
        })
        res.on('error', () => reject(Object.assign(new Error('Node connection closed'), { code: 'NETWORK' })))
      })
      req.setTimeout(timeoutMs, () => req.destroy())
      req.on('error', () => reject(Object.assign(new Error('Verified node connection unavailable'), { code: 'NETWORK' })))
      req.end(JSON.stringify(input))
    })
  }
  /** A worker sees only this socket and its own job token, never node credentials. */
  async relay(socketPath, jobToken) {
    const server = createServer((incoming, response) => {
      if (incoming.method !== 'POST' || !['/rpc', '/model'].includes(incoming.url)) { incoming.resume();response.writeHead(403);response.end();return }
      const outgoing = this.outgoing(incoming.url, jobToken, upstream => {
        response.writeHead(upstream.statusCode, { 'content-type': upstream.headers['content-type'] ?? 'application/json' });upstream.pipe(response)
      })
      let size = 0
      incoming.on('data', chunk => { size += chunk.length;if (size > 2 * 1024 * 1024) { outgoing.destroy();response.destroy() } })
      incoming.pipe(outgoing)
      outgoing.setTimeout(incoming.url === '/model' ? 190000 : 75000, () => outgoing.destroy())
      outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502);response.end() })
      response.on('close', () => { if (!response.writableEnded) outgoing.destroy() })
    })
    server.requestTimeout = 30000
    await new Promise((resolve, reject) => { server.once('error', reject);server.listen(socketPath, resolve) })
    await chmod(socketPath, 0o600)
    return { socketPath, async close() { server.closeAllConnections();await new Promise(resolve => server.close(resolve));await unlink(socketPath).catch(() => {}) } }
  }
}
