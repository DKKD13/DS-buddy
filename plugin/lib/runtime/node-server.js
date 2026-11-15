/** TLS control endpoint for outbound node agents and their scoped job relays. */
import { createServer } from 'node:https'
import { NodeGateway, readNodeBody, nodeJSON } from './gateway.js'
import { RuntimeError } from './postgres.js'
import { DeviceSocketServer } from './device-socket.js'

export class NodeControlServer {
  constructor(nodes, { key, cert, modelURL, modelKey, model, devices, WebSocketServer }) {
    this.devices=devices;this.WebSocketServer=WebSocketServer
    this.nodes = nodes;this.tls = { key, cert, minVersion: 'TLSv1.3' }
    this.gateway = new NodeGateway(nodes.control, { modelURL, modelKey, model,
      resolveCapability: token => nodes.resolveJob(token), authorizeAssignment: (c, entry) => nodes.assignment(c, entry),
      completeAssignment: (entry, turn) => nodes.complete(entry, turn), chargeModel: (entry, max) => nodes.chargeModel(entry, max) })
  }
  async handle(req, res) {
    if (req.url !== '/node') return this.gateway.handle(req, res)
    try {
      if (req.method !== 'POST') throw new RuntimeError('FORBIDDEN', '节点接口只接受 POST')
      const credential = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1]
      const input = await readNodeBody(req)
      let result
      switch (input?.op) {
        case 'connect': result = await this.nodes.connect(credential, input);break
        case 'heartbeat': result = await this.nodes.heartbeat(credential, input);break
        case 'claim': result = await this.nodes.claim(credential, input);break
        case 'started': result = await this.nodes.started(credential, input);break
        case 'stopped': result = await this.nodes.stopped(credential, input);break
        case 'recovery': result = await this.nodes.recovery(credential);break
        case 'validate': result = await this.nodes.validate(credential, input);break
        default: throw new RuntimeError('FORBIDDEN', '不支持的节点操作')
      }
      nodeJSON(res, 200, result)
    } catch (error) {
      req.resume();res.setHeader('connection', 'close')
      const known = error instanceof RuntimeError
      nodeJSON(res, known && error.code === 'FORBIDDEN' ? 403 : known && ['NODE_BUSY', 'NODE_OFFLINE', 'RECOVERY_REQUIRED'].includes(error.code) ? 409 : 400,
        { error: known ? error.message : '节点请求未完成', code: known ? error.code : 'UNAVAILABLE' })
    }
  }
  async listen({ host = '127.0.0.1', port = 0 } = {}) {
    this.server = createServer(this.tls, (req, res) => this.handle(req, res))
    if(this.devices){this.deviceServer=new DeviceSocketServer(this.devices,{WebSocketServer:this.WebSocketServer});this.deviceServer.attach(this.server)}
    this.server.requestTimeout = 30000;this.server.headersTimeout = 5000
    await new Promise((resolve, reject) => { this.server.once('error', reject);this.server.listen(port, host, resolve) })
    this.timer = setInterval(() => {
      if (this.sweeping) return
      this.sweeping = (async () => {
        for (const entry of this.gateway.capabilities.values()) {
          try { await this.gateway.authorize(entry) } catch { this.gateway.revoke(entry) }
        }
      })().finally(() => { this.sweeping = null })
    }, 1000)
    return this.server.address()
  }
  async close() {
    clearInterval(this.timer);await this.sweeping
    await this.deviceServer?.close()
    await this.gateway.close()
    if (this.server) { this.server.closeAllConnections();await new Promise(resolve => this.server.close(resolve)) }
  }
}
