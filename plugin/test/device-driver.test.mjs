import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../lib/store.js'
import { Driver } from '../lib/driver.js'

function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'mira-device-driver-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  const store=new ProjectStore(root,{warn(){}});store.load();const p=store.get(store.createProject({name:'设备停止边界'}).projectId)
  store.append(p.id,{type:'message.posted',messageId:'m_input',text:'fixture',author:{kind:'human',id:'owner'},to:['coordinator'],trust:'principal'})
  const driver=new Driver({logger:{warn(){}},sessions:{async flush(){}}},store,x=>x)
  let turns=0
  const agent={id:'session-fixture',session:{id:'session-fixture'},followup(){turns++},async whenIdle(){Object.assign(driver.turns.get(this.id),{readThrough:p.seq,platform:true,replied:true})}}
  driver.ensureAgent=async()=>({agent,continuity:false});driver.registerScoped=()=>{}
  return {store,p,driver,turns:()=>turns,slot:{wokenThrough:0,again:false}}
}
test('unknown old device execution blocks a replacement turn before model input',async t=>{
  const f=setup(t);f.driver.devices={async assertStopped(){throw new Error('device stop is unproven')}}
  await f.driver.run(f.p.id,'coordinator',f.slot)
  assert.equal(f.turns(),0);assert.equal(f.p.cursors.get('coordinator')??0,0)
  assert.ok(f.p.events.some(e=>e.type==='turn.failed'))
})
test('device stop failure after model completion prevents inbox acknowledgement',async t=>{
  const f=setup(t);let count=0;f.driver.devices={async assertStopped(){if(++count>1)throw new Error('device is still running')}}
  await f.driver.run(f.p.id,'coordinator',f.slot)
  assert.equal(f.turns(),1);assert.equal(count,2)
  assert.equal(f.p.cursors.get('coordinator')??0,0);assert.ok(!f.p.events.some(e=>e.type==='turn.ended'))
})
