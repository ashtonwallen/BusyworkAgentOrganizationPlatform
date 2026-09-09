import {MockProvider} from '../packages/providers/src/index.js';
import { randomUUID } from 'node:crypto';
import { beforeEach,afterEach,it,expect } from 'vitest';
import { openDatabase,HiveService,Organization,Worker,createModels,one } from '../packages/runtime/src/index.js';
import { buildApp } from '../apps/api/src/app.js';
let db:Awaited<ReturnType<typeof openDatabase>>,service:HiveService,org:Organization;
beforeEach(async()=>{db=await openDatabase();service=new HiveService(db,createModels({}));org=new Organization(service);
  await db.query("UPDATE company SET ceo_model_id='mock-worker',ceo_review_model_id='mock-reviewer' WHERE id=1");});
afterEach(async()=>{await db.close();});
const request=()=>({requestId:randomUUID(),recipientId:'ceo',subject:'What is the next useful test?',body:'Explain what we know and what remains uncertain.',budgetUsd:'0',tokenBudget:200000});
it('queues a CEO reply while paused and posts one reviewed answer through the worker',async()=>{
  const input=request();const result=await org.requestReply(input);
  await org.requestReply(input);
  await expect(org.requestReply({...input,body:'Changed question'})).rejects.toThrow('different content');
  expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(1);
  expect((await db.query('SELECT id FROM employees')).rows).toHaveLength(1);
  const worker=new Worker(service);expect(await worker.runNext()).toBe(false);
  expect((await service.snapshot()).company.status).toBe('PAUSED');
  await service.setStatus('RUNNING');
  for(let i=0;i<3;i++)await worker.runNext();
  await service.setStatus('PAUSED');await org.applyOperations(result.taskId);
  expect((await db.query("SELECT id FROM messages WHERE recipient_id='owner'")).rows).toHaveLength(0);
  await service.setStatus('RUNNING');await org.applyOperations(result.taskId);await org.applyOperations(result.taskId);
  const replies=(await db.query("SELECT * FROM messages WHERE id=$1",[`reply:${result.taskId}`])).rows as any[];
  expect(replies).toHaveLength(1);
  const task=await one(db,'SELECT * FROM tasks WHERE id=$1',[result.taskId]);
  expect(task.review.decision).toBe('PASS');expect(replies[0].body).toBe(task.artifact.summary);
  expect(task.artifact).not.toHaveProperty('customer');
  expect(replies[0].sender_id).toBe(task.employee_id);
});
it('requires owner authentication and rejects killed-company or unknown-recipient requests',async()=>{
  const app=buildApp({service,ownerToken:'fixture-token',logger:false});
  try{
    expect((await app.inject({method:'POST',url:'/v1/conversations',payload:request()})).statusCode).toBe(401);
    await expect(org.requestReply({...request(),recipientId:'missing-agent'})).rejects.toThrow('Record not found');
    await service.setStatus('KILLED');await expect(org.requestReply(request())).rejects.toThrow('killed');
    expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(0);
  }finally{await app.close();}
});
it('paid conversation replies wait for exact call approval',async()=>{
  const model={...createModels({})[0]!,id:'paid-fixture',provider:'openai',live:true,inputPerMillionUsd:'1',outputPerMillionUsd:'1'};
  service.models.push(model);
  await db.query("UPDATE company SET ceo_model_id='paid-fixture',ceo_review_model_id='paid-fixture' WHERE id=1");
  await service.configure({dailyCapUsd:'1',liveCapUsd:'1',capitalAllocationUsd:'200'});
  const {taskId}=await org.requestReply({...request(),budgetUsd:'0.50'});
  await service.setStatus('RUNNING');await new Worker(service).runNext();
  expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[taskId])).status).toBe('BLOCKED_APPROVAL');
  expect((await db.query('SELECT id FROM calls')).rows).toHaveLength(0);
  expect((await one(db,'SELECT action_type FROM actions WHERE task_id=$1',[taskId])).action_type).toBe('MODEL_CALL');
});

it('provides employee-specific history and current assignments to chat replies',async()=>{
 const first=await org.requestReply(request());const employee=(await one(db,'SELECT employee_id FROM tasks WHERE id=$1',[first.taskId])).employee_id;
 await db.query("UPDATE tasks SET status='BLOCKED_APPROVAL',error='Awaiting fixture approval' WHERE id=$1",[first.taskId]);
 const second=await org.requestReply({...request(),recipientId:employee,body:'What are you working on now?'});
 let context:any;const base=new MockProvider();service.models.find(m=>m.id==='mock-worker')!.adapter={providerId:'mock',listModels:()=>base.listModels(),async generate(r){context=r.input;return base.generate(r);}};
 await service.setStatus('RUNNING');await new Worker(service).runNext();
 expect(context.employeeContext).toMatchObject({id:employee,role:'CEO'});expect(context.ownAssignments.some((t:any)=>t.id===first.taskId&&t.status==='BLOCKED_APPROVAL')).toBe(true);
 expect(context.ownerConversation.some((m:any)=>m.body==='What are you working on now?')).toBe(true);
 const app=buildApp({service,ownerToken:'fixture-token',logger:false});try{
 expect((await app.inject({url:'/v1/conversations/ceo'})).statusCode).toBe(401);
 const reply=await app.inject({url:`/v1/conversations/${employee}`,headers:{authorization:'Bearer fixture-token'}});expect(reply.statusCode).toBe(200);expect(reply.json().messages).toHaveLength(2);expect(reply.json().employee.id).toBe(employee);
 }finally{await app.close();}
});

it('prioritizes a chat reply between calls and gives operating work a turn under continued chat',async()=>{
 const work=await service.createTask({objective:'Prepare the ongoing offer.',modelId:'mock-worker',tokenBudget:100000});
 const reply=await org.requestReply(request());await service.setStatus('RUNNING');const worker=new Worker(service);
 for(let i=0;i<3;i++)await worker.runNext();
 expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[reply.taskId])).status).toBe('COMPLETED');
 expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[work.id])).status).toBe('PLAN_PENDING');
 const next=await org.requestReply({...request(),body:'A follow-up question.'});await worker.runNext();
 expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[work.id])).status).toBe('READY');
 expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[next.taskId])).status).toBe('PLAN_PENDING');
 await worker.runNext();expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[next.taskId])).status).toBe('READY');
});
it('does not interrupt an occupied execution slot to answer chat',async()=>{
 const reply=await org.requestReply(request());await service.setStatus('RUNNING');
 await db.query("INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,token_reserved,budget_day) VALUES('inflight-chat-fixture',$1,'PLAN',1,'mock-worker','mock',false,'DISPATCHED',0,1000,CURRENT_DATE)",[reply.taskId]);
 await new Worker(service).runNext();expect((await db.query('SELECT id FROM calls')).rows).toHaveLength(1);
 expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[reply.taskId])).status).toBe('PLAN_PENDING');
});

it('expands a cut-off chat reply on the next attempt while preserving its total context bound',async()=>{
 const adapter=new MockProvider(),generate=adapter.generate.bind(adapter),limits:number[]=[];
 adapter.generate=async r=>{limits.push(r.maxOutputTokens!);const result=await generate(r);if(limits.length===1){result.output='partial' as any;result.truncated=true;}return result;};
 service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
 const {taskId}=await org.requestReply(request());await service.setStatus('RUNNING');const worker=new Worker(service);
 await worker.runNext();await worker.runNext();
 expect(limits).toEqual([3000,6000]);
 const calls=(await db.query<any>('SELECT token_reserved FROM calls WHERE task_id=$1',[taskId])).rows;
 expect(calls.every(c=>Number(c.token_reserved)===33000)).toBe(true);
 expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[taskId])).status).toBe('READY');
});
