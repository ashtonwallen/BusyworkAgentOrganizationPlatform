import {MockProvider} from '../packages/providers/src/index.js';
import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,Worker} from '../packages/runtime/src/index.js';
import {cancelAssignedWork} from '../packages/runtime/src/task-cancellation.js';
it('cancels scoped work with one notice while preserving completed history and refusing unrelated/source work',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));const source=await service.createTask({objective:'Replan',employeeId:ceo.id}),target=await service.createTask({objective:'Old plan',employeeId:ceo.id}),child=await service.createTask({objective:'Completed child',employeeId:ceo.id}),unrelated=await service.createTask({objective:'Unassigned owner task'});await db.query("UPDATE tasks SET parent_id=$2,status='COMPLETED',operations_applied=true WHERE id=$1",[child.id,target.id]);
 await expect(db.transaction(tx=>cancelAssignedWork(tx,ceo.id,unrelated.id,source.id,'Out of scope'))).rejects.toThrow('Cancel your own');await expect(db.transaction(tx=>cancelAssignedWork(tx,ceo.id,source.id,source.id,'Self'))).rejects.toThrow('source');
 const first=await db.transaction(tx=>cancelAssignedWork(tx,ceo.id,target.id,source.id,'Requirements changed'));expect(first.cancelledTaskIds).toEqual([target.id]);expect((await db.transaction(tx=>cancelAssignedWork(tx,ceo.id,target.id,source.id,'Repeat'))).cancelledTaskIds).toEqual([]);expect((await db.query("SELECT * FROM messages WHERE subject='Assignment cancelled'")).rows).toHaveLength(1);expect((await db.query('SELECT status FROM tasks WHERE id=$1',[child.id])).rows[0]!.status).toBe('COMPLETED');expect((await db.query('SELECT * FROM ledger')).rows).toHaveLength(0);
 }finally{await db.close();}
});

it.each(['owner','agent'])('prevents reviewed but unprocessed work from executing after %s cancellation',async actor=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));const source=await service.createTask({objective:'Replan',employeeId:ceo.id}),target=await service.createTask({objective:'Old reviewed work',employeeId:ceo.id});
 const artifact=(await new MockProvider().generate({input:{phase:'WORK'}} as any)).output as any;artifact.operations=[{type:'WRITE_DOCUMENT',target:'obsolete.md',title:'Obsolete document',instructions:'Do not publish this after cancellation.',expectedVersion:0,budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];
 await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[target.id,JSON.stringify(artifact)]);
 if(actor==='owner')await service.cancelTask(target.id);else await db.transaction(tx=>cancelAssignedWork(tx,ceo.id,target.id,source.id,'Scope changed'));
 await service.setStatus('RUNNING');await org.applyOperations(target.id);expect((await db.query('SELECT status,artifact FROM tasks WHERE id=$1',[target.id])).rows[0]).toMatchObject({status:'CANCELLED',artifact});expect((await db.query("SELECT * FROM documents WHERE path='obsolete.md'")).rows).toHaveLength(0);expect((await db.query('SELECT * FROM operations WHERE task_id=$1',[target.id])).rows).toHaveLength(0);
 const control=await service.createTask({objective:'Valid reviewed work',employeeId:ceo.id});await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[control.id,JSON.stringify(artifact)]);await org.applyOperations(control.id);expect((await db.query("SELECT * FROM documents WHERE path='obsolete.md'")).rows).toHaveLength(1);
 }finally{await db.close();}
});

it('serializes concurrent operation application without duplicate writes or spurious blocked records',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx)),task=await service.createTask({objective:'Persist a reviewed handoff',employeeId:ceo.id});
 const artifact=(await new MockProvider().generate({input:{phase:'WORK'}} as any)).output as any;artifact.operations=[{type:'WRITE_DOCUMENT',target:'handoff.md',title:'Handoff',instructions:'Stable handoff.',expectedVersion:0,budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[task.id,JSON.stringify(artifact)]);await service.setStatus('RUNNING');
 await Promise.all([org.applyOperations(task.id),org.applyOperations(task.id),org.applyOperations(task.id)]);
 expect((await db.query('SELECT status FROM operations WHERE task_id=$1',[task.id])).rows).toEqual([{status:'APPLIED'}]);expect((await db.query("SELECT version FROM documents WHERE path='handoff.md'")).rows).toEqual([{version:1}]);expect((await db.query("SELECT * FROM events WHERE type='operation.blocked'")).rows).toHaveLength(0);expect((await db.query('SELECT operations_applied FROM tasks WHERE id=$1',[task.id])).rows[0]!.operations_applied).toBe(true);
 }finally{await db.close();}
});

it.each(['success','missing-usage','transport-failure'])('retains in-flight accounting without reviving cancelled work: %s',async outcome=>{
 const db=await openDatabase();try{
 const models=createModels({}),service=new HiveService(db,models),adapter=new MockProvider(),generate=adapter.generate.bind(adapter);const model=models.find(m=>m.id==='mock-worker')!;model.inputPerMillionUsd='1';model.outputPerMillionUsd='2';model.adapter=adapter;
 await service.configure({dailyCapUsd:'10',liveCapUsd:'10',capitalAllocationUsd:'10'});await service.setApprovalPolicy({modelCalls:false});
 const task=await service.createTask({objective:'Cancelled while inference is in flight',modelId:model.id});let invoked=0;
 adapter.generate=async request=>{invoked++;expect((await db.query('SELECT status FROM calls WHERE task_id=$1',[task.id])).rows[0]!.status).toBe('DISPATCHED');await service.cancelTask(task.id);if(outcome==='transport-failure')throw new Error('Fixture transport failed after dispatch');const result=await generate(request);result.usage=outcome==='missing-usage'?{}:{inputTokens:10,outputTokens:5};return result;};
 await service.setStatus('RUNNING');const worker=new Worker(service);await worker.runNext();expect(await worker.runNext()).toBe(false);expect(invoked).toBe(1);
 const row=(await db.query('SELECT status,plan,artifact FROM tasks WHERE id=$1',[task.id])).rows[0]!;expect(row).toMatchObject({status:'CANCELLED',plan:null,artifact:null});const call=(await db.query('SELECT status,reserved,settled FROM calls WHERE task_id=$1',[task.id])).rows[0]!;expect(BigInt(call.reserved)).toBeGreaterThan(0n);
 const ledger=(await db.query('SELECT account,amount FROM ledger WHERE task_id=$1',[task.id])).rows;
 if(outcome==='success'){expect(call.status).toBe('SUCCEEDED');expect(BigInt(call.settled)).toBe(20n);expect(ledger).toHaveLength(1);expect(ledger[0]!.account).toBe('TEST');expect(BigInt(ledger[0]!.amount)).toBe(20n);}else{expect(call.status).toBe('UNCERTAIN');expect(call.settled).toBeNull();expect(ledger).toHaveLength(0);}
 expect((await db.query('SELECT * FROM operations WHERE task_id=$1',[task.id])).rows).toHaveLength(0);
 }finally{await db.close();}
});
