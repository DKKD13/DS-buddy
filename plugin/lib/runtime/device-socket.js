/** Machine-only outbound WebSocket RPC. WS implementation is supplied by caller. */
import { checkServerIdentity } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { RuntimeError } from './postgres.js'
import { DeviceError } from '../devices.js'

const fail = (code,message) => Object.assign(new Error(message),{code})
export class DeviceSocket {
  constructor({endpoint,ca,credential,WebSocket,onOffer=()=>{},onClose=()=>{}}) {
    const url=new URL(endpoint)
    if (url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!ca||typeof WebSocket!=='function') throw new Error('Verified HTTPS origin, CA and WebSocket implementation required')
    this.url=new URL('/device',url);this.url.protocol='wss:';this.options={ca,rejectUnauthorized:true,checkServerIdentity,minVersion:'TLSv1.3',followRedirects:false,maxPayload:2*1024*1024,perMessageDeflate:false,handshakeTimeout:5000,headers:{authorization:'Bearer '+credential}}
    this.WebSocket=WebSocket;this.onOffer=onOffer;this.onClose=onClose;this.pending=new Map();this.connected=false
    this.closed=new Promise(resolve=>{this.resolveClosed=resolve})
  }
  async open() {
    this.ws=new this.WebSocket(this.url,this.options)
    this.ws.on('message',(data,binary)=>{
      if (binary) {this.ws.terminate();return}
      let frame
      try {frame=JSON.parse(data.toString())}catch{this.ws.terminate();return}
      if (frame.event==='offer') {this.onOffer(frame.job);return}
      const pending=this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id);clearTimeout(pending.timer)
      if (frame.ok===true) pending.resolve(frame.value)
      else pending.reject(fail(typeof frame.code==='string'?frame.code:'DEVICE_NETWORK',typeof frame.error==='string'?frame.error:'设备通道未完成请求'))
    })
    this.ws.on('close',()=>{
      this.connected=false
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(fail('DEVICE_NETWORK','设备通道已断开'))}
      this.pending.clear();this.resolveClosed();this.onClose()
    })
    this.ws.on('error',()=>{})
    return new Promise((resolve,reject)=>{
      this.ws.once('open',()=>{this.connected=true;resolve()})
      this.ws.once('error',()=>reject(fail('DEVICE_NETWORK','验证后的设备TLS通道不可用')))
      this.ws.once('close',()=>reject(fail('DEVICE_NETWORK','设备握手已关闭')))
      this.ws.once('unexpected-response',(_req,res)=>{res.resume();this.ws.terminate();reject(fail('DEVICE_NETWORK','设备连接被拒绝'))})
    })
  }
  rpc(op,input={},timeoutMs=4000) {
    if(!this.connected)return Promise.reject(fail('DEVICE_NETWORK','设备通道不可用'))
    const id=randomUUID()
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(fail('DEVICE_NETWORK','设备通道请求超时'))},timeoutMs)
      this.pending.set(id,{resolve,reject,timer})
      this.ws.send(JSON.stringify({...input,id,op}),error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(fail('DEVICE_NETWORK','设备通道发送失败'))}})
    })
  }
  async close() {this.connected=false;if(!this.ws)return;this.ws.terminate();await this.closed}
}

/** Narrow protocol mounted on an existing TLS server; no owner/node RPC here. */
export class DeviceSocketServer {
  constructor(broker,{WebSocketServer}) {this.broker=broker;this.WSS=WebSocketServer;this.connections=new Set()}
  attach(server) {
    this.wss=new this.WSS({noServer:true,maxPayload:2*1024*1024,perMessageDeflate:false,clientTracking:false})
    this.upgrade=async(req,socket,head)=>{
      if(req.url!=='/device'){socket.destroy();return}
      const timeout=setTimeout(()=>socket.destroy(),5000)
      try{
        if(req.headers.origin)throw new Error('browser denied')
        const credential=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization??'')?.[1]
        await this.broker.verify(credential)
        if(socket.destroyed)return
        clearTimeout(timeout)
        this.wss.handleUpgrade(req,socket,head,ws=>this.connection(ws,credential))
      }catch{clearTimeout(timeout);socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')}
    }
    server.on('upgrade',this.upgrade);this.server=server
    this.timer=setInterval(()=>{if(!this.pumping)this.pumping=this.pump().finally(()=>{this.pumping=null})},100)
  }
  connection(ws,credential) {
    const slot={ws,credential,epoch:null,instanceId:null,tail:Promise.resolve(),queued:0};this.connections.add(slot)
    ws.on('error',()=>{})
    ws.on('message',(data,binary)=>{
      if(binary||++slot.queued>64){ws.terminate();return}
      slot.tail=slot.tail.then(async()=>{
        let frame
        try{
          frame=JSON.parse(data.toString());if(!frame||typeof frame.id!=='string'||frame.id.length>160)throw new Error('invalid frame')
          let value
          switch(frame.op){
            case 'recovery':value=await this.broker.recovery(credential);break
            case 'connect':value=await this.broker.connect(credential,frame);slot.epoch=value.epoch;slot.instanceId=frame.instanceId;break
            case 'heartbeat':value=await this.broker.heartbeat(credential,frame);break
            case 'accept':value=await this.broker.accept(credential,frame);break
            case 'started':value=await this.broker.started(credential,frame);break
            case 'validate':value=await this.broker.validate(credential,frame);break
            case 'result':{const {id,op,...input}=frame;value=await this.broker.result(credential,input);break}
            default:throw new RuntimeError('FORBIDDEN','设备通道没有此操作能力')
          }
          if(ws.readyState===1)ws.send(JSON.stringify({id:frame.id,ok:true,value}))
        }catch(error){
          const known=error instanceof RuntimeError||error instanceof DeviceError
          if(ws.readyState===1)ws.send(JSON.stringify({id:frame?.id,ok:false,code:known?error.code:'DEVICE_NETWORK',error:known?error.message:'设备通道未完成请求'}))
        }finally{slot.queued--}
      }).catch(()=>ws.terminate())
    })
    ws.on('close',()=>{
      this.connections.delete(slot)
      slot.tail=slot.tail.finally(async()=>{if(slot.epoch)await this.broker.disconnect(credential,{epoch:slot.epoch,instanceId:slot.instanceId}).catch(()=>{})})
    })
  }
  async pump() {
    await Promise.allSettled([...this.connections].map(async slot=>{
      if(!slot.epoch||slot.ws.readyState!==1)return
      try{const job=await this.broker.offer(slot.credential,{epoch:slot.epoch});if(job&&slot.ws.readyState===1)slot.ws.send(JSON.stringify({event:'offer',job}))}
      catch{slot.ws.terminate()}
    }))
  }
  async close() {
    clearInterval(this.timer);this.server?.off('upgrade',this.upgrade)
    const slots=[...this.connections]
    await Promise.all(slots.map(slot=>new Promise(resolve=>{if(slot.ws.readyState===3)return resolve();slot.ws.once('close',resolve);slot.ws.terminate()})))
    await this.pumping;await Promise.allSettled(slots.map(s=>s.tail));await new Promise(resolve=>this.wss.close(resolve))
  }
}
