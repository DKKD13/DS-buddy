/** Owner-written private enrollment file; no secrets in argv or diagnostics. */
import { readFileSync, appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { RemoteDevice } from './remote-device.js'
let device
try{
 const config=JSON.parse(readFileSync(process.env.MIRA_DEVICE_CONFIG,'utf8'))
 const ws=await import(config.wsModule?pathToFileURL(config.wsModule).href:'ws')
 device=new RemoteDevice({...config,ca:readFileSync(config.caFile),WebSocket:ws.WebSocket??ws.default,
  onChange:value=>{if(config.eventFile)appendFileSync(config.eventFile,JSON.stringify({at:Date.now(),...value})+'\n',{mode:0o600})}})
 let stopping=false
 const stop=()=>{if(stopping)return;stopping=true;device.stop().catch(()=>{})}
 process.on('SIGTERM',stop);process.on('SIGINT',stop)
 await device.run()
}catch{await device?.stop().catch(()=>{});console.error('Device daemon stopped; verify private enrollment and execution state.');process.exitCode=1}
