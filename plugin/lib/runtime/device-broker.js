/** Durable device requests. No network IO runs while a project row is locked. */
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { DeviceGrants, ProjectDeviceBridge, DeviceError, deviceOperation, DEVICE_PREPARATION_MS } from '../devices.js'
import { deviceRequestState } from '../device-state.js'
import { escapeText } from '../protocol.js'
import { RuntimeError } from './postgres.js'

const fail = (code, message) => { throw new RuntimeError(code, message) }
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) fail('INVALID_INPUT', '设备请求身份无效');return value }
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value)
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
const tokenHash = value => createHash('sha256').update(value).digest('hex')
const safeJSON = (value, max = 256 * 1024) => {
  try { const text = JSON.stringify(value);if (Buffer.byteLength(text) > max) throw new Error();return JSON.parse(text) }
  catch { fail('INVALID_INPUT', '设备参数或结果不是有界JSON') }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const safeCode = error => error instanceof RuntimeError || error instanceof DeviceError ? error.code : 'DEVICE_UNKNOWN'
const TABLES = ['device_meta','devices','device_requests','device_events']

export class DeviceBroker {
  constructor(control, { connectionMs = 10000 } = {}) {
    if (!Number.isSafeInteger(connectionMs) || connectionMs < 100 || connectionMs > 600000) fail('INVALID_INPUT','设备连接时限无效')
    this.control = control;this.runtime = control.runtime;this.s = this.runtime.s;this.connectionMs = connectionMs
  }
  async initialize() {
    const rt = this.runtime, s = this.s;await rt.initialize()
    await rt.transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['mira-devices/'+rt.schema])
      if ((await c.query('SELECT to_regclass($1) AS name',[rt.schema+'.device_meta'])).rows[0].name) {
        const meta=(await c.query(`SELECT component,version FROM ${s}.device_meta WHERE singleton`)).rows[0]
        if (meta?.component!=='mira-device-broker'||meta.version!==1) fail('SCHEMA_VERSION','设备扩展版本不兼容')
        for (const name of TABLES) if (!(await c.query('SELECT to_regclass($1) AS name',[rt.schema+'.'+name])).rows[0].name) fail('SCHEMA_INCOMPLETE','设备扩展不完整')
        return
      }
      for (const name of TABLES) if ((await c.query('SELECT to_regclass($1) AS name',[rt.schema+'.'+name])).rows[0].name) fail('FOREIGN_SCHEMA','设备表名已被占用')
      await c.query(`CREATE TABLE ${s}.device_meta(singleton boolean PRIMARY KEY CHECK(singleton),component text NOT NULL,version integer NOT NULL);
        CREATE TABLE ${s}.devices(device_id text PRIMARY KEY,name text NOT NULL,token_hash text UNIQUE NOT NULL,status text NOT NULL CHECK(status IN('active','revoked')),
          roots text NOT NULL,projects text[] NOT NULL,epoch bigint NOT NULL DEFAULT 0,instance_id text,connected_until timestamptz);
        CREATE TABLE ${s}.device_requests(job_id text PRIMARY KEY,project_id text NOT NULL,key text NOT NULL,request_id text NOT NULL,session_id text NOT NULL,
          lease_owner text NOT NULL,fence bigint NOT NULL,execution_id text,device_id text NOT NULL REFERENCES ${s}.devices,grant_id text NOT NULL,tool text NOT NULL,
          op text NOT NULL,args text NOT NULL,fingerprint text NOT NULL,deadline_at timestamptz NOT NULL,epoch bigint,
          state text NOT NULL CHECK(state IN('queued','offered','running','completed','unknown','cancelled')),stopped boolean NOT NULL DEFAULT false,
          cancel_requested boolean NOT NULL DEFAULT false,result text,receipt_fingerprint text,UNIQUE(project_id,request_id),
          FOREIGN KEY(project_id,key) REFERENCES ${s}.wake_targets);
        CREATE INDEX device_pending ON ${s}.device_requests(device_id,stopped,deadline_at);
        CREATE TABLE ${s}.device_events(seq bigserial PRIMARY KEY,device_id text NOT NULL REFERENCES ${s}.devices,data text NOT NULL);
        INSERT INTO ${s}.device_meta VALUES(true,'mira-device-broker',1)`)
    })
    this.control.devices = this
  }
  async event(c, deviceId, data) { await c.query(`INSERT INTO ${this.s}.device_events(device_id,data) VALUES($1,$2)`,[deviceId,JSON.stringify({at:Date.now(),...data})]) }
  async provision({ name, roots, projects }) {
    if (typeof name!=='string'||!name.trim()||name.length>100||!Array.isArray(roots)||!roots.length||roots.length>32||!Array.isArray(projects)||projects.length>128) fail('INVALID_INPUT','设备登记参数无效')
    const seen=new Set(), list=roots.map(r=>{
      if (!r||Object.keys(r).some(k=>!['id','label'].includes(k))||typeof r.label!=='string'||!r.label.trim()||r.label.length>100||seen.has(r.id)) fail('INVALID_INPUT','设备目录只接受唯一身份和显示名称')
      id(r.id);seen.add(r.id);return {id:r.id,label:r.label}
    }), allowed=[...new Set(projects.map(id))], deviceId='dev_'+randomUUID().replaceAll('-',''),credential=randomBytes(32).toString('base64url')
    await this.runtime.transaction(async c=>{
      for (const project of allowed) if (!(await c.query(`SELECT 1 FROM ${this.s}.projects WHERE project_id=$1`,[project])).rowCount) fail('PROJECT_NOT_FOUND','设备项目尚未创建')
      await c.query(`INSERT INTO ${this.s}.devices(device_id,name,token_hash,status,roots,projects) VALUES($1,$2,$3,'active',$4,$5)`,[deviceId,name,tokenHash(credential),JSON.stringify(list),allowed])
      await this.event(c,deviceId,{type:'device.provisioned',name,roots:list,projects:allowed,by:'owner'})
    })
    return {deviceId,credential}
  }
  async revokeDevice(deviceId) { id(deviceId);await this.runtime.pool.query(`UPDATE ${this.s}.devices SET status='revoked' WHERE device_id=$1`,[deviceId]) }
  async descriptors(c, projectId) {
    return (await c.query(`SELECT device_id,name,roots,connected_until>clock_timestamp() AS online FROM ${this.s}.devices WHERE status='active' AND $1=ANY(projects) ORDER BY device_id`,[projectId])).rows.map(r=>({id:r.device_id,name:r.name,roots:JSON.parse(r.roots),online:r.online===true}))
  }
  async access(c, projectId, store) {
    const devices=await this.descriptors(c,projectId),at=Number((await c.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS at')).rows[0].at)
    return new ProjectDeviceBridge(store,null,{describe(){}},{devices:()=>devices,now:()=>at})
  }
  async snapshot(projectId) { return this.runtime.transaction(async c=>{await this.runtime.head(c,projectId);const store=await this.control.projection(c,projectId);return (await this.access(c,projectId,store)).snapshot(projectId)}) }
  /** Read-only broker facts; no credentials, tool arguments, result bodies or dispatch side effects. */
  async executionStates(projects) {
    const ids = projects.map(p => p.id), result = new Map()
    if (!ids.length) return result
    const rows = (await this.runtime.pool.query(`SELECT r.project_id,r.key,r.request_id,r.device_id,r.state,r.stopped,r.cancel_requested,
      r.deadline_at<=clock_timestamp() AS expired,d.status='active' AS registered,
      d.connected_until>clock_timestamp() AS online,r.epoch=d.epoch AS current_connection,
      EXISTS(SELECT 1 FROM ${this.s}.events e WHERE e.project_id=r.project_id AND e.event_type='device.started'
        AND e.data::jsonb->>'requestId'=r.request_id AND e.data::jsonb->>'epoch'=r.epoch::text) AS started,
      r.result::jsonb->>'outcome' AS outcome
      FROM ${this.s}.device_requests r JOIN ${this.s}.devices d ON d.device_id=r.device_id
      WHERE r.project_id=ANY($1) AND (NOT r.stopped OR r.result::jsonb->>'outcome'='unknown') ORDER BY r.job_id`, [ids])).rows
    for (const row of rows) {
      const phase = row.stopped ? 'stopped' : row.state === 'queued' ? row.online && row.registered ? 'queued' : 'waiting_device'
        : row.cancel_requested ? 'stopping' : !row.online || !row.registered || !row.current_connection || row.expired ? 'unconfirmed'
        : row.state === 'running' && row.started ? 'running' : ['offered', 'running'].includes(row.state) ? 'starting' : 'unconfirmed'
      const id = row.project_id + '|' + row.key, requests = result.get(id) ?? []
      requests.push(deviceRequestState({ requestId: row.request_id, deviceId: row.device_id, phase,
        stopped: row.stopped, pending: !row.stopped, online: row.online === true, outcome: row.outcome }))
      result.set(id, requests)
    }
    return result
  }
  async owner(projectId, command, { requestId, expectedSeq } = {}) {
    id(projectId);id(requestId)
    const input=safeJSON(command),fingerprint={kind:'device-owner-v1',command:input}
    const initial=await this.control.snapshot(projectId),lookup=new DeviceGrants(initial).view(projectId)
    const deviceId=input.op==='grantDevice'?id(input.deviceId):lookup.grants.get(input.grantId)?.deviceId
    if (!deviceId) fail('FORBIDDEN','授权不属于本项目')
    return this.runtime.transaction(async c=>{
      await c.query(`SELECT device_id FROM ${this.s}.devices WHERE device_id=$1 FOR UPDATE`,[deviceId])
      const head=await this.runtime.head(c,projectId),replay=await this.runtime.command(c,projectId,requestId,fingerprint)
      if (replay) return replay
      if (expectedSeq!==undefined&&head!==expectedSeq) fail('HEAD_CONFLICT','项目已变化')
      const store=await this.control.projection(c,projectId),access=await this.access(c,projectId,store),{op,...args}=input
      const value=op==='grantDevice'?access.grant(projectId,{...args,requestId}):op==='revokeDevice'?access.revoke(projectId,{...args,requestId}):fail('FORBIDDEN','不支持的设备owner操作')
      return this.runtime.persist(c,projectId,head,store.pending,requestId,fingerprint,{value})
    })
  }
  async prepare(projectId, lease, sessionId, tool, args, { requestId, authorize } = {}) {
    id(projectId);id(requestId)
    if (requestId.startsWith('sys:')||lease?.projectId!==projectId) fail('FORBIDDEN','设备请求需要本项目认领')
    const input=safeJSON(args),operation=deviceOperation(tool,input)
    if (!operation) fail('INVALID_INPUT','设备清单没有执行请求')
    const fingerprint=digest({sessionId,key:lease.key,tool,operation})
    return this.runtime.transaction(async c=>{
      if (authorize) await authorize(c)
      const initial=await this.control.projection(c,projectId),grant=new DeviceGrants(initial).view(projectId).grants.get(operation.grantId)
      if (!grant) fail('FORBIDDEN','授权不属于本项目')
      await c.query(`SELECT device_id FROM ${this.s}.devices WHERE device_id=$1 FOR UPDATE`,[grant.deviceId])
      const head=await this.runtime.head(c,projectId);await this.runtime.lockLease(c,lease)
      const store=await this.control.projection(c,projectId);this.control.session(store,lease,sessionId)
      const access=await this.access(c,projectId,store);access.authorize(projectId,lease.key,sessionId,operation.grantId,operation.op)
      const old=(await c.query(`SELECT job_id,fingerprint FROM ${this.s}.device_requests WHERE project_id=$1 AND request_id=$2`,[projectId,requestId])).rows[0]
      if (old) { if (old.fingerprint!==fingerprint) fail('IDEMPOTENCY_CONFLICT','同一设备请求内容不同');return {jobId:old.job_id,requestId} }
      const jobId='dj_'+randomUUID().replaceAll('-',''),timeout=operation.op==='exec'?operation.args.timeoutMs:5000
      await c.query(`INSERT INTO ${this.s}.device_requests(job_id,project_id,key,request_id,session_id,lease_owner,fence,execution_id,device_id,grant_id,tool,op,args,fingerprint,deadline_at,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp()+($15::double precision*interval '1 millisecond'),'queued')`,
        [jobId,projectId,lease.key,requestId,sessionId,lease.owner,lease.fence,lease.executionId??null,grant.deviceId,grant.id,tool,operation.op,JSON.stringify(operation.args),fingerprint,DEVICE_PREPARATION_MS+timeout])
      if (authorize) await authorize(c);await this.runtime.lockLease(c,lease)
      await this.runtime.persist(c,projectId,head,[{type:'device.requested',jobId,requestId,key:lease.key,subject:sessionId,grantId:grant.id,op:operation.op,fingerprint}],
        'sys:device-intent:'+requestId,{kind:'device-intent',fingerprint},{value:{jobId}})
      return {jobId,requestId}
    })
  }
  async auth(c, credential, { epoch, live=false, allowRevoked=false }={}) {
    if (typeof credential!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(credential)) fail('FORBIDDEN','设备身份无效')
    const row=(await c.query(`SELECT *,connected_until>clock_timestamp() AS connected FROM ${this.s}.devices WHERE token_hash=$1 FOR UPDATE`,[tokenHash(credential)])).rows[0]
    if (!row||(!allowRevoked&&row.status!=='active')) fail('FORBIDDEN','设备身份无效或已撤销')
    if (live&&(!row.connected||String(row.epoch)!==epoch)) fail('DEVICE_OFFLINE','设备连接代际已失效')
    return row
  }
  async verify(credential) { return this.runtime.transaction(async c=>{const d=await this.auth(c,credential,{allowRevoked:true});return {deviceId:d.device_id}}) }
  async recovery(credential) {
    return this.runtime.transaction(async c=>{
      const d=await this.auth(c,credential,{allowRevoked:true}),jobs=(await c.query(`SELECT job_id AS "jobId",epoch::text,project_id AS "projectId" FROM ${this.s}.device_requests WHERE device_id=$1 AND NOT stopped AND state IN('offered','running') ORDER BY job_id`,[d.device_id])).rows
      return {deviceId:d.device_id,instanceId:d.instance_id,connected:d.connected===true,revoked:d.status==='revoked',jobs,schema:this.runtime.schema}
    })
  }
  async connect(credential, { instanceId }) {
    id(instanceId)
    return this.runtime.transaction(async c=>{
      const d=await this.auth(c,credential),same=d.connected&&d.instance_id===instanceId
      if (d.connected&&!same) fail('DEVICE_BUSY','设备仍有活跃监督者')
      if (!same&&(await c.query(`SELECT 1 FROM ${this.s}.device_requests WHERE device_id=$1 AND NOT stopped AND state IN('offered','running') LIMIT 1`,[d.device_id])).rowCount) fail('RECOVERY_REQUIRED','先证明旧设备操作已停止再重连')
      const row=(await c.query(`UPDATE ${this.s}.devices SET epoch=epoch+$2,instance_id=$3,connected_until=clock_timestamp()+($4::double precision*interval '1 millisecond') WHERE device_id=$1 RETURNING epoch::text`,[d.device_id,same?0:1,instanceId,this.connectionMs])).rows[0]
      await this.event(c,d.device_id,{type:'device.connected',epoch:row.epoch,instanceId})
      return {deviceId:d.device_id,epoch:row.epoch,roots:JSON.parse(d.roots),schema:this.runtime.schema,connectionMs:this.connectionMs}
    })
  }
  async heartbeat(credential,{epoch}) { return this.runtime.transaction(async c=>{const d=await this.auth(c,credential,{epoch,live:true});await c.query(`UPDATE ${this.s}.devices SET connected_until=clock_timestamp()+($2::double precision*interval '1 millisecond') WHERE device_id=$1`,[d.device_id,this.connectionMs]);return {connected:true}}) }
  async disconnect(credential,{epoch,instanceId}) { return this.runtime.transaction(async c=>{const d=await this.auth(c,credential,{allowRevoked:true});await c.query(`UPDATE ${this.s}.devices SET connected_until=clock_timestamp() WHERE device_id=$1 AND epoch=$2 AND instance_id=$3`,[d.device_id,epoch,instanceId]);return {disconnected:true}}) }
  lease(row) { return {projectId:row.project_id,key:row.key,owner:row.lease_owner,fence:String(row.fence),...(row.execution_id?{executionId:row.execution_id}:{})} }
  async current(c,row) {
    await this.runtime.head(c,row.project_id);const lease=this.lease(row);await this.runtime.lockLease(c,lease)
    if (row.execution_id) {
      // Read only: node operations lock node/run before project/target. Taking
      // those locks here would invert that order while a device is locked.
      for (const table of ['nodes','node_runs']) if (!(await c.query('SELECT to_regclass($1) AS name',[this.runtime.schema+'.'+table])).rows[0].name) fail('FORBIDDEN','设备请求的执行节点已失效')
      const authorized=await c.query(`SELECT 1 FROM ${this.s}.node_runs r JOIN ${this.s}.nodes n ON n.node_id=r.node_id
        WHERE r.run_id=$1 AND r.project_id=$2 AND r.key=$3 AND r.session_id=$4 AND r.lease_owner=$5 AND r.fence=$6
        AND r.bound AND r.state IN('assigned','running') AND r.turn IS NULL
        AND n.status='active' AND n.connected_until>clock_timestamp() AND r.epoch=n.epoch`,
        [row.execution_id,row.project_id,row.key,row.session_id,row.lease_owner,row.fence])
      if (!authorized.rowCount) fail('FORBIDDEN','设备请求的执行节点已失效')
    }
    const store=await this.control.projection(c,row.project_id);this.control.session(store,lease,row.session_id)
    const access=await this.access(c,row.project_id,store),grant=access.authorize(row.project_id,row.key,row.session_id,row.grant_id,row.op)
    if (row.cancel_requested) fail('DEVICE_CANCELLED','设备请求已取消')
    if (new Date(row.deadline_at).getTime()<=Date.now()) fail('DEVICE_TIMEOUT','设备请求已超过时限')
    return grant
  }
  async offer(credential,{epoch}) {
    return this.runtime.transaction(async c=>{
      const d=await this.auth(c,credential,{epoch,live:true})
      if ((await c.query(`SELECT 1 FROM ${this.s}.device_requests WHERE device_id=$1 AND NOT stopped AND state IN('offered','running') LIMIT 1`,[d.device_id])).rowCount) return null
      const row=(await c.query(`SELECT * FROM ${this.s}.device_requests WHERE device_id=$1 AND state='queued' AND NOT stopped ORDER BY deadline_at,job_id FOR UPDATE LIMIT 1`,[d.device_id])).rows[0]
      if (!row) return null
      let grant
      try { grant=await this.current(c,row) } catch (error) {
        await c.query(`UPDATE ${this.s}.device_requests SET state='cancelled',stopped=true,result=$2 WHERE job_id=$1`,[row.job_id,JSON.stringify({outcome:'error',code:safeCode(error)})]);return null
      }
      await c.query(`UPDATE ${this.s}.device_requests SET state='offered',epoch=$2 WHERE job_id=$1`,[row.job_id,epoch])
      return this.job(row,grant,epoch)
    })
  }
  job(row,grant,epoch=String(row.epoch)) {
    return {jobId:row.job_id,epoch,projectId:row.project_id,subject:row.session_id+'/'+row.fence,requestId:row.job_id,grant,op:row.op,args:JSON.parse(row.args)}
  }
  async assigned(c,credential,{epoch,jobId},{allowRevoked=false,live=true}={}) {
    const d=await this.auth(c,credential,{epoch,live,allowRevoked}),row=(await c.query(`SELECT * FROM ${this.s}.device_requests WHERE job_id=$1 FOR UPDATE`,[id(jobId)])).rows[0]
    if (!row||row.device_id!==d.device_id||String(row.epoch)!==epoch) fail('FORBIDDEN','请求不属于此设备代际')
    return {d,row}
  }
  async accept(credential,input) {
    return this.runtime.transaction(async c=>{
      const {row}=await this.assigned(c,credential,input)
      if (row.stopped||!['offered','running'].includes(row.state)) fail('FORBIDDEN','设备请求已经结束')
      const grant=await this.current(c,row);await c.query(`UPDATE ${this.s}.device_requests SET state='running' WHERE job_id=$1`,[row.job_id]);return this.job(row,grant)
    })
  }
  async validate(credential,input) { return this.runtime.transaction(async c=>{const {row}=await this.assigned(c,credential,input);if(row.stopped||row.state!=='running')fail('FORBIDDEN','设备请求已结束');await this.current(c,row);return {valid:true}}) }
  async started(credential,input) {
    return this.runtime.transaction(async c=>{
      const {row}=await this.assigned(c,credential,input),head=await this.runtime.head(c,row.project_id)
      const requestId='sys:device-start:'+row.job_id,fingerprint={kind:'device-start',epoch:String(row.epoch)}
      if(await this.runtime.command(c,row.project_id,requestId,fingerprint))return {started:true,replayed:true}
      if(row.stopped||row.state!=='running')fail('FORBIDDEN','设备尚未接收执行或已结束')
      await this.current(c,row)
      await this.runtime.persist(c,row.project_id,head,[{type:'device.started',jobId:row.job_id,requestId:row.request_id,
        key:row.key,grantId:row.grant_id,op:row.op,epoch:String(row.epoch)}],requestId,fingerprint,{value:{started:true}})
      return {started:true,replayed:false}
    })
  }
  async result(credential,input) {
    const packet=safeJSON(input,1024*1024)
    if (packet.stopped!==true||!['ok','error','unknown'].includes(packet.outcome)||(packet.outcome==='ok'&&(!packet.value||typeof packet.value!=='object'||Array.isArray(packet.value)))||(['error','unknown'].includes(packet.outcome)&&!/^[A-Z][A-Z_]{1,64}$/.test(packet.code??''))) fail('INVALID_INPUT','设备结果需要明确停止与有效状态')
    const fingerprint=digest(packet)
    return this.runtime.transaction(async c=>{
      const {row}=await this.assigned(c,credential,packet,{allowRevoked:true,live:false})
      if (row.stopped) {
        if (row.receipt_fingerprint!==fingerprint) fail('IDEMPOTENCY_CONFLICT','设备停止回执内容不同')
        return {accepted:true,stopped:true,replayed:true}
      }
      if (!['offered','running'].includes(row.state)) fail('FORBIDDEN','请求没有被交给设备')
      const head=await this.runtime.head(c,row.project_id);let result={outcome:packet.outcome,...(packet.outcome==='ok'?{value:packet.value}:{code:packet.code})}
      try { await this.current(c,row) } catch (error) { result={outcome:'unknown',code:safeCode(error)} }
      await c.query(`UPDATE ${this.s}.device_requests SET stopped=true,state=$2,result=$3,receipt_fingerprint=$4 WHERE job_id=$1`,[row.job_id,result.outcome==='ok'?'completed':'unknown',JSON.stringify(result),fingerprint])
      await this.runtime.persist(c,row.project_id,head,[{type:'device.stopped',jobId:row.job_id,requestId:row.request_id,key:row.key,grantId:row.grant_id,op:row.op,ok:result.outcome==='ok'}],
        'sys:device-stop:'+row.job_id,{kind:'device-stop',fingerprint},{value:{stopped:true}})
      return {accepted:true,stopped:true,replayed:false}
    })
  }
  async cancel(jobId,code='DEVICE_CANCELLED') {
    id(jobId)
    const found=(await this.runtime.pool.query(`SELECT device_id FROM ${this.s}.device_requests WHERE job_id=$1`,[jobId])).rows[0]
    if (!found) fail('FORBIDDEN','设备请求不存在')
    return this.runtime.transaction(async c=>{
      await c.query(`SELECT device_id FROM ${this.s}.devices WHERE device_id=$1 FOR UPDATE`,[found.device_id])
      const row=(await c.query(`SELECT * FROM ${this.s}.device_requests WHERE job_id=$1 FOR UPDATE`,[jobId])).rows[0]
      if (row.stopped) return {stopped:true}
      if (row.state==='queued') await c.query(`UPDATE ${this.s}.device_requests SET cancel_requested=true,stopped=true,state='cancelled',result=$2 WHERE job_id=$1`,[jobId,JSON.stringify({outcome:'error',code})])
      else await c.query(`UPDATE ${this.s}.device_requests SET cancel_requested=true WHERE job_id=$1`,[jobId])
      return {stopped:row.state==='queued'}
    })
  }
  async finalize(projectId,lease,sessionId,jobId,{authorize}={}) {
    const initial=(await this.runtime.pool.query(`SELECT * FROM ${this.s}.device_requests WHERE job_id=$1 AND project_id=$2`,[jobId,projectId])).rows[0]
    if (!initial) fail('FORBIDDEN','设备请求不属于本项目')
    return this.runtime.transaction(async c=>{
      if (authorize) await authorize(c)
      await c.query(`SELECT device_id FROM ${this.s}.devices WHERE device_id=$1 FOR UPDATE`,[initial.device_id])
      const row=(await c.query(`SELECT * FROM ${this.s}.device_requests WHERE job_id=$1 FOR UPDATE`,[jobId])).rows[0],head=await this.runtime.head(c,projectId)
      await this.runtime.lockLease(c,lease)
      const store=await this.control.projection(c,projectId);this.control.session(store,lease,sessionId)
      if (row.session_id!==sessionId||row.key!==lease.key) fail('FORBIDDEN','设备请求会话不匹配')
      const access=await this.access(c,projectId,store);access.authorize(projectId,lease.key,sessionId,row.grant_id,row.op)
      if (!row.stopped) fail('EXECUTION_HELD','设备操作尚未确认停止')
      const result=JSON.parse(row.result)
      if (result.outcome!=='ok') fail(result.code,'设备操作未完成：'+result.code)
      const fingerprint={kind:'device-tool-v1',fingerprint:row.fingerprint},replay=await this.runtime.command(c,projectId,row.request_id,fingerprint)
      if (replay) return replay
      if (authorize) await authorize(c);await this.runtime.lockLease(c,lease)
      const value={result:'<untrusted kind="device_result">'+escapeText(JSON.stringify(result.value))+'</untrusted>',platform:['fs.write','exec'].includes(row.op),replied:false,concluded:false}
      return this.runtime.persist(c,projectId,head,[{type:'tool.called',key:lease.key,tool:row.tool,ok:true,ms:0}],row.request_id,fingerprint,{value})
    })
  }
  async tool(projectId,lease,sessionId,tool,args,{requestId,authorize,signal}={}) {
    if (tool==='list_devices') {
      id(requestId)
      const fingerprint={kind:'device-list-v1',sessionId,key:lease.key,args:safeJSON(args)}
      return this.runtime.transaction(async c=>{
        if (authorize) await authorize(c)
        const head=await this.runtime.head(c,projectId);await this.runtime.lockLease(c,lease)
        const store=await this.control.projection(c,projectId);this.control.session(store,lease,sessionId)
        const replay=await this.runtime.command(c,projectId,requestId,fingerprint)
        if(replay)return replay
        const value=(await this.access(c,projectId,store)).snapshot(projectId)
        if(authorize)await authorize(c);await this.runtime.lockLease(c,lease)
        return this.runtime.persist(c,projectId,head,[{type:'tool.called',key:lease.key,tool,ok:true,ms:0}],requestId,fingerprint,
          {value:{result:'<untrusted kind="device_capabilities">'+escapeText(JSON.stringify(value))+'</untrusted>',platform:false,replied:false,concluded:false}})
      })
    }
    const pending=await this.prepare(projectId,lease,sessionId,tool,args,{requestId,authorize})
    const deadline=Date.now()+DEVICE_PREPARATION_MS+65000
    while (true) {
      const row=(await this.runtime.pool.query(`SELECT stopped,deadline_at,state FROM ${this.s}.device_requests WHERE job_id=$1`,[pending.jobId])).rows[0]
      if (row.stopped) return this.finalize(projectId,lease,sessionId,pending.jobId,{authorize})
      if (signal?.aborted||Date.now()>=new Date(row.deadline_at).getTime()) {
        await this.cancel(pending.jobId,signal?.aborted?'DEVICE_CANCELLED':'DEVICE_TIMEOUT')
        if (row.state==='queued') continue
        if (signal?.aborted||Date.now()>new Date(row.deadline_at).getTime()+2000) fail('DEVICE_UNKNOWN','设备结果尚未确认，旧执行停止前不能重投')
      }
      if (Date.now()>deadline) fail('DEVICE_UNKNOWN','设备结果尚未确认')
      await pause(100)
    }
  }
}
