import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore } from '../lib/store.js'
import { Actions } from '../lib/actions.js'
import { ensureHub } from '../lib/hub.js'
import { PersonalMira } from '../lib/personal.js'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'mira-personal-index-')),store=new ProjectStore(root,{warn(){}}),hubStore=new ProjectStore(join(root,'_hub'),{warn(){}});store.load();hubStore.load();ensureHub(hubStore)
 const driver={deliver(){},status:()=> 'idle'},actions=new Actions(store,driver),instances=[]
 const make=(options={})=>{const p=new PersonalMira(hubStore,driver,store,actions,options);instances.push(p);return p}
 const personal=make();t.after(()=>{for(const p of instances)p.close();rmSync(root,{recursive:true,force:true})})
 const post=(projectId,text)=>actions.ownerPost({projectId,text})
 return{root,store,hubStore,actions,driver,make,personal,post}
}
function legacy(personal,args={}) {
 const terms=(args.query||'').trim().toLowerCase().split(/\s+/).filter(Boolean),items=[]
 for(const p of [...personal.projects.projects.values(),personal.hub])for(const e of p.events){
  if(p.hub&&e.type==='message.posted'&&!args.includePersonal)continue
  if(!personal.searchable(p,e))continue
  const s=personal.materialize(p,e);if(!s||args.projectId&&s.projectId!==args.projectId||args.since&&s.happenedAt<Date.parse(args.since)||args.until&&s.happenedAt>=Date.parse(args.until))continue
  const body=`${s.projectName||''}\n${s.threadTitle||''}\n${s.deviceName||''}\n${s.title}\n${s.text}`.toLowerCase();if(terms.every(t=>body.includes(t)))items.push(s)
 }
 items.sort((a,b)=>b.happenedAt-a.happenedAt||a.ref.localeCompare(b.ref));return{refs:items.slice(0,args.limit||20).map(s=>s.ref),total:items.length,hasMore:items.length>(args.limit||20)}
}
const result=(p,args)=>{const r=p.search(args);return{refs:r.items.map(i=>i.ref),total:r.total,hasMore:r.hasMore}}

test('persistent search preserves Chinese, punctuation, unsafe UTF-16, scope, time and exact total semantics',t=>{
 const f=fixture(t),a=f.actions.createProject({name:'项目甲'}).projectId,b=f.actions.createProject({name:'项目乙'}).projectId
 for(const projectId of[a,b])for(const text of ['中文预算核对','budget\0AFTER_NULL','ab\ud800\udc00 tail','lone \ud800xyz','emoji 😀完成','foo"bar A_B a%b','İSTANBUL'])f.hubStore.append('hub',{type:'pc.signal',deviceId:projectId,projectRef:projectId,text,occurredAt:Date.parse('2026-11-01T03:00:00Z')})
 f.post(a,'当前项目真记录');f.personal.post({text:'仅仅是用户当前问题 CURRENT_QUESTION',requestId:'index-question-001'})
 for(const query of ['预算核对','预算','budget\0AFTER','ab\ud800','\ud800xyz','😀完成','foo"bar','A_B','a%b','İSTANBUL','','不存在'])for(const projectId of[undefined,a])assert.deepEqual(result(f.personal,{query,projectId,limit:3}),legacy(f.personal,{query,projectId,limit:3}))
 assert.deepEqual(result(f.personal,{query:'预算',since:'2026-11-01T00:00:00Z',until:'2026-11-02T00:00:00Z'}),legacy(f.personal,{query:'预算',since:'2026-11-01T00:00:00Z',until:'2026-11-02T00:00:00Z'}))
 assert.equal(f.personal.search({query:'CURRENT_QUESTION'}).total,0);assert.equal(f.personal.search({query:'CURRENT_QUESTION',includePersonal:true}).total,1)
 assert.equal(statSync(f.personal.index.file).mode&0o077,0)
})

test('index reuses durable rows after reopen, observes appended records, and never indexes private bookkeeping',t=>{
 const f=fixture(t),id=f.actions.createProject({name:'项目'}).projectId;f.post(id,'EXACT_SOURCE budget120')
 f.hubStore.append('hub',{type:'connector.checkpoint',token:'PRIVATE_CHECKPOINT_TOKEN',cursor:'PRIVATE_CURSOR_VALUE'})
 f.personal.search({query:'EXACT_SOURCE'});assert.ok(f.personal.index.stats().writes>0);const file=f.personal.index.file;f.personal.close()
 const p=f.make();assert.equal(p.search({query:'EXACT_SOURCE'}).total,1);assert.equal(p.index.stats().writes,0)
 f.post(id,'APPENDED budget240');assert.equal(p.search({query:'APPENDED'}).total,1);assert.equal(p.index.stats().lastProcessedEvents,1)
 assert.doesNotMatch(readFileSync(file).toString('latin1'),/PRIVATE_CHECKPOINT_TOKEN|PRIVATE_CURSOR_VALUE/)
})

test('restart with an unindexed journal tail preserves all unchanged document and FTS rowids',t=>{
 const f=fixture(t),id=f.actions.createProject({name:'尾部恢复'}).projectId;f.post(id,'INDEXED_PREFIX');f.personal.search({query:'INDEXED_PREFIX'})
 const rows=f.personal.index.db.prepare('SELECT rowid,ref,source_hash FROM docs ORDER BY ref').all(),fts=f.personal.index.db.prepare('SELECT rowid,ref,searchable FROM source_fts ORDER BY ref').all()
 f.post(id,'UNINDEXED_TAIL');f.personal.close();const p=f.make();assert.equal(p.search({query:'UNINDEXED_TAIL'}).total,1);assert.equal(p.index.stats().writes,1)
 const actual=p.index.db.prepare('SELECT rowid,ref,source_hash FROM docs ORDER BY ref').all(),actualFts=p.index.db.prepare('SELECT rowid,ref,searchable FROM source_fts ORDER BY ref').all()
 for(const row of rows)assert.ok(actual.some(a=>JSON.stringify(a)===JSON.stringify(row)))
 for(const row of fts)assert.ok(actualFts.some(a=>JSON.stringify(a)===JSON.stringify(row)))
})

test('project/thread renames update old indexed sources without rewriting authoritative events',t=>{
 const f=fixture(t),id=f.actions.createProject({name:'原项目'}).projectId,p=f.store.get(id);f.post(id,'固定正文')
 const {threadId}=f.actions.openThread(p,{title:'原任务',brief:'保持正文',assignee:'工程师'});f.store.append(id,{type:'message.posted',messageId:'m_fixture',threadId,author:{kind:'assistant',id:'engineer'},text:'任务交付正文',trust:'relay',to:[],mentions:[]})
 f.personal.search({query:'原项目'});const before=readFileSync(join(f.root,id,'events.jsonl'),'utf8')
 f.store.append(id,{type:'project.updated',name:'新项目'});f.store.append(id,{type:'thread.updated',threadId,patch:{title:'新任务'}})
 assert.deepEqual(result(f.personal,{query:'新项目 新任务'}),legacy(f.personal,{query:'新项目 新任务'}));assert.equal(f.personal.search({query:'原项目'}).total,0)
 assert.ok(readFileSync(join(f.root,id,'events.jsonl'),'utf8').startsWith(before))
})

test('connector edits/deletes remove current hits while old citation text remains readable',t=>{
 const f=fixture(t),latest=new Map(),connectors={records:latest,isCurrent:e=>!e.deleted&&latest.get(e.connectorId+'|'+e.externalId)?.seq===e.seq,snapshot:()=>({items:[]})};const p=f.make({connectors})
 const accept=(text,deleted=false)=>{const e=f.hubStore.append('hub',{type:'connector.record',connectorId:'c_one',externalId:'mail-one',source:'email',title:'邮件',text,trust:'external',occurredAt:Date.now(),deleted});latest.set('c_one|mail-one',e);return'hub#'+e.seq}
 const old=accept('ALPHA prior');assert.equal(p.search({query:'ALPHA'}).total,1)
 accept('BETA current');assert.equal(p.search({query:'ALPHA'}).total,0);assert.equal(p.search({query:'BETA'}).total,1);assert.equal(p.source(old).text,'ALPHA prior')
 accept('',true);assert.equal(p.search({query:'BETA'}).total,0);assert.equal(p.source(old).sourceState,'deleted')
})

test('summary replacement keeps old evidence accessible and search sees only the current revision',t=>{
 const f=fixture(t),summaries=new Map(),observations={summaries,view:()=>({})},p=f.make({observations})
 const summary=text=>{const e=f.hubStore.append('hub',{type:'observation.summary',windowId:'window-one',title:'摘要',text,trust:'observation',occurredAt:Date.now()});summaries.set(e.windowId,e);return'hub#'+e.seq}
 const old=summary('WINDOW_V1');assert.equal(p.search({query:'WINDOW_V1'}).total,1);summary('WINDOW_V2');assert.equal(p.search({query:'WINDOW_V1'}).total,0);assert.equal(p.search({query:'WINDOW_V2'}).total,1);assert.equal(p.source(old).text,'WINDOW_V1')
})

test('corrupt owned cache is rebuilt from unchanged journals; foreign databases are not deleted',t=>{
 const f=fixture(t),id=f.actions.createProject({name:'恢复项目'}).projectId;f.post(id,'RECOVER_FROM_SOURCE')
 assert.equal(f.personal.search({query:'RECOVER_FROM_SOURCE'}).total,1);const file=f.personal.index.file;f.personal.close();const before=readFileSync(join(f.root,id,'events.jsonl'))
 writeFileSync(file,'corrupted cache');const p=f.make();assert.equal(p.search({query:'RECOVER_FROM_SOURCE'}).total,1);p.close();assert.deepEqual(readFileSync(join(f.root,id,'events.jsonl')),before)
 rmSync(file);const db=new DatabaseSync(file);db.exec('CREATE TABLE valuable_user_data(note TEXT);INSERT INTO valuable_user_data VALUES (\'keep\')');db.close()
 const foreign=f.make();assert.throws(()=>foreign.search({query:'RECOVER_FROM_SOURCE'}),/检索索引|缓存/);const check=new DatabaseSync(file);assert.equal(check.prepare('SELECT note FROM valuable_user_data').get().note,'keep');check.close()
})

test('ambiguous COMMIT response recovers from actual durable rows instead of advancing an assumed watermark',t=>{
 const f=fixture(t),id=f.actions.createProject({name:'提交恢复'}).projectId;f.post(id,'FIRST_COMMIT')
 f.personal.search({query:'FIRST_COMMIT'});f.post(id,'SECOND_COMMIT')
 const db=f.personal.index.db,exec=db.exec.bind(db);let dropped=false
 db.exec=sql=>{const r=exec(sql);if(sql==='COMMIT'&&!dropped){dropped=true;throw Error('lost commit response')}return r}
 assert.throws(()=>f.personal.search({query:'SECOND_COMMIT'}),/检索索引暂不可用/);assert.equal(dropped,true)
 const p=f.make();assert.equal(p.search({query:'SECOND_COMMIT'}).total,1);assert.equal(p.index.stats().writes,0)
 f.post(id,'THIRD_COMMIT');assert.equal(p.search({query:'THIRD_COMMIT'}).total,1);assert.equal(p.index.stats().lastProcessedEvents,1)
})

test('SIGKILL before COMMIT rolls back documents and watermarks together; restart replays original journals',async t=>{
 const f=fixture(t),id=f.actions.createProject({name:'进程恢复'}).projectId;f.post(id,'KILL_BASELINE')
 f.personal.search({query:'KILL_BASELINE'});f.personal.close();f.post(id,'KILL_PENDING')
 const source=readFileSync(join(f.root,id,'events.jsonl'))
 const imports=[['ProjectStore','../lib/store.js'],['PersonalMira','../lib/personal.js']].map(([name,path])=>`import { ${name} } from ${JSON.stringify(new URL(path,import.meta.url).href)};`).join('\n')
 const code=imports+`
  const root=process.env.MIRA_INDEX_TEST_ROOT,projects=new ProjectStore(root,{warn(){}}),hub=new ProjectStore(root+'/_hub',{warn(){}});projects.load();hub.load();
  const personal=new PersonalMira(hub,{status:()=> 'idle'},projects,{});personal.index.open();
  const db=personal.index.db,exec=db.exec.bind(db);db.exec=sql=>{if(sql==='COMMIT'){process.send('transaction-ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}return exec(sql)};
  personal.search({query:'KILL_PENDING'});
 `
 const child=spawn(process.execPath,['--experimental-sqlite','--input-type=module','-e',code],{env:{...process.env,MIRA_INDEX_TEST_ROOT:f.root},stdio:['ignore','ignore','pipe','ipc']})
 let stderr='';child.stderr.on('data',d=>stderr+=d);t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')})
 const ready=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('child exited: '+stderr)}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('transaction barrier timeout')),15000);timer.unref()})])
 assert.equal(ready[0],'transaction-ready');const stopped=once(child,'exit');child.kill('SIGKILL');const[codeStatus,signal]=await stopped;assert.equal(codeStatus,null);assert.equal(signal,'SIGKILL')
 const db=new DatabaseSync(f.personal.index.file);assert.equal(db.prepare("SELECT count(*) AS n FROM docs WHERE searchable LIKE '%kill_pending%'").get().n,0);db.close()
 const p=f.make();assert.equal(p.search({query:'KILL_PENDING'}).total,1);assert.equal(p.search({query:'KILL_BASELINE'}).total,1);assert.deepEqual(readFileSync(join(f.root,id,'events.jsonl')),source)
})

test('logical row/FTS corruption and a restored source prefix cannot silently hide or invent results',t=>{
 const f=fixture(t),id=f.actions.createProject({name:'权威来源'}).projectId;f.post(id,'CANONICAL_ALPHA');f.post(id,'CANONICAL_BETA')
 f.personal.search({query:'CANONICAL_ALPHA'});const file=f.personal.index.file
 const tamper=new DatabaseSync(file);tamper.exec("DELETE FROM source_fts;UPDATE docs SET searchable='invented phantom' WHERE searchable LIKE '%canonical_alpha%'");tamper.close()
 assert.equal(f.personal.search({query:'CANONICAL_ALPHA'}).total,1);assert.equal(f.personal.search({query:'invented phantom'}).total,0)
 f.personal.close();const log=join(f.root,id,'events.jsonl'),lines=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)
 lines.find(e=>e.text==='CANONICAL_ALPHA').text='RESTORED_SOURCE_GAMMA';writeFileSync(log,lines.map(e=>JSON.stringify(e)).join('\n')+'\n')
 const projects=new ProjectStore(f.root,{warn(){}});projects.load();const p=new PersonalMira(f.hubStore,f.driver,projects,f.actions);t.after(()=>p.close())
 assert.equal(p.search({query:'CANONICAL_ALPHA'}).total,0);assert.equal(p.search({query:'RESTORED_SOURCE_GAMMA'}).total,1);assert.equal(p.search({query:'CANONICAL_BETA'}).total,1)
})

test('damaged inverted-index segments rebuild from authoritative records',t=>{
 const f=fixture(t),id=f.actions.createProject({name:'倒排恢复'}).projectId;f.post(id,'INVERTED_SOURCE_NEEDLE');f.personal.search({query:'INVERTED_SOURCE_NEEDLE'})
 const db=new DatabaseSync(f.personal.index.file);db.enableDefensive(false);db.exec('DELETE FROM source_fts_idx; DELETE FROM source_fts_data WHERE id>10');db.close()
 assert.equal(f.personal.search({query:'INVERTED_SOURCE_NEEDLE'}).total,1)
})

test('symbolic links and damaged foreign SQLite databases are refused without altering their bytes',t=>{
 const f=fixture(t),id=f.actions.createProject({name:'边界'}).projectId;f.post(id,'BOUNDARY_SOURCE');f.personal.search({query:'BOUNDARY_SOURCE'});const file=f.personal.index.file;f.personal.close()
 rmSync(file);const foreign=join(f.root,'foreign.sqlite'),db=new DatabaseSync(foreign);db.exec('CREATE TABLE owner_data(value TEXT);INSERT INTO owner_data VALUES(\'keep\')');db.close();const bytes=readFileSync(foreign)
 symlinkSync(foreign,file);assert.throws(()=>f.make().search({query:'BOUNDARY_SOURCE'}),/检索索引/);assert.deepEqual(readFileSync(foreign),bytes)
 rmSync(file);const broken=Buffer.from(bytes);broken.fill(0,100,200);writeFileSync(file,broken)
 const mode=statSync(file).mode
 assert.throws(()=>f.make().search({query:'BOUNDARY_SOURCE'}),/检索索引/);assert.deepEqual(readFileSync(file),broken);assert.equal(statSync(file).mode,mode)
})

test('warm long-word queries materialize only FTS candidates, short queries preserve complete totals',t=>{
 const f=fixture(t),id=f.actions.createProject({name:'候选验证'}).projectId
 for(let i=0;i<500;i++)f.post(id,i%97===0?'UNIQUE_NEEDLE 中文预算':'普通资料 '+i)
 f.personal.search({query:'UNIQUE_NEEDLE'});const expected=legacy(f.personal,{query:'UNIQUE_NEEDLE',limit:2})
 let materialized=0;const original=f.personal.materialize.bind(f.personal);f.personal.materialize=(...args)=>{materialized++;return original(...args)}
 assert.deepEqual(result(f.personal,{query:'UNIQUE_NEEDLE',limit:2}),expected);assert.equal(f.personal.index.stats().lastProcessedEvents,0);assert.equal(materialized,expected.total);assert.equal(f.personal.index.stats().lastCandidates,expected.total)
 assert.deepEqual(result(f.personal,{query:'预算',limit:2}),legacy(f.personal,{query:'预算',limit:2}));assert.equal(f.personal.index.stats().lastCandidates,expected.total)
 assert.deepEqual(result(f.personal,{query:'资料',limit:3}),legacy(f.personal,{query:'资料',limit:3}));f.store.touch();assert.equal(f.personal.search({query:'UNIQUE_NEEDLE'}).total,expected.total);assert.equal(f.personal.index.stats().lastProcessedEvents,0)
})

test('candidate filters preserve deterministic Unicode substring semantics including split surrogate pairs',t=>{
 const f=fixture(t),id=f.actions.createProject({name:'字符检索'}).projectId
 const alphabet=['中','文','a','B','İ','😀','𐀀','\ud800','\udc00','\0','"','%','_','+','\u0307','\u200b',' ']
 let seed=13579;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n}
 const texts=[]
 for(let i=0;i<160;i++){let text='';for(let j=0;j<18;j++)text+=alphabet[random(alphabet.length)];texts.push(text);f.post(id,text)}
 const queries=['"""','++_','😀','\ud800','\udc00','\0','İ','文中']
 for(let i=0;i<90;i++){const text=texts[random(texts.length)],start=random(text.length);queries.push(text.slice(start,start+1+random(8)))}
 for(const query of queries)assert.deepEqual(result(f.personal,{query,limit:7}),legacy(f.personal,{query,limit:7}),JSON.stringify(query))
})
