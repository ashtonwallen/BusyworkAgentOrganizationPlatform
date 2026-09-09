import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,Worker} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
import {readActionResult} from '../packages/runtime/src/action-results.js';
it('reads original uncertain evidence through agent operations without confirming or retrying the action',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service);const ceo=await db.transaction(tx=>org.ensureCEO(tx));
 const action=await service.createAction({actionType:'OTHER_EXTERNAL',target:'Original fixture',payload:{description:'original'},rationale:'Inspect fixture',maxCostUsd:'0',expiresAt:new Date(Date.now()+3600000).toISOString()});
 await db.query("UPDATE actions SET status='UNCERTAIN',result=$2 WHERE id=$1",[action.id,JSON.stringify({diagnostic:'No confirmed response',evidence:'x'.repeat(6000)})]);
 const first=await readActionResult(db,ceo.id,action.id),last=await readActionResult(db,ceo.id,action.id,first.nextOffset!);expect(last.resultHash).toBe(first.resultHash);expect(JSON.parse(first.content+last.content)).toMatchObject({status:'UNCERTAIN',executionConfirmed:false,storedResultAvailable:true});
 await expect(readActionResult(db,'unknown',action.id)).rejects.toThrow('unavailable');await expect(readActionResult(db,ceo.id,action.id,99999)).rejects.toThrow('out of range');
 const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);adapter.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK')(result.output as any).operations=[{type:'READ_ACTION_RESULT',target:action.id,title:'Inspect original',instructions:'Recover stored evidence only.',budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];return result;};service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
 const task=await service.createTask({objective:'Inspect original record',employeeId:ceo.id,modelId:'mock-worker',tokenBudget:150000});await service.setStatus('RUNNING');const worker=new Worker(service);for(let i=0;i<3;i++)await worker.runNext();await org.applyOperations(task.id);await org.applyOperations(task.id);
 expect((await db.query("SELECT id FROM messages WHERE task_id=$1 AND subject='Stored external action result'",[task.id])).rows).toHaveLength(1);
 expect((await db.query("SELECT id,status FROM actions WHERE action_type='OTHER_EXTERNAL'")).rows).toEqual([{id:action.id,status:'UNCERTAIN'}]);
 expect((await db.query('SELECT id FROM ledger WHERE action_id=$1',[action.id])).rows).toHaveLength(0);
 }finally{await db.close();}
});
