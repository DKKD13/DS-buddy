import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { ProjectStore } from '../lib/store.js'
import { ensureHub } from '../lib/hub.js'
import { Connectors, loadConnectorConfig } from '../lib/connectors.js'
import { PersonalMira } from '../lib/personal.js'

async function fixture(t, provider = 'graph-mail') {
  const root = mkdtempSync(join(tmpdir(), 'mira-connectors-'));let now = Date.parse('2026-11-05T00:00:00Z')
  const store = new ProjectStore(join(root, '_hub'), { warn() {} });store.load();ensureHub(store)
  const calls = [];let handler = () => ({ value: [], '@odata.deltaLink': origin + '/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=private-cursor' })
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (req.url.startsWith('/v1.0/me?')) { res.end(JSON.stringify({ id: 'account-1' }));return }
    const result = await handler(req, res);if (result === undefined) return
    res.setHeader('content-type', 'application/json');res.end(JSON.stringify(result))
  });server.listen(0,'127.0.0.1');await once(server,'listening');const origin = 'http://127.0.0.1:' + server.address().port
  const credentialFile = join(root, 'token.json');const token = 'fixture-private-connector-token-001';writeFileSync(credentialFile, JSON.stringify({ accountId: 'account-1', token }), { mode: 0o600 })
  const configs = [{ id: 'source-1', name: '工作资料', provider, accountId: 'account-1', ...(provider === 'feishu-chat' ? { chatId: 'oc_fixture' } : {}), credentialFile, origin }]
  const options = { configs, root: join(root, 'state'), now: () => now, allowLoopback: true }
  const connectors = new Connectors(store, options)
  t.after(async () => { connectors.close();server.closeAllConnections();server.close();rmSync(root,{ recursive:true,force:true }) })
  const enable = c => c.configure({ id: 'source-1', enabled: true, expectedRevision: c.snapshot().items[0].revision, requestId: 'enable-' + c.hub.seq })
  return { root, store, configs, options, connectors, calls, token, credentialFile, origin, enable, handler: fn => { handler = fn }, advance: ms => { now += ms }, get now() { return now } }
}
const mail = (id, text = 'ALPHA交付安排', date = '2026-11-05T00:00:01Z') => ({ id, subject: '交付', body: { contentType: 'text', content: text }, from: { emailAddress: { name: '同事', address: 'person@example.invalid' } }, receivedDateTime: date, lastModifiedDateTime: date })

test('sources default paused, private config is bounded, and browser status never reveals token, paths or cursors', async t => {
  const f = await fixture(t);await f.connectors.tick();assert.equal(f.calls.length,0)
  assert.equal(f.connectors.snapshot().items[0].enabled,false)
  const file = join(f.root,'config.json');writeFileSync(file,JSON.stringify({ sources:f.configs }),{mode:0o600});assert.equal(loadConnectorConfig(file,{allowLoopback:true}).length,1);const loaded=new Connectors(f.store,{...f.options,configs:loadConnectorConfig(file,{allowLoopback:true})});loaded.close()
  chmodSync(file,0o644);assert.throws(()=>loadConnectorConfig(file,{allowLoopback:true}),/私有/)
  assert.doesNotMatch(JSON.stringify(f.connectors.snapshot()),/fixture-private|token.json|deltatoken/)
  assert.throws(()=>new Connectors(f.store,{...f.options,configs:[{...f.configs[0],origin:'https://attacker.invalid'}]}),/服务地址/)
})

test('Graph reads only GET after explicit enable, filters pre-activation mail and durably resumes its opaque delta cursor', async t => {
  const f = await fixture(t);f.enable(f.connectors)
  f.handler(()=>({value:[mail('before','old','2026-11-04T00:00:00Z'),mail('m1')],'@odata.deltaLink':f.origin+'/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=private-cursor'}))
  await f.connectors.tick();assert.equal(f.connectors.snapshot().items[0].records,1)
  assert.ok(f.calls.every(c=>c.method==='GET'));assert.ok(decodeURIComponent(f.calls[1].url.replaceAll('+',' ')).includes('receivedDateTime ge 2026-11-05T00:00:00.000Z'))
  f.connectors.close();const restored = new Connectors(f.store,f.options);t.after(()=>restored.close());f.advance(61000)
  await restored.tick();assert.ok(f.calls.at(-1).url.includes('deltatoken=private-cursor'))
  assert.equal(restored.snapshot().items[0].records,1)
  assert.doesNotMatch(readFileSync(join(f.store.root,'hub/events.jsonl'),'utf8'),/private-cursor|fixture-private-connector-token/)
})

test('a lost cursor checkpoint retries a partially committed page without duplicate records', async t => {
  const f=await fixture(t);f.enable(f.connectors);f.handler(()=>({value:[mail('m1'),mail('m2')],'@odata.deltaLink':f.origin+'/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next'}))
  const save=f.connectors.checkpoint.bind(f.connectors);let fail=true
  f.connectors.checkpoint=(...args)=>{if(fail){fail=false;throw Error('lost checkpoint')}return save(...args)}
  await f.connectors.tick();assert.equal(f.connectors.records.size,2);f.advance(121000);await f.connectors.tick()
  assert.equal(f.store.get('hub').events.filter(e=>e.type==='connector.record').length,2)
  assert.equal(f.connectors.snapshot().items[0].state,'ready')
})

test('429 honors retry-after across restarts and auth failure pauses requests until credentials rotate', async t => {
  const f=await fixture(t);f.enable(f.connectors);f.handler((_req,res)=>{res.statusCode=429;res.setHeader('retry-after','120');return {error:'private-error-not-stored'}})
  await f.connectors.tick();const count=f.calls.length;f.advance(61000);await f.connectors.tick();assert.equal(f.calls.length,count)
  f.connectors.close();const c=new Connectors(f.store,f.options);t.after(()=>c.close());await c.tick();assert.equal(f.calls.length,count)
  f.advance(61000);f.handler((_req,res)=>{res.statusCode=401;return {error:f.token}});await c.tick();const rejected=f.calls.length;f.advance(1000000);await c.tick();assert.equal(f.calls.length,rejected)
  writeFileSync(f.credentialFile,JSON.stringify({accountId:'account-1',token:f.token+'-rotated'}),{mode:0o600});f.handler(()=>({value:[],'@odata.deltaLink':f.origin+'/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next'}));await c.tick();assert.ok(f.calls.length>rejected)
  assert.doesNotMatch(JSON.stringify(c.snapshot()),/private-error|fixture-private/)
})

test('pausing during an HTTP request prevents commit, and resume starts after the paused interval', async t => {
  const f=await fixture(t);f.enable(f.connectors);let release;const ready=new Promise(resolve=>release=resolve);let entered;const wait=new Promise(resolve=>entered=resolve)
  f.handler(async()=>{entered();await ready;return {value:[mail('m1')],'@odata.deltaLink':f.origin+'/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next'}})
  const polling=f.connectors.tick();await wait;f.connectors.configure({id:'source-1',enabled:false,expectedRevision:f.connectors.snapshot().items[0].revision,requestId:'pause-source-001'});release();await polling;assert.equal(f.connectors.records.size,0)
  f.advance(3600000);f.enable(f.connectors);f.handler(()=>({value:[mail('paused','skip')],'@odata.deltaLink':f.origin+'/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next'}));await f.connectors.tick();assert.equal(f.connectors.records.size,0)
  assert.ok(decodeURIComponent(f.calls.at(-1).url.replaceAll('+',' ')).includes('2026-11-05T01:00:00.000Z'))
})

test('provider pagination cannot redirect credentials, and identity mismatch cannot mix mailboxes', async t => {
  const f=await fixture(t);f.enable(f.connectors);f.handler(()=>({value:[],'@odata.nextLink':'https://attacker.invalid/steal'}));await f.connectors.tick()
  assert.ok(f.calls.every(c=>!c.url.includes('attacker')));assert.equal(f.connectors.snapshot().items[0].state,'error')
  assert.doesNotMatch(JSON.stringify(f.connectors.snapshot()),/attacker/)
  const configs=[{...f.configs[0],id:'wrong-account',accountId:'different'}];writeFileSync(f.credentialFile,JSON.stringify({accountId:'different',token:f.token}),{mode:0o600})
  const c=new Connectors(f.store,{...f.options,configs,root:join(f.root,'other')});t.after(()=>c.close());c.configure({id:'wrong-account',enabled:true,expectedRevision:c.snapshot().items.find(x=>x.id==='wrong-account').revision,requestId:'enable-wrong-001'});await c.tick()
  assert.equal(c.snapshot().items.find(x=>x.id==='wrong-account').state,'authentication-required');assert.equal(c.records.size,0)
})

test('Feishu advances bounded chat pagination, filters old messages, reuses Mira raw identity, and excludes edits/deletes from current search', async t => {
  const f=await fixture(t,'feishu-chat');f.enable(f.connectors)
  const message=(id,text,date='1793836801000')=>({message_id:id,create_time:date,update_time:date,chat_id:'oc_fixture',msg_type:'text',body:{content:JSON.stringify({text})},sender:{id:'ou_person'}})
  f.handler(req=>({code:0,data:{items:[message('om_old','past','1793750400000'),message('om_1','ALPHA 飞书')],has_more:!req.url.includes('page_token'),...(req.url.includes('page_token')?{}:{page_token:'page-2-private'})}}))
  await f.connectors.tick();f.advance(61000);await f.connectors.tick();assert.ok(f.calls.at(-1).url.includes('page_token=page-2-private'));assert.equal(f.connectors.records.size,1)
  const projects=new ProjectStore(join(f.root,'projects'),{warn(){}});projects.load();const personal=new PersonalMira(f.store,{status:()=> 'idle'},projects,{}, {connectors:f.connectors})
  const source=personal.search({query:'ALPHA'}).items[0];assert.equal(source.trust,'external');assert.equal(source.source,'lark');assert.equal(source.externalId,'om_1')
  f.handler(()=>({code:0,data:{items:[message('om_1','BETA 修订')],has_more:false}}));f.advance(61000);await f.connectors.tick();assert.equal(personal.search({query:'ALPHA'}).items.length,0);assert.equal(personal.source(source.ref).text.includes('ALPHA'),true)
  f.handler(()=>({code:0,data:{items:[{...message('om_1',''),deleted:true}],has_more:false}}));f.advance(61000);await f.connectors.tick();assert.equal(personal.search({query:'BETA'}).items.length,0)
})

test('restoring an unreadable credential file resumes with the same valid token, without losing the cursor', async t => {
  const f=await fixture(t);f.enable(f.connectors);await f.connectors.tick();const count=f.calls.length
  writeFileSync(f.credentialFile,'broken',{mode:0o600});f.advance(61000);await f.connectors.tick();assert.equal(f.calls.length,count)
  writeFileSync(f.credentialFile,JSON.stringify({accountId:'account-1',token:f.token}),{mode:0o600});await f.connectors.tick();assert.ok(f.calls.length>count)
})

test('HTTP redirects never receive credentials and expired delta cursors require an explicit new baseline', async t => {
  const f=await fixture(t);f.enable(f.connectors);f.handler((_req,res)=>{res.statusCode=302;res.setHeader('location',f.origin+'/steal');res.end();return undefined});await f.connectors.tick()
  assert.equal(f.calls.some(c=>c.url.includes('steal')),false)
  f.advance(61000);f.handler((_req,res)=>{res.statusCode=410;return {error:'expired-opaque-cursor'}});await f.connectors.tick();assert.equal(f.connectors.snapshot().items[0].state,'resync-required')
  const count=f.calls.length;f.advance(3600000);await f.connectors.tick();assert.equal(f.calls.length,count)
  f.enable(f.connectors);f.handler(()=>({value:[],'@odata.deltaLink':f.origin+'/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=reset'}));await f.connectors.tick();assert.ok(f.calls.length>count)
})

test('token rotation does not bypass provider rate limits, and a changed chat cannot reuse an existing source identity', async t => {
  const f=await fixture(t,'feishu-chat');f.enable(f.connectors);f.handler((_req,res)=>{res.statusCode=429;res.setHeader('retry-after','600');return {}});await f.connectors.tick();const count=f.calls.length
  writeFileSync(f.credentialFile,JSON.stringify({accountId:'account-1',token:f.token+'-rotated'}),{mode:0o600});f.advance(61000);await f.connectors.tick();assert.equal(f.calls.length,count)
  assert.throws(()=>new Connectors(f.store,{...f.options,configs:[{...f.configs[0],chatId:'oc_other'}]}),/新的连接器标识/)
})

test('a Feishu response from another chat is rejected before any records or page cursor advance', async t => {
  const f=await fixture(t,'feishu-chat');f.enable(f.connectors);f.handler(()=>({code:0,data:{has_more:false,items:[{message_id:'om_other',chat_id:'oc_other',create_time:String(f.now+1),msg_type:'text',body:{content:'{"text":"PRIVATE_OTHER_CHAT"}'}}]}}));await f.connectors.tick()
  assert.equal(f.connectors.records.size,0);assert.equal(f.connectors.snapshot().items[0].state,'error');assert.doesNotMatch(readFileSync(join(f.store.root,'hub/events.jsonl'),'utf8'),/PRIVATE_OTHER_CHAT/)
})

test('a credential removed during a request prevents accepting its stale response; restoring it can recover', async t => {
  const f=await fixture(t);f.enable(f.connectors);let release,entered;const ready=new Promise(r=>release=r),started=new Promise(r=>entered=r)
  f.handler(async()=>{entered();await ready;return {value:[mail('m1')],'@odata.deltaLink':f.origin+'/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next'}})
  const polling=f.connectors.tick();await started;writeFileSync(f.credentialFile,'unavailable',{mode:0o600});release();await polling;assert.equal(f.connectors.records.size,0)
  writeFileSync(f.credentialFile,JSON.stringify({accountId:'account-1',token:f.token}),{mode:0o600});await f.connectors.tick();assert.equal(f.connectors.records.size,1)
})

test('SIGKILL after durable cursor write but before ready status resumes that cursor, with no record duplication', async t => {
  const f=await fixture(t);f.enable(f.connectors);f.connectors.close();f.handler(()=>({value:[mail('m1')],'@odata.deltaLink':f.origin+'/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=durable-before-ready'}))
  const {fork}=await import('node:child_process'),entry=join(f.root,'crash.mjs')
  writeFileSync(entry,`import {ProjectStore} from ${JSON.stringify(new URL('../lib/store.js',import.meta.url).href)};import {Connectors} from ${JSON.stringify(new URL('../lib/connectors.js',import.meta.url).href)};const store=new ProjectStore(process.argv[2],{warn(){}});store.load();const c=new Connectors(store,JSON.parse(process.argv[3]));const checkpoint=c.checkpoint.bind(c);c.checkpoint=(...args)=>{checkpoint(...args);process.kill(process.pid,'SIGKILL')};await c.tick();process.exit(2);`)
  const child=fork(entry,[f.store.root,JSON.stringify({...f.options,configs:f.configs})],{stdio:'ignore',execArgv:[],env:{PATH:process.env.PATH}})
  const [code,signal]=await once(child,'exit');assert.equal(code,null);assert.equal(signal,'SIGKILL')
  const loaded=new ProjectStore(f.store.root,{warn(){}});loaded.load();const c=new Connectors(loaded,f.options);t.after(()=>c.close());const count=f.calls.length;await c.tick()
  assert.ok(f.calls.slice(count).some(r=>r.url.includes('deltatoken=durable-before-ready')));assert.equal(loaded.get('hub').events.filter(e=>e.type==='connector.record').length,1)
})

test('Feishu rich text reuses Mira text/title extraction without storing attachment keys or link metadata', async t => {
  const f=await fixture(t,'feishu-chat');f.enable(f.connectors)
  f.handler(()=>({code:0,data:{has_more:false,items:[{message_id:'om_post',chat_id:'oc_fixture',create_time:String(f.now+1),msg_type:'post',sender:{id:'ou_person'},body:{content:JSON.stringify({zh_cn:{title:'发布安排',content:[[{tag:'text',text:'RICH_POST 正文'},{tag:'a',text:'查看详情',href:'https://example.invalid/private-link-metadata'},{tag:'img',image_key:'private-image-key'}]]}})}}]}}))
  await f.connectors.tick();const record=[...f.connectors.records.values()][0];assert.match(record.text,/发布安排/);assert.match(record.text,/RICH_POST/);assert.match(record.text,/查看详情/);assert.doesNotMatch(record.text,/private-image-key|private-link-metadata/)
})
