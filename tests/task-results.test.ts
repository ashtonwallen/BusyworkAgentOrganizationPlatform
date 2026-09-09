import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,Worker} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
import {readTaskResult} from '../packages/runtime/src/task-results.js';

it('reads submitted results in bounded pages with stable hashes and no provider prompts',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));
  const ceo=await db.transaction(tx=>new Organization(service).ensureCEO(tx));
  const parent=await service.createTask({objective:'Commission audit',employeeId:ceo.id,tokenBudget:200000,ttlMinutes:120});
  const child=await service.createTask({objective:'Audit',parentId:parent.id,tokenBudget:1000,ttlMinutes:60});
  await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[child.id,JSON.stringify({summary:'Finding',deliverables:[{filename:'memo.md',content:'a'.repeat(6000)}],operations:[{type:'WORKSPACE_WRITE',instructions:'The submitted memo'}]})]);
  const summary=await readTaskResult(db,ceo.id,child.id);
  expect(JSON.parse(summary.content).deliverableCount).toBe(1);
  const first=await readTaskResult(db,ceo.id,child.id,'deliverable');
  const last=await readTaskResult(db,ceo.id,child.id,'deliverable',0,first.nextOffset!);
  expect(first.content.length).toBe(4000);expect(first.complete).toBe(false);
  expect(last.resultHash).toBe(first.resultHash);expect(last.nextOffset).toBeNull();
  expect(JSON.parse(first.content+last.content).content).toBe('a'.repeat(6000));
  expect(JSON.parse((await readTaskResult(db,ceo.id,child.id,'operation')).content).execution.status).toBe('NOT_APPLIED');
  await expect(readTaskResult(db,'unrelated',child.id)).rejects.toThrow('unavailable');
  await expect(readTaskResult(db,ceo.id,child.id,'deliverable',9)).rejects.toThrow('out of range');
  await expect(readTaskResult(db,ceo.id,child.id,'deliverable',0,99999)).rejects.toThrow('out of range');
 }finally{await db.close();}
});

it('delivers an internal result read through reviewed operations exactly once',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({})),org=new Organization(service);
  const ceo=await db.transaction(tx=>org.ensureCEO(tx));
  const prior=await service.createTask({objective:'Prior audit',employeeId:ceo.id});
  await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[prior.id,JSON.stringify({summary:'A source packet needs an explicit size limit.'})]);
  const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);
  adapter.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK'){
   (result.output as any).operations=[{type:'READ_TASK_RESULT',target:prior.id,title:'Inspect prior audit',instructions:'Read submitted result.',budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];
  }return result;};
  service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
  const read=await service.createTask({objective:'Inspect prior audit',employeeId:ceo.id,modelId:'mock-worker'});
  await service.setStatus('RUNNING');const worker=new Worker(service);for(let n=0;n<3;n++)await worker.runNext();
  await org.applyOperations(read.id);await org.applyOperations(read.id);
  const messages=(await db.query<any>('SELECT body FROM messages WHERE task_id=$1',[read.id])).rows;
  expect(messages).toHaveLength(1);expect(JSON.parse(messages[0].body).content).toContain('explicit size limit');
  expect((await db.query('SELECT * FROM actions')).rows).toHaveLength(0);
 }finally{await db.close();}
});
