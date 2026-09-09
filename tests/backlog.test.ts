import {internalRead,internalReadContext} from '../packages/runtime/src/internal-reads.js';
import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {openDatabase,HiveService,createModels,Organization,saveBacklog,startBacklog,backlogItems,experimentEconomics} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';
import {MockProvider} from '../packages/providers/src/index.js';

it('persists shared plans, rejects lost updates and cycles, and atomically schedules only completed dependencies',async()=>{
 const db=await openDatabase(),service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));const app=buildApp({service,ownerToken:'backlog-fixture',logger:false});try{
  const first=randomUUID(),second=randomUUID(),input={title:'Prepare checklist',instructions:'Create one checklist.',successCriteria:'Checked usable checklist.',employeeId:ceo.id,expectedVersion:0};
  expect((await app.inject({method:'PUT',url:'/v1/backlog/'+first,payload:input})).statusCode).toBe(401);
  const saved=await app.inject({method:'PUT',url:'/v1/backlog/'+first,payload:input,headers:{authorization:'Bearer backlog-fixture'}});expect(saved.statusCode).toBe(200);
  await db.transaction(tx=>saveBacklog(tx,second,{...input,title:'Package checklist',dependsOn:[first]},'owner'));
  await expect(db.transaction(tx=>saveBacklog(tx,first,input,'owner'))).rejects.toThrow('changed');
  await expect(db.transaction(tx=>saveBacklog(tx,first,{...input,expectedVersion:1,dependsOn:[second]},'owner'))).rejects.toThrow('cycle');
  await expect(db.transaction(tx=>startBacklog(tx,service,second,'owner'))).rejects.toThrow('prerequisite');
  const [a,b]=await Promise.all([db.transaction(tx=>startBacklog(tx,service,first,'owner')),db.transaction(tx=>startBacklog(tx,service,first,'owner'))]);expect(a.id).toBe(b.id);
  expect((await service.snapshot()).backlog).toHaveLength(2);expect((await db.query('SELECT status FROM company')).rows[0]!.status).toBe('PAUSED');
  await db.query("UPDATE tasks SET status='COMPLETED',operations_applied=false WHERE id=$1",[a.id]);await expect(db.transaction(tx=>startBacklog(tx,service,second,'owner'))).rejects.toThrow('prerequisite');
  await db.query('UPDATE tasks SET operations_applied=true WHERE id=$1',[a.id]);const next=await db.transaction(tx=>startBacklog(tx,service,second,'owner'));expect(next.id).not.toBe(a.id);
  await expect(db.transaction(tx=>saveBacklog(tx,first,{...input,expectedVersion:1},'owner'))).rejects.toThrow('Completed work');
  const reopened=new HiveService(db,createModels({}));expect((await reopened.snapshot()).backlog).toHaveLength(2);expect(await backlogItems(db)).toHaveLength(2);expect((await db.query('SELECT * FROM calls')).rows).toHaveLength(0);
 }finally{await app.close();await db.close();}
});

it('applies agent planning once and preserves source bounds when starting shared work',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
  const source=await service.createTask({objective:'Plan useful internal work',employeeId:ceo.id});
  const experiment=await service.createExperiment({title:'Test',hypothesis:'Untested',customer:'Buyer',offer:'Checklist',channel:'Email',price:'20',maxLossUsd:'0',successCriteria:'Payment',killCriteria:'Deadline',deadline:new Date(Date.now()+86400000).toISOString()});
  const artifact=(await new MockProvider().generate({input:{phase:'WORK'}} as any)).output as any;
  artifact.operations=[{type:'PLAN_WORK',target:'new',title:'Plan',instructions:'Record useful work.',backlogItem:{experimentId:experiment.id,title:'Prepare intake',instructions:'Create intake questions.',successCriteria:'A concise intake checklist.',expectedVersion:0},budgetUsd:'0',tokenBudget:60000,modelId:'mock-worker',participants:[],scheduledAt:null}];
  await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[source.id,JSON.stringify(artifact)]);await service.setStatus('RUNNING');await org.applyOperations(source.id);await org.applyOperations(source.id);const plans=await backlogItems(db);expect(plans).toHaveLength(1);
  const row=(await db.query('SELECT * FROM tasks WHERE id=$1',[source.id])).rows[0]!;
  const started=await db.transaction(tx=>startBacklog(tx,service,plans[0]!.id,ceo.id,row));const task=(await db.query('SELECT * FROM tasks WHERE id=$1',[started.id])).rows[0]!;
  expect(task.parent_id).toBe(source.id);expect(task.depth).toBe(row.depth+1);expect(task.expires_at).toEqual(row.expires_at);expect(task.employee_id).toBe(ceo.id);
  expect((await experimentEconomics(db)).taskAttributions.find(t=>t.taskId===started.id)).toMatchObject({experimentId:experiment.id,explicit:true});
 }finally{await db.close();}
});

it('reads full planning context inside work and invalidates changed cached plans',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx)),id=randomUUID(),instructions='Detailed scope. '.repeat(600),input={title:'Fulfillment plan',instructions,successCriteria:'Checked steps.',expectedVersion:0};await db.transaction(tx=>saveBacklog(tx,id,input,ceo.id));
 const read=(target:string,offset=0)=>db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'BACKLOG',target,offset}));const index=await read('*') as any;expect(JSON.parse(index.content)[0]).toMatchObject({id,title:input.title});expect(index.content).not.toContain('Detailed scope');
 const first=await read(id) as any;let content=first.content,offset=first.nextOffset;while(offset!==null){const page=await read(id,offset) as any;expect(page.resultHash).toBe(first.resultHash);content+=page.content;offset=page.nextOffset;}expect(JSON.parse(content).payload.instructions).toBe(instructions.trim());
 const cached={employeeId:ceo.id,request:{type:'BACKLOG',target:id},result:first};await db.transaction(tx=>saveBacklog(tx,id,{...input,successCriteria:'New requirements.',expectedVersion:1},ceo.id));expect((await db.transaction(tx=>internalReadContext(tx,ceo.id,cached)))?.error).toContain('changed');expect((await db.query('SELECT * FROM tasks')).rows).toHaveLength(0);await expect(db.transaction(tx=>internalRead(tx,service,'outsider',{type:'BACKLOG',target:'*'}))).rejects.toThrow('active employee');
 }finally{await db.close();}
});
