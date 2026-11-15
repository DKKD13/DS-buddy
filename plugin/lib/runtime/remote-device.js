/** Device daemon: root credential stays here; tasks see only a health capability. */
import { randomUUID } from 'node:crypto'
import { DeviceDockerHost } from './device-host.js'
import { DeviceSocket } from './device-socket.js'
import { DeviceError } from '../devices.js'

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
export class RemoteDevice {
  constructor({endpoint,ca,credential,deviceId,WebSocket,stateRoot,image,roots,name='设备',onChange=()=>{}}) {
    this.options={endpoint,ca,credential,WebSocket};this.deviceId=deviceId;this.roots=roots;this.onChange=onChange
    this.host=new DeviceDockerHost({stateRoot,deviceId,image,roots,name,onChange:value=>{
      onChange({...value,deviceId})
      if(value.state==='running'&&this.online){
        // Receipt of an offer is not proof that a container started. A lost
        // progress response leaves the UI preparing; it cannot authorize work.
        this.socket.rpc('started',{jobId:value.requestId,epoch:this.connection.epoch},1200)
          .catch(()=>onChange({state:'device-progress-unconfirmed',deviceId,jobId:value.requestId}))
      }
    }})
    this.online=false;this.stopping=false;this.offers=[]
  }
  async packet(job) {
    await this.host.stopRequest(job.jobId)
    const receipt=await this.host.receipt(job.jobId)
    const result=receipt?.phase==='completed'?receipt.result:null
    return {jobId:job.jobId,epoch:job.epoch,stopped:true,...(result?.ok?{outcome:'ok',value:result.value}:result?{outcome:'error',code:result.code}:{outcome:'unknown',code:'DEVICE_UNKNOWN'})}
  }
  drain() {
    if(!this.online||this.task||!this.offers.length)return
    const offered=this.offers.shift()
    this.task=this.runJob(offered).catch(()=>{}).finally(()=>{this.task=null;this.drain()})
  }
  async runJob(offered) {
    const socket=this.socket,epoch=this.connection.epoch
    if(offered.epoch!==epoch||offered.grant?.deviceId!==this.deviceId)throw new Error('Device offer identity mismatch')
    let accepted=false
    try{
      const job=await socket.rpc('accept',{jobId:offered.jobId,epoch});accepted=true
      await this.host.call(job,{assertCurrent:async()=>{
        if(!this.online||socket!==this.socket||this.stopping)throw new DeviceError('设备连接已断开','DEVICE_OFFLINE')
        await socket.rpc('validate',{jobId:job.jobId,epoch},1200)
      }})
    }catch{/* the local receipt, not a thrown tool error, determines the outcome */}
    const packet=await this.packet(offered)
    if(socket.connected)await socket.rpc('result',packet)
    this.onChange({state:'device-result',deviceId:this.deviceId,jobId:offered.jobId,outcome:packet.outcome,stopped:true,accepted})
  }
  async run() {
    await this.host.initialize()
    try{
      while(!this.stopping){
        this.instanceId=randomUUID();this.offers=[]
        const socket=this.socket=new DeviceSocket({...this.options,onOffer:job=>{if(this.offers.length<4){this.offers.push(job);this.drain()}else socket.close()},onClose:()=>{this.online=false}})
        try{
          await socket.open()
          const recovery=await socket.rpc('recovery')
          if(recovery.deviceId!==this.deviceId)throw new Error('Device identity does not match enrollment')
          if(recovery.connected&&recovery.instanceId!==this.instanceId)throw Object.assign(new Error('Previous device connection is still live'),{code:'DEVICE_BUSY'})
          await this.host.bindControl({endpoint:this.options.endpoint,schema:recovery.schema,deviceId:this.deviceId})
          for(const job of recovery.jobs){await socket.rpc('result',await this.packet(job));this.onChange({state:'recovered-device-stop',deviceId:this.deviceId,jobId:job.jobId})}
          if(recovery.revoked)return
          this.connection=await socket.rpc('connect',{instanceId:this.instanceId})
          const ids=this.roots.map(r=>r.id).sort(),registered=this.connection.roots.map(r=>r.id).sort()
          if(JSON.stringify(ids)!==JSON.stringify(registered))throw new Error('Configured device roots do not match owner enrollment')
          this.online=true;this.onChange({state:'device-connected',deviceId:this.deviceId,epoch:this.connection.epoch});this.drain()
          this.timer=setInterval(()=>{
            if(this.heartbeat||!this.online)return
            this.heartbeat=socket.rpc('heartbeat',{epoch:this.connection.epoch}).catch(()=>socket.close()).finally(()=>{this.heartbeat=null})
          },Math.max(50,Math.floor(this.connection.connectionMs/3)))
          await socket.closed
        }catch(error){
          if(!['DEVICE_NETWORK','DEVICE_BUSY','DEVICE_OFFLINE','RECOVERY_REQUIRED'].includes(error.code))throw error
          this.onChange({state:'device-reconnecting',deviceId:this.deviceId,code:error.code})
        }finally{
          this.online=false;clearInterval(this.timer);await socket.close();await this.heartbeat;await this.task
        }
        if(!this.stopping)await pause(500)
      }
    }finally{this.online=false;clearInterval(this.timer);await this.host.close()}
  }
  async stop(){this.stopping=true;this.online=false;clearInterval(this.timer);await this.socket?.close();await this.task;await this.host.close()}
}
