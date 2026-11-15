/** Configured read-only sources. Domain records are durable before private page checkpoints. */
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, mkdirSync, lstatSync, unlinkSync } from 'node:fs'
import { join, isAbsolute, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connectorPage, hash } from './connector-adapters.js'
const id=value=>{if(typeof value!=='string'||!/^[\w-]{1,100}$/.test(value))throw Error('连接器标识无效');return value}
function privateJSON(file) {
  if(!isAbsolute(file))throw Error('来源设置需要绝对路径')
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {const stat=fstatSync(fd);if(!stat.isFile()||stat.uid!==process.getuid()||stat.mode&0o077||stat.size>65536)throw Error('来源设置与凭据须为当前用户私有文件');return JSON.parse(readFileSync(fd,'utf8'))}finally{closeSync(fd)}
}
function definition(raw,{allowLoopback=false}={}) {
  if(!raw||typeof raw!=='object'||Object.keys(raw).some(k=>!['id','name','provider','accountId','chatId','credentialFile','origin'].includes(k)))throw Error('来源设置字段无效')
  id(raw.id)
  if(!['graph-mail','feishu-chat'].includes(raw.provider)||typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>80||!raw.name.isWellFormed()||typeof raw.accountId!=='string'||!raw.accountId||raw.accountId.length>256||!raw.accountId.isWellFormed()||!isAbsolute(raw.credentialFile||''))throw Error('来源类型、名称或私有凭据位置无效')
  if(raw.provider==='feishu-chat'&&!/^oc_[\w-]{1,128}$/.test(raw.chatId||''))throw Error('飞书需明确选择单个会话')
  const canonical=raw.provider==='graph-mail'?'https://graph.microsoft.com':'https://open.feishu.cn',origin=raw.origin||canonical
  let url;try{url=new URL(origin)}catch{throw Error('来源服务地址无效')}
  if(url.origin!==origin||origin!==canonical&&!(allowLoopback&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)))throw Error('来源服务地址不在已支持范围')
  return {...raw,origin,scope:hash({provider:raw.provider,origin,accountId:raw.accountId,chatId:raw.chatId??null})}
}
export function loadConnectorConfig(file,options) {
  const input=privateJSON(file)
  if(!input||Object.keys(input).join(',')!=='sources'||!Array.isArray(input.sources)||input.sources.length>20)throw Error('连接器设置需要最多20个sources')
  return input.sources.map(s=>{definition(s,options);return {...s}})
}
function privateWrite(file,value) {
  const temp=file+'.'+randomUUID()+'.tmp';const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
  try {writeFileSync(fd,JSON.stringify(value));fsyncSync(fd)}finally{closeSync(fd)}
  try {renameSync(temp,file);const directory=openSync(dirname(file),constants.O_RDONLY);try{fsyncSync(directory)}finally{closeSync(directory)}}finally{try{unlinkSync(temp)}catch{}}
}
export class Connectors {
  constructor(store,{configs=[],root,now=Date.now,fetch:fetcher=fetch,allowLoopback=false,retention}={}) {
    this.store=store;this.now=now;this.retention=retention;this.fetch=fetcher;this.root=root||join(store.root,'_connector-state');this.closed=false
    this.configs=new Map();this.registered=new Map();this.policies=new Map();this.statuses=new Map();this.records=new Map();this.requests=new Map();this.busy=new Map()
    mkdirSync(this.root,{recursive:true,mode:0o700});const stat=lstatSync(this.root);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.mode&0o077)throw Error('连接器状态目录须为当前用户私有目录')
    for(const e of this.hub.events)this.fold(e)
    if(!Array.isArray(configs)||configs.length>20)throw Error('连接器最多20个来源')
    const definitions=configs.map(raw=>definition(raw,{allowLoopback})), unique=new Set()
    for(const config of definitions) {
      if(unique.has(config.id))throw Error('连接器标识重复')
      unique.add(config.id)
      const old=this.registered.get(config.id);if(old&&old.scope!==config.scope)throw Error('来源账号或会话变化，请使用新的连接器标识')
    }
    this.off=store.onChange(e=>{if(e?.projectId==='hub')this.fold(e)})
    for(const config of definitions) {
      const old=this.registered.get(config.id);this.configs.set(config.id,config)
      if(!old||old.name!==config.name)this.append({type:'connector.registered',connectorId:config.id,name:config.name,provider:config.provider,scope:config.scope})
    }
  }
  get hub(){return this.store.get('hub')}
  fold(e) {
    if(e.type==='connector.registered')this.registered.set(e.connectorId,e)
    if(e.type==='connector.policy'){this.policies.set(e.connectorId,e);this.requests.set(e.requestId,e)}
    if(e.type==='connector.status')this.statuses.set(e.connectorId,e)
    if(e.type==='connector.record')this.records.set(e.connectorId+'|'+e.externalId,e)
  }
  sync(){const fd=openSync(join(this.store.root,'hub/events.jsonl'),'r');try{fsyncSync(fd)}finally{closeSync(fd)};const dir=openSync(join(this.store.root,'hub'),'r');try{fsyncSync(dir)}finally{closeSync(dir)}}
  append(event){const e=this.store.append('hub',event);this.sync();return e}
  configure({id:sourceId,enabled,expectedRevision,requestId}) {
    id(sourceId);id(requestId);if(typeof enabled!=='boolean'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error('来源同步设置无效')
    const fingerprint=hash({id:sourceId,enabled,expectedRevision}),old=this.requests.get(requestId)
    if(old){if(old.fingerprint!==fingerprint)throw Error('同一来源设置请求内容不一致');this.sync();return{ok:true,revision:old.seq}}
    if(!this.configs.has(sourceId)||this.closed)throw Error('此来源尚未配置或已停止')
    const policy=this.policies.get(sourceId)
    if((policy?.seq??0)!==expectedRevision)throw Error('来源设置已变化，请刷新后重试')
    const event=this.append({type:'connector.policy',connectorId:sourceId,enabled,since:enabled?this.now():policy?.since??this.now(),requestId,fingerprint})
    this.busy.get(sourceId)?.abort();return{ok:true,revision:event.seq}
  }
  checkpoint(sourceId,value){privateWrite(join(this.root,id(sourceId)+'.json'),value)}
  cursor(sourceId,revision) {try {const saved=privateJSON(join(this.root,sourceId+'.json'));return saved.revision===revision?saved:{revision}}catch{return{revision}}}
  current(sourceId,revision){return !this.closed&&this.configs.has(sourceId)&&this.policies.get(sourceId)?.enabled===true&&this.policies.get(sourceId).seq===revision}
  expired(event){return Boolean(event.sourceExpired||this.retention?.isExpired(event))}
  isCurrent(event){return !event.deleted&&!this.expired(event)&&this.records.get(event.connectorId+'|'+event.externalId)?.seq===event.seq}
  async poll(config) {
    const policy=this.policies.get(config.id),status=this.statuses.get(config.id)
    if(this.closed||!policy?.enabled||this.busy.has(config.id))return
    const saved=this.cursor(config.id,policy.seq),last=status?.revision===policy.seq?status:null
    let token,tokenHash
    try {const credential=privateJSON(config.credentialFile);if(credential.accountId!==config.accountId||typeof credential.token!=='string'||!/^[\x21-\x7e]{16,8192}$/.test(credential.token))throw Error();token=credential.token;tokenHash=hash(token)}catch{if(last?.state!=='authentication-required'||last?.credentialUnavailable!==true)this.append({type:'connector.status',connectorId:config.id,revision:policy.seq,state:'authentication-required',credentialUnavailable:true,error:'来源凭据不可用，请在私有设置中更新',nextAttemptAt:0,failures:0});return}
    if(last?.state==='resync-required'||last?.state==='authentication-required'&&!last.credentialUnavailable&&saved.tokenHash===tokenHash||last?.nextAttemptAt>this.now())return
    const abort=new AbortController();this.busy.set(config.id,abort);const timer=setTimeout(()=>abort.abort(),20000)
    try {
      const page=await connectorPage(config,{cursor:saved.cursor,since:policy.since,now:this.now(),token,fetch:this.fetch,signal:abort.signal})
      if(!this.current(config.id,policy.seq))return
      try {
        const current=privateJSON(config.credentialFile)
        if(current.accountId!==config.accountId||current.token!==token)throw Error()
      } catch { const changed=Error('来源凭据已变化');changed.code='CREDENTIAL_CHANGED';throw changed }
      const normalized=page.records.filter(item=>item.deleted||item.occurredAt>=policy.since)
      for(const item of normalized) {
        const key=config.id+'|'+item.externalId,old=this.records.get(key),fingerprint=hash(item)
        if(old?.fingerprint===fingerprint||item.deleted&&(!old||old.deleted))continue
        this.append({type:'connector.record',connectorId:config.id,connectorName:config.name,provider:config.provider,scope:config.scope,...item,receivedAt:this.now(),fingerprint})
      }
      this.sync();this.checkpoint(config.id,{revision:policy.seq,cursor:page.cursor,tokenHash})
      this.append({type:'connector.status',connectorId:config.id,revision:policy.seq,state:'ready',error:'',lastSyncAt:this.now(),caughtUp:page.caughtUp,nextAttemptAt:this.now()+(page.caughtUp?60000:1000),failures:0})
    } catch(error) {
      if(!this.current(config.id,policy.seq))return
      const failures=(last?.failures??0)+1,auth=['AUTHENTICATION_REQUIRED','CREDENTIAL_CHANGED'].includes(error.code),retry=Math.max(error.retryMs??0,Math.min(3600000,60000*2**Math.min(failures-1,6)))
      // Keep the last known cursor, including when an ACK or its local checkpoint was lost.
      try{this.checkpoint(config.id,{...saved,tokenHash})}catch{}
      this.append({type:'connector.status',connectorId:config.id,revision:policy.seq,credentialUnavailable:error.code==='CREDENTIAL_CHANGED',state:auth?'authentication-required':error.code==='CURSOR_EXPIRED'?'resync-required':error.code==='RATE_LIMITED'?'rate-limited':'error',error:auth?'来源凭据不可用或账号不符，请更新凭据':error.code==='CURSOR_EXPIRED'?'来源增量记录已过期；可从现在重新同步，已保存资料保留':error.code==='RATE_LIMITED'?'来源限流，等待后重试':'来源读取未完成，已保存资料保留并等待重试',failures,lastSyncAt:last?.lastSyncAt??null,nextAttemptAt:auth?0:this.now()+retry})
    } finally{clearTimeout(timer);if(this.busy.get(config.id)===abort)this.busy.delete(config.id)}
  }
  async tick(){await Promise.all([...this.configs.values()].map(config=>this.poll(config)))}
  start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>{void this.tick().catch(()=>{})},1000);this.timer.unref();void this.tick().catch(()=>{})}
  close(){this.closed=true;clearInterval(this.timer);for(const abort of this.busy.values())abort.abort();this.off?.()}
  snapshot(){return{activity:[...this.records.values()].filter(e=>!e.deleted&&!this.expired(e)).sort((a,b)=>b.occurredAt-a.occurredAt||b.seq-a.seq).slice(0,40).map(e=>({ref:'hub#'+e.seq,title:e.title,name:e.connectorName,source:e.source,preview:e.text.slice(0,140),happenedAt:e.occurredAt,receivedAt:e.receivedAt})),configured:this.configs.size>0,label:this.configs.size?'只读来源，启用后同步新资料':'邮件与飞书连接器尚未配置',items:[...this.registered.values()].map(source=>{
    const policy=this.policies.get(source.connectorId),last=this.statuses.get(source.connectorId),active=last?.revision===policy?.seq?last:null,installed=this.configs.has(source.connectorId)
    return{id:source.connectorId,name:source.name,provider:source.provider,configured:installed,enabled:policy?.enabled??false,revision:policy?.seq??0,since:policy?.since??null,state:!installed?'unavailable':!policy?.enabled?'paused':active?.state??'waiting',error:active?.error??'',lastSyncAt:active?.lastSyncAt??null,nextAttemptAt:active?.nextAttemptAt??null,caughtUp:active?.caughtUp??false,records:[...this.records.values()].filter(e=>e.connectorId===source.connectorId&&!e.deleted&&!this.expired(e)).length,expiredRecords:[...this.records.values()].filter(e=>e.connectorId===source.connectorId&&!e.deleted&&this.expired(e)).length,coverage:source.provider==='graph-mail'?'收件箱新邮件及其增量修改':'所选会话新消息；较早消息的修改尚未自动同步'}
  })}}
}
