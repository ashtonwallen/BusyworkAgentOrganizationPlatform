import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,Worker,one} from '../packages/runtime/src/index.js';
import {ProviderFailure} from '../packages/providers/src/index.js';
import {queueCallReconciliations,reconciliationCase,reconcileLocalCall} from '../packages/runtime/src/call-reconciliation.js';

it('queues one investigation while paused and reconciles frozen free pricing without fabricating usage',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));
  await db.query("UPDATE company SET ceo_model_id='mock-worker' WHERE id=1");
  const ceo=await db.transaction(tx=>new Organization(service).ensureCEO(tx));
  const model=service.models.find(m=>m.id==='mock-worker')!;model.provider='lmstudio';
  model.adapter.generate=async()=>{throw new ProviderFailure('Transport ended',false);};
  const source=await service.createTask({objective:'Internal analysis',employeeId:ceo.id,modelId:model.id});
  await service.setStatus('RUNNING');await new Worker(service).runNext();await service.setStatus('PAUSED');
  const call=await one(db,"SELECT * FROM calls WHERE status='UNCERTAIN'");
  await queueCallReconciliations(service);await queueCallReconciliations(service);
  const jobs=(await db.query<any>("SELECT payload FROM events WHERE type='call.reconciliation_queued'")).rows;
  expect(jobs).toHaveLength(1);const taskId=jobs[0].payload.taskId;
  expect((await reconciliationCase(db,taskId))?.id).toBe(call.id);
  const delegated=await service.createTask({objective:'Investigate delegated accounting case',parentId:taskId,tokenBudget:1000});
  expect((await reconciliationCase(db,delegated.id))?.id).toBe(call.id);
  expect((await service.snapshot()).reconciliationTasks[0].task_id).toBe(taskId);
  // Later model configuration is not evidence about an earlier call's frozen price.
  model.inputPerMillionUsd='10';
  await db.transaction(tx=>reconcileLocalCall(tx,taskId,call.id,ceo.id));
  await db.transaction(tx=>reconcileLocalCall(tx,taskId,call.id,ceo.id));
  expect(await one(db,'SELECT status,settled,input_tokens,output_tokens FROM calls WHERE id=$1',[call.id])).toEqual({status:'RECONCILED',settled:'0',input_tokens:null,output_tokens:null});
  expect((await db.query('SELECT * FROM ledger')).rows).toHaveLength(1);
  expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[source.id])).status).toBe('PLAN_PENDING');
  expect((await one(db,'SELECT status FROM company')).status).toBe('PAUSED');
  await expect(db.transaction(tx=>reconcileLocalCall(tx,'unrelated-task',call.id,ceo.id))).rejects.toThrow('not assigned');
  await db.query("UPDATE calls SET status='UNCERTAIN',is_live=true WHERE id=$1",[call.id]);
  await expect(db.transaction(tx=>reconcileLocalCall(tx,taskId,call.id,ceo.id))).rejects.toThrow('provider evidence');
 }finally{await db.close();}
});
