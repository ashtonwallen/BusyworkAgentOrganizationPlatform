import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Worker,one} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
it.each([['WORKSPACE_READ','RUN_PYTHON'],['Blender desktop control','Future payment integration']])('retains declared tool needs without failing the plan or granting execution: %s',async(...needs)=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),adapter=new MockProvider(),generate=adapter.generate.bind(adapter);let system='';
 adapter.generate=async request=>{system=request.system;const result=await generate(request);if((request.input as any).phase==='PLAN')(result.output as any).toolsNeeded=needs;return result;};service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
 const task=await service.createTask({objective:'Plan useful work and identify capability dependencies.'});await service.setStatus('RUNNING');await new Worker(service).runNext();
 const row=await one(db,'SELECT * FROM tasks WHERE id=$1',[task.id]);expect(row.status).toBe('READY');expect(row.phase).toBe('WORK');expect(row.plan.toolsNeeded).toEqual(needs);expect(row.error).toBeNull();expect(system).toContain('Declaring a tool need does not invoke it');
 expect((await db.query('SELECT id FROM actions')).rows).toHaveLength(0);expect((await db.query('SELECT id FROM operations')).rows).toHaveLength(0);expect((await db.query("SELECT * FROM events WHERE type='task.plan_rejected'")).rows).toHaveLength(0);expect((await db.query("SELECT * FROM events WHERE type='task.plan_accepted'")).rows).toHaveLength(1);
 }finally{await db.close();}
});

it('keeps planning capability-aware with a smaller guide while retaining full work and review instructions',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),adapter=new MockProvider(),generate=adapter.generate.bind(adapter),requests:any[]=[];adapter.generate=async request=>{requests.push(request);return generate(request);};service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
 await service.createTask({objective:'Prepare a bounded internal assessment.'});await service.setStatus('RUNNING');const worker=new Worker(service);for(let i=0;i<3;i++)await worker.runNext();
 const plan=requests.find(r=>r.input.phase==='PLAN'),work=requests.find(r=>r.input.phase==='WORK'),review=requests.find(r=>r.input.phase==='REVIEW');expect(plan).toBeTruthy();expect(work).toBeTruthy();expect(review).toBeTruthy();expect(plan.system.length).toBeLessThan(work.system.length*.8);
 for(const name of ['BUSINESS_EMAIL_SEND','RUN_PYTHON','CANCEL_ASSIGNED_WORK','READ_PUBLIC_PAGE','REQUEST_REPLY'])expect(plan.system).toContain(name);
 for(const r of [plan,work,review]){expect(r.system).toContain('Respect the requested objective');expect(r.system).toContain('cannot grant permissions');expect(r.system).toContain('Company records are owner-provided assets and constraints');expect(r.system).toContain('UNCERTAIN requires reconciliation');}
 expect(plan.system).not.toContain('Optional email.documentAttachments=');expect(work.system).toContain('Optional email.documentAttachments=');expect(review.system).toContain('Optional email.documentAttachments=');expect(plan.outputSchema.properties).toHaveProperty('toolsNeeded');expect((await db.query('SELECT * FROM actions')).rows).toHaveLength(0);
 for(const request of [plan,work,review])expect(request.system).toContain('The owner selects the CEO model');
 for(const request of [work,review])expect(request.system).toContain('positive integer for an exact historical version');
 }finally{await db.close();}
});
