import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, symlinkSync, renameSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { ProjectStore } from '../lib/store.js'
import { ensureHub, HubActions } from '../lib/hub.js'
import { Actions } from '../lib/actions.js'
import { PersonalMira } from '../lib/personal.js'
import { Observations } from '../lib/observations.js'
import { Connectors } from '../lib/connectors.js'
import { SourceRetention, retentionPolicy } from '../lib/source-retention.js'
import { buildDay, renderDay } from '../lib/today.js'

const DAY=86400000
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'mira-source-retention-')),instances=[];let clock=Date.parse('2026-11-05T03:00:00Z')
 const projects=new ProjectStore(join(root,'projects'),{warn(){}});projects.load()
 const build=()=>{
  const store=new ProjectStore(join(root,'hub'),{warn(){}});store.load();ensureHub(store)
  const retention=new SourceRetention(store,projects,{now:()=>clock}),observations=new Observations(store,projects,{root:join(root,'images'),now:()=>clock,retention}),connectors=new Connectors(store,{root:join(root,'connectors'),now:()=>clock,retention})
  const driver={status:()=> 'idle',deliver(){}},actions=new Actions(projects,driver),personal=new PersonalMira(store,driver,projects,actions,{retention,observations,connectors})
  const f={store,retention,observations,connectors,personal,actions,hubActions:new HubActions(store,driver,projects,actions),close(){personal.close();retention.close();observations.close();connectors.close()}}
  instances.push(f);return f
 }
 const f=build();t.after(()=>{for(const i of instances)i.close();rmSync(root,{recursive:true,force:true})})
 return{...f,root,projects,build,now:()=>clock,advance:ms=>clock+=ms,configure:(policy,requestId='retention-setting-01')=>f.retention.configure({policy,requestId,expectedRevision:f.retention.policy().revision})}
}
const post=(f,type,text,extra={})=>f.store.append('hub',{type,deviceId:'device-one',eventId:'e_'+f.store.get('hub').seq,source:'activity',text,title:'TITLE_'+text,receivedAt:f.now()-2*DAY,at:f.now()-2*DAY,occurredAt:f.now()-2*DAY,...extra})
const allBytes=root=>Buffer.concat(readdirSync(root,{recursive:true}).map(p=>join(root,p)).filter(p=>statSync(p).isFile()).map(p=>readFileSync(p)))

test('retention defaults preserve existing sources; policy validation and CAS/replayed requests are durable',t=>{
 const f=fixture(t);post(f,'pc.signal','PRESERVED_DEFAULT')
 f.retention.collect();assert.equal(f.personal.search({query:'PRESERVED_DEFAULT'}).total,1);assert.equal(f.retention.snapshot().expired,0)
 for(const policy of [{rawDays:-1},{rawDays:1.5},{summaryDays:3651},{foreign:1}])assert.throws(()=>retentionPolicy(policy),/保留/)
 const input={policy:{rawDays:0,summaryDays:0},requestId:'stable-retention-request',expectedRevision:0},a=f.retention.configure(input),b=f.retention.configure(input)
 assert.equal(a.revision,b.revision);assert.throws(()=>f.retention.configure({...input,requestId:'stale-retention-request'}),/已变化/)
 assert.throws(()=>f.retention.configure({...input,policy:{rawDays:7}}),/不一致/)
 f.close();const reopened=f.build();assert.equal(reopened.retention.policy().revision,a.revision);assert.equal(reopened.personal.search({query:'PRESERVED_DEFAULT'}).total,1)
})

test('expiry physically removes all source versions and cached bytes, preserving project facts and derived conversation',t=>{
 const f=fixture(t),{projectId}=f.actions.createProject({name:'保留项目'});f.actions.ownerPost({projectId,text:'PROTECTED_PROJECT_REQUIREMENT'})
 const projectFile=join(f.projects.root,projectId,'events.jsonl'),before=readFileSync(projectFile)
 const keep=f.store.append('hub',{type:'message.posted',messageId:'m_keep',author:{kind:'human',id:'owner'},text:'PROTECTED_CONVERSATION',trust:'principal'})
 f.store.append('hub',{type:'hub.memory.updated',memory:{focus:[{text:'PROTECTED_MEMORY',refs:[]}]}})
 const expired=[]
 expired.push(post(f,'observation.accepted','EXPIRE_RAW_ONE',{context:'EXPIRE_CONTEXT',path:'/EXPIRE_PRIVATE_PATH',unexpectedPayload:'EXPIRE_UNKNOWN_PAYLOAD'}))
 expired.push(post(f,'pc.window','',{summary:'EXPIRE_LEGACY_WINDOW',path:'/EXPIRE_WINDOW_PATH'}))
 for(const text of ['EXPIRE_CONNECTOR_V1','EXPIRE_CONNECTOR_V2'])expired.push(post(f,'connector.record',text,{connectorId:'mail',externalId:'message-one'}))
 const summary=post(f,'observation.summary','KEEP_SUMMARY',{windowId:'w_one'})
 assert.equal(f.personal.search({query:'EXPIRE_RAW_ONE'}).total,1)
 assert.ok(allBytes(join(f.root,'hub')).includes(Buffer.from('EXPIRE_RAW_ONE')))
 const result=f.configure({rawDays:1,summaryDays:7});assert.equal(result.cleanup.pending,false);assert.equal(result.cleanup.expired,4)
 assert.equal(f.personal.search({query:'EXPIRE_RAW_ONE'}).total,0);assert.equal(f.personal.search({query:'EXPIRE_CONNECTOR_V2'}).total,0)
 for(const event of expired){const s=f.personal.source('hub#'+event.seq);assert.equal(s.sourceState,'expired');assert.equal(s.text,'');assert.equal(s.externalContext,null)}
 assert.equal(f.personal.source('hub#'+summary.seq).text,'KEEP_SUMMARY');assert.equal(f.personal.source('hub#'+keep.seq).text,'PROTECTED_CONVERSATION')
 assert.deepEqual(readFileSync(projectFile),before)
 const bytes=allBytes(join(f.root,'hub')).toString('latin1');assert.doesNotMatch(bytes,/EXPIRE_RAW_ONE|EXPIRE_CONTEXT|EXPIRE_PRIVATE_PATH|EXPIRE_UNKNOWN_PAYLOAD|EXPIRE_LEGACY_WINDOW|EXPIRE_WINDOW_PATH|EXPIRE_CONNECTOR_V[12]/)
 assert.match(bytes,/PROTECTED_CONVERSATION/);assert.match(bytes,/PROTECTED_MEMORY/)
 assert.equal(f.retention.snapshot().policy.rawDays,1)
})

test('partial cleanup exposes expiry metadata and pending state, never false zero search or false completion',t=>{
 const f=fixture(t),event=post(f,'pc.signal','RETRY_RAW_SENTINEL'),replace=f.retention.replaceJournal.bind(f.retention)
 f.retention.replaceJournal=()=>{throw Error('disk replace failed')}
 const result=f.configure({rawDays:1});assert.equal(result.cleanup.pending,true);assert.ok(result.cleanup.error)
 assert.match(readFileSync(f.retention.file,'utf8'),/RETRY_RAW_SENTINEL/)
 assert.equal(f.personal.source('hub#'+event.seq).sourceState,'expired');assert.equal(f.personal.source('hub#'+event.seq).text,'')
 assert.throws(()=>f.personal.search({query:'RETRY_RAW_SENTINEL'}),/清理尚未完成/)
 f.retention.replaceJournal=replace;f.retention.collect();assert.equal(f.retention.snapshot().pending,false)
 assert.doesNotMatch(readFileSync(f.retention.file,'utf8'),/RETRY_RAW_SENTINEL/)
 assert.equal(readdirSync(f.retention.root).filter(p=>p.endsWith('.next')).length,0)
})

test('lost completion and restart recover a committed journal purge without rehydrating source text',t=>{
 const f=fixture(t),event=post(f,'pc.signal','LOST_FINISH_SENTINEL');f.personal.search({query:'LOST_FINISH_SENTINEL'})
 f.retention.finish=()=>{throw Error('lost completion')};assert.equal(f.configure({rawDays:1}).cleanup.pending,true)
 assert.doesNotMatch(readFileSync(f.retention.file,'utf8'),/LOST_FINISH_SENTINEL/)
 f.close();const resumed=f.build();assert.equal(resumed.retention.snapshot().pending,false);assert.equal(resumed.personal.source('hub#'+event.seq).sourceState,'expired')
 assert.equal(resumed.personal.search({query:'LOST_FINISH_SENTINEL'}).total,0)
 assert.equal(resumed.store.get('hub').events.filter(e=>e.type==='source.retention.completed').length,1)
})

test('another writer and foreign SQLite files are refused before destructive replacement',t=>{
 const f=fixture(t);post(f,'pc.signal','CONCURRENT_SENTINEL');f.personal.search({query:'CONCURRENT_SENTINEL'})
 const replace=f.retention.replaceJournal.bind(f.retention);let injected=false
 f.retention.replaceJournal=(...args)=>{if(!injected){injected=true;f.store.append('hub',{type:'message.posted',messageId:'m_concurrent',author:{kind:'human',id:'owner'},text:'PROTECTED_CONCURRENT_OWNER_MESSAGE'})}return replace(...args)}
 assert.equal(f.configure({rawDays:1}).cleanup.pending,true);assert.match(readFileSync(f.retention.file,'utf8'),/CONCURRENT_SENTINEL/)
 f.retention.replaceJournal=replace;f.retention.collect();assert.match(readFileSync(f.retention.file,'utf8'),/PROTECTED_CONCURRENT_OWNER_MESSAGE/);assert.doesNotMatch(readFileSync(f.retention.file,'utf8'),/CONCURRENT_SENTINEL/)
 const fresh=post(f,'pc.signal','FOREIGN_CACHE_SENTINEL');f.configure({rawDays:0},'preserve-before-foreign');f.personal.search({query:'FOREIGN_CACHE_SENTINEL'});const file=f.personal.index.file;f.personal.index.close();rmSync(file)
 const db=new DatabaseSync(file);db.exec('CREATE TABLE precious(data TEXT); INSERT INTO precious VALUES(\'keep\')');db.close();const bytes=readFileSync(file)
 assert.equal(f.configure({rawDays:1},'foreign-cache-retention').cleanup.pending,true);assert.deepEqual(readFileSync(file),bytes)
 assert.equal(f.personal.source('hub#'+fresh.seq).sourceState,'expired');assert.throws(()=>f.personal.search({query:'FOREIGN_CACHE_SENTINEL'}),/清理尚未完成/)
})

test('expired observation retries stay deduplicated, summaries do not renew themselves, late data excludes expired inputs',async t=>{
 const f=fixture(t);f.observations.hello('dev-a','设备甲');const policy=await f.observations.configure({deviceId:'dev-a',policy:{enabled:true},expectedRevision:0,requestId:'observe-retention-policy'})
 const item={eventId:'stable-event',localSeq:1,source:'activity',occurredAt:f.now()-20*60000,app:'测试应用',title:'旧标题',text:'SOURCE_REPLAY_SENTINEL'}
 const first=await f.observations.ingest('dev-a',{revision:policy.revision,events:[item]});await f.observations.summarize();assert.equal(f.observations.summaries.size,1)
 const count=f.store.get('hub').events.filter(e=>e.type==='observation.summary').length
 f.advance(2*DAY);f.configure({rawDays:1,summaryDays:1});assert.equal((await f.observations.summarize()).updated,0)
 const replay=await f.observations.ingest('dev-a',{revision:policy.revision,events:[item]});assert.equal(replay.receipts[0].status,'duplicate');assert.equal(replay.receipts[0].ref,first.receipts[0].ref)
 assert.equal(f.store.get('hub').events.filter(e=>e.type==='observation.summary').length,count);assert.doesNotMatch(allBytes(join(f.root,'hub')).toString('latin1'),/SOURCE_REPLAY_SENTINEL/)
 await f.observations.ingest('dev-a',{revision:policy.revision,events:[{...item,eventId:'late-new-event',text:'FRESH_LATE_DATA'}]})
 await f.observations.summarize();const current=[...f.observations.summaries.values()][0];assert.match(current.text,/FRESH_LATE_DATA/);assert.doesNotMatch(current.text,/SOURCE_REPLAY_SENTINEL/);assert.equal(current.refs.length,1)
})

test('SIGKILL after journal replacement but before completion recovers before source readers start',async t=>{
 const f=fixture(t);post(f,'pc.signal','KILL_RETENTION_SENTINEL');f.personal.search({query:'KILL_RETENTION_SENTINEL'});f.close()
 const imports=[['ProjectStore','../lib/store.js'],['SourceRetention','../lib/source-retention.js']].map(([name,path])=>`import {${name}} from ${JSON.stringify(new URL(path,import.meta.url).href)};`).join('\n')
 const code=imports+`const root=process.env.MIRA_RETENTION_TEST_ROOT,store=new ProjectStore(root+'/hub',{warn(){}}),projects=new ProjectStore(root+'/projects',{warn(){}});store.load();projects.load();const service=new SourceRetention(store,projects,{now:()=>Number(process.env.MIRA_RETENTION_NOW)});service.finish=()=>{process.send('purge-durable');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)};service.configure({policy:{rawDays:1},expectedRevision:0,requestId:'child-purge-request'});`
 const child=spawn(process.execPath,['--experimental-sqlite','--input-type=module','-e',code],{env:{...process.env,MIRA_RETENTION_TEST_ROOT:f.root,MIRA_RETENTION_NOW:String(f.now())},stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',d=>stderr+=d)
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')})
 const ready=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('Child stopped: '+stderr)}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('purge barrier timeout')),15000);timer.unref()})]);assert.equal(ready[0],'purge-durable')
 const exit=once(child,'exit');child.kill('SIGKILL');assert.equal((await exit)[1],'SIGKILL')
 assert.doesNotMatch(readFileSync(join(f.root,'hub/hub/events.jsonl'),'utf8'),/KILL_RETENTION_SENTINEL/)
 const resumed=f.build();assert.equal(resumed.retention.snapshot().pending,false);assert.equal(resumed.personal.search({query:'KILL_RETENTION_SENTINEL'}).total,0)
})

test('startup discards an old cache after a purge, then reuses current document and FTS rowids',t=>{
 const f=fixture(t);post(f,'pc.signal','RESTORED_CACHE_SENTINEL');post(f,'pc.signal','KEEP_RECENT_CACHE',{receivedAt:f.now(),at:f.now()})
 f.personal.search({query:'RESTORED_CACHE_SENTINEL'});const file=f.personal.index.file;f.personal.index.close();const old=readFileSync(file)
 f.configure({rawDays:1});f.personal.search({query:'KEEP_RECENT_CACHE'});f.close();writeFileSync(file,old)
 const resumed=f.build();assert.equal(resumed.retention.snapshot().pending,false);assert.equal(resumed.personal.search({query:'RESTORED_CACHE_SENTINEL'}).total,0)
 assert.doesNotMatch(readFileSync(file).toString('latin1'),/RESTORED_CACHE_SENTINEL/)
 const rows=()=>({docs:resumed.personal.index.db.prepare('SELECT rowid,ref,source_hash FROM docs ORDER BY rowid').all(),fts:resumed.personal.index.db.prepare('SELECT rowid,ref FROM source_fts ORDER BY rowid').all()})
 const before=rows();resumed.close();const again=f.build();assert.equal(again.personal.search({query:'KEEP_RECENT_CACHE'}).total,1)
 assert.deepEqual(again.personal.index.db.prepare('SELECT rowid,ref,source_hash FROM docs ORDER BY rowid').all(),before.docs)
 assert.deepEqual(again.personal.index.db.prepare('SELECT rowid,ref FROM source_fts ORDER BY rowid').all(),before.fts)
})

test('one retry finishes interrupted cleanup and also removes newly overdue input, using server received time',t=>{
 const f=fixture(t);post(f,'pc.signal','EARLY_PURGE_SENTINEL')
 const received=post(f,'pc.signal','RECENT_RECEIPT_SENTINEL',{receivedAt:f.now(),occurredAt:f.now()-300*DAY})
 const finish=f.retention.finish.bind(f.retention);f.retention.finish=()=>{throw Error('interrupted')}
 assert.equal(f.configure({rawDays:1}).cleanup.pending,true);assert.equal(f.personal.source('hub#'+received.seq).text,'RECENT_RECEIPT_SENTINEL')
 f.advance(2*DAY);f.retention.finish=finish;f.retention.collect()
 assert.equal(f.retention.snapshot().pending,false);assert.equal(f.retention.snapshot().expired,2)
 assert.doesNotMatch(readFileSync(f.retention.file,'utf8'),/EARLY_PURGE_SENTINEL|RECENT_RECEIPT_SENTINEL/)
})

test('reading an old saved reference applies a deadline even before the maintenance timer',t=>{
 const f=fixture(t),event=post(f,'pc.signal','DIRECT_READ_DEADLINE_SENTINEL',{receivedAt:f.now()})
 f.configure({rawDays:1});assert.equal(f.personal.source('hub#'+event.seq).text,'DIRECT_READ_DEADLINE_SENTINEL')
 f.advance(DAY);const expired=f.personal.source('hub#'+event.seq)
 assert.equal(expired.sourceState,'expired');assert.equal(expired.text,'');assert.doesNotMatch(readFileSync(f.retention.file,'utf8'),/DIRECT_READ_DEADLINE_SENTINEL/)
})

test('a blocked purge masks newly overdue sources before retrying the old plan',t=>{
 const f=fixture(t);post(f,'pc.signal','EARLIER_BLOCKED_SENTINEL');const replace=f.retention.replaceJournal.bind(f.retention)
 f.retention.replaceJournal=()=>{throw Error('replacement still unavailable')};assert.equal(f.configure({rawDays:1}).cleanup.pending,true)
 const later=post(f,'pc.signal','LATER_OVERDUE_SENTINEL',{receivedAt:f.now()});f.advance(2*DAY)
 const source=f.personal.source('hub#'+later.seq);assert.equal(source.text,'');assert.equal(source.sourceState,'expired');assert.equal(source.sourceCleanupPending,true)
 assert.equal(f.retention.snapshot().cleaned,0);assert.equal(f.retention.snapshot().pending,true)
 f.retention.replaceJournal=replace;f.retention.collect();assert.equal(f.retention.snapshot().cleaned,2);assert.equal(f.personal.source('hub#'+later.seq).sourceCleanupPending,false)
 assert.doesNotMatch(readFileSync(f.retention.file,'utf8'),/EARLIER_BLOCKED_SENTINEL|LATER_OVERDUE_SENTINEL/)
})

test('failure before a durable plan never turns into a false successful empty cleanup on retry',t=>{
 const f=fixture(t),event=post(f,'pc.signal','PRE_PLAN_FAILURE_SENTINEL'),prepare=f.retention.prepareRoot.bind(f.retention)
 f.retention.prepareRoot=()=>{throw Error('private directory unavailable')}
 assert.equal(f.configure({rawDays:1}).cleanup.pending,true);assert.throws(()=>f.retention.collect(),/清理尚未完成/)
 const source=f.personal.source('hub#'+event.seq);assert.equal(source.text,'');assert.equal(source.sourceCleanupPending,true);assert.equal(f.retention.snapshot().pending,true)
 f.retention.prepareRoot=prepare;f.retention.collect();assert.equal(f.retention.snapshot().cleaned,1);assert.equal(f.retention.snapshot().pending,false)
 assert.doesNotMatch(readFileSync(f.retention.file,'utf8'),/PRE_PLAN_FAILURE_SENTINEL/)
})

test('read projections hide overdue bodies and summaries even if the log cannot record a cleanup plan',async t=>{
 const f=fixture(t);f.retention.prepareRoot=()=>{throw Error('journal planning unavailable')}
 const raw=post(f,'observation.accepted','VIEW_RAW_OVERDUE',{receivedAt:f.now()}),summary=post(f,'observation.summary','VIEW_SUMMARY_OVERDUE',{windowId:'projection-overdue',receivedAt:f.now()})
 f.store.append('hub',{type:'connector.registered',connectorId:'expired-mail',name:'测试邮箱',provider:'graph-mail',scope:'fixture'})
 post(f,'connector.record','VIEW_MAIL_OVERDUE',{connectorId:'expired-mail',externalId:'mail-one',receivedAt:f.now()})
 f.configure({rawDays:1,summaryDays:1});assert.equal(f.personal.source('hub#'+raw.seq).sourceExpiresAt,f.now()+DAY)
 f.advance(2*DAY)
 assert.equal(f.observations.view(raw).text,'');assert.equal(f.observations.view(summary).sourceCleanupPending,true)
 assert.equal(f.connectors.snapshot().items[0].records,0);assert.equal(f.connectors.snapshot().activity.length,0)
 assert.equal(f.personal.snapshot().activity.some(a=>/VIEW_.*OVERDUE/.test(a.text)),false)
 assert.equal((await f.observations.summarize()).updated,0)
 assert.equal(f.personal.source('hub#'+summary.seq).text,'');assert.equal(f.retention.snapshot().cleaned,0)
})

test('the legacy daily board and model day reader also hide overdue PC text before planning can succeed',t=>{
 const f=fixture(t),received=f.now();post(f,'pc.signal','DAY_SIGNAL_OVERDUE',{receivedAt:received,occurredAt:received})
 post(f,'pc.window','',{summary:'DAY_WINDOW_OVERDUE',receivedAt:received,occurredAt:received,minutes:10})
 f.configure({rawDays:1});f.retention.prepareRoot=()=>{throw Error('planning unavailable')};f.advance(2*DAY)
 const view=buildDay(f.projects,f.store.get('hub'),{day:'2026-11-05',now:f.now()})
 assert.doesNotMatch(JSON.stringify(view)+renderDay(view),/DAY_SIGNAL_OVERDUE|DAY_WINDOW_OVERDUE/)
 assert.equal(view.pcMinutes,10);assert.equal(view.devices[0].minutes,10)
 assert.equal(Object.keys(f.store.get('hub')).includes('sourceRetention'),false)
})

test('malformed journals and symlinked journal/cache paths fail without replacing foreign bytes',t=>{
 const f=fixture(t);post(f,'pc.signal','MALFORMED_SOURCE_SENTINEL');appendFileSync(f.retention.file,'{incomplete\n')
 const original=readFileSync(f.retention.file);assert.equal(f.configure({rawDays:1}).cleanup.pending,true)
 assert.ok(readFileSync(f.retention.file).subarray(0,original.length).equals(original));assert.equal(readdirSync(f.retention.root).filter(p=>p.endsWith('.next')).length,0)
 const g=fixture(t);post(g,'pc.signal','SYMLINK_SOURCE_SENTINEL');const target=join(g.root,'foreign-journal');renameSync(g.retention.file,target);symlinkSync(target,g.retention.file);const bytes=readFileSync(target)
 assert.throws(()=>g.configure({rawDays:1}),/归属/);assert.deepEqual(readFileSync(target),bytes)
 const h=fixture(t);post(h,'pc.signal','SYMLINK_CACHE_SENTINEL');h.personal.search({query:'SYMLINK_CACHE_SENTINEL'});const cache=h.personal.index.file;h.personal.index.close()
 const foreign=join(h.root,'foreign-cache');renameSync(cache,foreign);symlinkSync(foreign,cache);const cacheBytes=readFileSync(foreign)
 assert.equal(h.configure({rawDays:1}).cleanup.pending,true);assert.deepEqual(readFileSync(foreign),cacheBytes)
})
