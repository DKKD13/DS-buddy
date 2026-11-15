import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { getEventListeners } from 'node:events'
import { registerRoutes } from '../lib/http.js'

let client
runInNewContext(readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{
 window:{__ModuleLoader__:{load(definition){client=definition.factory(()=>({}))}}},AbortController,setTimeout,clearTimeout,URL,
})
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(predicate){for(let i=0;i<300;i++){if(predicate())return;await sleep(5)}throw Error('snapshot feed did not settle')}
class Channels{
 static live=new Set();static messages=[]
 constructor(name){this.name=name;Channels.live.add(this)}
 postMessage(message){Channels.messages.push(message);for(const peer of Channels.live)if(peer!==this&&peer.name===this.name&&!peer.drop)queueMicrotask(()=>peer.onmessage?.({data:message}))}
 close(){Channels.live.delete(this)}
}
class Locks{
 constructor(){this.queue=[];this.busy=false}
 request(name,{signal},callback){return new Promise((resolve,reject)=>{
  const entry={signal,callback,resolve,reject};this.queue.push(entry)
  const aborted=()=>{const index=this.queue.indexOf(entry);if(index>=0){this.queue.splice(index,1);reject(Error('aborted'))}}
  signal.addEventListener('abort',aborted,{once:true});entry.clean=()=>signal.removeEventListener('abort',aborted);this.next()
 })}
 next(){if(this.busy)return;const next=this.queue.shift();if(!next)return;next.clean();if(next.signal.aborted){next.reject(Error('aborted'));this.next();return}
  this.busy=true;Promise.resolve().then(()=>next.callback({name:'fixture'})).then(next.resolve,next.reject).finally(()=>{this.busy=false;this.next()})
 }
}
function server(){
 const value={rev:10,calls:[],waiting:new Set(),maximum:0}
 value.fetcher=async(url,options)=>{
  const q=new URL(url,'http://fixture/').searchParams;assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');value.calls.push({wait:q.get('wait'),signal:options.signal})
  if(q.get('wait')==='1'&&Number(q.get('since'))===value.rev)await new Promise((resolve,reject)=>{
   const done=()=>{value.waiting.delete(done);options.signal.removeEventListener('abort',aborted);resolve()},aborted=()=>{value.waiting.delete(done);reject(Error('aborted'))}
   value.waiting.add(done);value.maximum=Math.max(value.maximum,value.waiting.size);options.signal.addEventListener('abort',aborted,{once:true})
  })
  const rev=value.rev;return{ok:true,json:async()=>({rev})}
 }
 value.change=rev=>{value.rev=rev;for(const done of [...value.waiting])done()}
 return value
}

test('multiple views and tabs share one wait; closing the leader transfers ownership without losing updates',async t=>{
 const host=server(),locks=new Locks(),options={fetcher:host.fetcher,locks,Channel:Channels,channelName:'fixture-shared',fallbackMs:30,retryMs:10}
 const first=client.createRevisionFeed(options),second=client.createRevisionFeed(options);t.after(()=>{first.dispose();second.dispose()})
 const offA=first.subscribe(()=>{}),offB=first.subscribe(()=>{}),offC=second.subscribe(()=>{})
 await until(()=>host.waiting.size===1&&second.getSnapshot().rev===10)
 host.change(11);await until(()=>first.getSnapshot().rev===11&&second.getSnapshot().rev===11)
 assert.equal(host.maximum,1);assert.ok(Channels.messages.every(m=>Object.keys(m).join(',')==='rev'))
 offA();await until(()=>host.waiting.size===1);assert.equal(locks.busy,true,'one remaining view keeps the feed alive')
 offB();await until(()=>host.waiting.size===1&&locks.busy)
 host.change(12);await until(()=>second.getSnapshot().rev===12)
 offC();await until(()=>host.waiting.size===0&&!locks.busy)
 assert.ok(host.calls.some(c=>c.signal.aborted));assert.equal(Channels.live.size,0)
})

test('a suspended leader or lost broadcast cannot freeze a follower; no coordination uses only short reads',async t=>{
 const host=server(),locks=new Locks(),options={fetcher:host.fetcher,locks,Channel:Channels,channelName:'fixture-suspended',fallbackMs:10,retryMs:10}
 const leader=client.createRevisionFeed(options),follower=client.createRevisionFeed(options);t.after(()=>{leader.dispose();follower.dispose()})
 leader.subscribe(()=>{});follower.subscribe(()=>{});await until(()=>host.waiting.size===1&&follower.getSnapshot().rev===10)
 for(const channel of Channels.live)channel.drop=true
 // Leave the leader's request stuck; only a follower's own authenticated read can see this.
 host.rev=3;await until(()=>follower.getSnapshot().rev===3)
 assert.equal(host.maximum,1);leader.dispose();follower.dispose()
 const plain=client.createRevisionFeed({fetcher:host.fetcher,retryMs:10});t.after(()=>plain.dispose());const before=host.calls.length;plain.subscribe(()=>{});await until(()=>plain.getSnapshot().rev===3)
 assert.ok(host.calls.slice(before).every(call=>call.wait==='0'))
})

test('failed reads recover, and late responses after disposal cannot change a new feed generation',async t=>{
 let attempts=0
 const feed=client.createRevisionFeed({retryMs:10,fetcher:async()=>{if(++attempts===1)throw Error('offline');return{ok:true,json:async()=>({rev:5})}}});t.after(()=>feed.dispose())
 const errors=[];feed.subscribe(()=>errors.push(feed.getSnapshot().error));await until(()=>feed.getSnapshot().rev===5)
 assert.ok(errors.includes('offline'));assert.equal(feed.getSnapshot().error,null);feed.dispose()
 let resolveOld;const late=client.createRevisionFeed({fetcher:()=>new Promise(resolve=>{resolveOld=resolve})});late.subscribe(()=>{});late.dispose();resolveOld({ok:true,json:async()=>({rev:999})});await sleep(5)
 assert.equal(late.getSnapshot().rev,-1)
})

test('browser policy denial of locks or broadcasts falls back without failing the data connection',async t=>{
 const host=server(),deniedLocks=client.createRevisionFeed({fetcher:host.fetcher,locks:{request(){throw Error('policy denied')}},Channel:Channels,channelName:'fixture-policy-denied'})
 t.after(()=>deniedLocks.dispose());assert.doesNotThrow(()=>deniedLocks.subscribe(()=>{}));await until(()=>deniedLocks.getSnapshot().rev===10)
 assert.equal(deniedLocks.getSnapshot().error,null);assert.ok(host.calls.every(call=>call.wait==='0'));deniedLocks.dispose()
 class DeniedBroadcast extends Channels{postMessage(){throw Error('broadcast unavailable')}}
 const broadcast=client.createRevisionFeed({fetcher:host.fetcher,locks:new Locks(),Channel:DeniedBroadcast,channelName:'fixture-broadcast-denied'});t.after(()=>broadcast.dispose())
 broadcast.subscribe(()=>{});await until(()=>broadcast.getSnapshot().rev===10);assert.equal(broadcast.getSnapshot().error,null)
})

test('revision route is content-free, wakes for both stores, and removes cancelled waiter listeners',async()=>{
 const routes=new Map(),makeStore=rev=>({rev,listeners:new Set(),onChange(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener)},bump(){this.rev++;for(const f of this.listeners)f()}})
 const store=makeStore(4),hubStore=makeStore(3),dispose=registerRoutes({connection:{fetch:{register(definition){routes.set(definition.path,definition.fetch);return async()=>routes.delete(definition.path)}}}},{store,driver:{},hub:{store:hubStore}})
 const revision=routes.get('/api/mira-projects/revision'),read=async query=>(await revision(new Request('http://fixture/api/mira-projects/revision?'+query))).json()
 assert.deepEqual(await read(''),{rev:7})
 const pending=read('since=7&wait=1');hubStore.bump();assert.deepEqual(await pending,{rev:8})
 const abort=new AbortController(),request=new Request('http://fixture/api/mira-projects/revision?since=8&wait=1',{signal:abort.signal}),cancelled=revision(request)
 assert.equal(getEventListeners(request.signal,'abort').length,1);abort.abort();await cancelled;assert.equal(getEventListeners(request.signal,'abort').length,0)
 const last=read('since=8&wait=1');store.bump();assert.deepEqual(await last,{rev:9});await dispose();assert.equal(routes.size,0);assert.equal(store.listeners.size,0);assert.equal(hubStore.listeners.size,0)
})
