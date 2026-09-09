import {afterEach,beforeEach,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {openDatabase,HiveService,Worker,createModels,one} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';
let db:Awaited<ReturnType<typeof openDatabase>>,service:HiveService,worker:Worker;
beforeEach(async()=>{db=await openDatabase();const models=createModels({});const original=models[0].adapter;
  models[0].adapter={providerId:'mock',listModels:()=>original.listModels(),async generate<T>(request){const result=await original.generate<T>(request);if((request.input as {phase?:string}).phase==='WORK')result.output={...result.output,deliverables:[{filename:'offer.md',mediaType:'text/markdown',content:'# Draft offer\nUnvalidated fixture.'}]} as T;return result;}};
  service=new HiveService(db,models);worker=new Worker(service);
});
afterEach(async()=>{await worker.stop();await db.close();});
it('preserves a hashed deliverable and only permits authenticated downloads',async()=>{
  const task=await service.createTask({objective:'Draft an offer file'});await service.setStatus('RUNNING');for(let i=0;i<3;i++)await worker.runNext();
  const artifact=await one(db,'SELECT * FROM task_artifacts WHERE task_id=$1',[task.id]);expect(artifact.sha256).toBe(createHash('sha256').update(artifact.content).digest('hex'));
  await expect(db.query("UPDATE task_artifacts SET content='rewritten' WHERE id=$1",[artifact.id])).rejects.toThrow('append-only');
  const app=buildApp({service,worker,ownerToken:'artifact-fixture-access',logger:false});try{
    expect((await app.inject({url:`/v1/artifacts/${artifact.id}/download`})).statusCode).toBe(401);
    const response=await app.inject({url:`/v1/artifacts/${artifact.id}/download`,headers:{authorization:'Bearer artifact-fixture-access'}});
    expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toContain('application/octet-stream');expect(response.headers['content-disposition']).toBe('attachment; filename="offer.md"');expect(response.body).toBe(artifact.content);
  }finally{await app.close();}
});
it('records actual owner-assisted expenses once and pauses on an approved-bound overrun',async()=>{
  const {id}=await service.createAction({actionType:'PURCHASE',target:'fixture-vendor',payload:{description:'Offline receipt test'},rationale:'Fixture',maxCostUsd:'1',expiresAt:new Date(Date.now()+60000).toISOString()});
  const completion={actualCostUsd:'1.25',externalReference:'receipt-fixture',resultNote:'Confirmed outside expense'};
  await expect(service.recordActionCompletion(id,completion)).rejects.toThrow('approved');const a=await one(db,'SELECT * FROM actions WHERE id=$1',[id]);await service.approveAction(id,a.action_hash,'APPROVE','Fixture');await service.setStatus('RUNNING');
  await service.recordActionCompletion(id,completion);await service.recordActionCompletion(id,completion);expect((await service.snapshot()).company.status).toBe('PAUSED');expect((await db.query('SELECT * FROM ledger WHERE action_id=$1',[id])).rows).toHaveLength(1);
  const decision=await one(db,"SELECT body FROM messages WHERE subject='Approved: PURCHASE'");expect(decision.body).toContain('Permission only');
  await expect(service.recordActionCompletion(id,{...completion,actualCostUsd:'2'})).rejects.toThrow('different');
});

it('records an actual late receipt after approval expiry without renewing authority',async()=>{
 let now=new Date('2030-01-01T00:00:00Z');service=new HiveService(db,createModels({}),()=>now);
 const {id}=await service.createAction({actionType:'PURCHASE',target:'fixture vendor',payload:{},rationale:'Receipt timing fixture',maxCostUsd:'2',expiresAt:'2030-01-01T00:01:00Z'});
 await service.approveAction(id,(await one(db,'SELECT action_hash FROM actions WHERE id=$1',[id])).action_hash,'APPROVE','Fixture');await service.setStatus('RUNNING');
 now=new Date('2030-01-01T00:02:00Z');await service.expire();expect((await one(db,'SELECT status FROM actions WHERE id=$1',[id])).status).toBe('EXPIRED');
 const receipt={actualCostUsd:'1.5',externalReference:'late-fixture',resultNote:'Actual receipt arrived late'};
 await Promise.all([service.recordActionCompletion(id,receipt),service.recordActionCompletion(id,receipt)]);
 const action=await one(db,'SELECT * FROM actions WHERE id=$1',[id]);expect(action.result.varianceReasons).toEqual(['APPROVAL_EXPIRED']);expect(action.result.authorizationStatusAtRecording).toBe('EXPIRED');
 expect((await service.snapshot()).company.status).toBe('PAUSED');expect((await db.query('SELECT * FROM ledger WHERE action_id=$1',[id])).rows).toHaveLength(1);
 await expect(service.recordActionCompletion(id,{...receipt,resultNote:'Different claimed result'})).rejects.toThrow('different');
});
it('records receipts for withdrawn approvals but rejects actions never approved',async()=>{
 const create=()=>service.createAction({actionType:'PURCHASE',target:'fixture vendor',payload:{},rationale:'Withdrawal fixture',maxCostUsd:'2',expiresAt:new Date(Date.now()+60000).toISOString()});
 const approved=await create();await service.approveAction(approved.id,(await one(db,'SELECT action_hash FROM actions WHERE id=$1',[approved.id])).action_hash,'APPROVE','Fixture');
 await service.cancelAction(approved.id);await service.setStatus('RUNNING');
 const receipt={actualCostUsd:'1',externalReference:'withdrawn-fixture',resultNote:'Recorded an actual transaction after withdrawal'};
 await service.recordActionCompletion(approved.id,receipt);
 expect((await one(db,'SELECT result FROM actions WHERE id=$1',[approved.id])).result.varianceReasons).toEqual(['APPROVAL_WITHDRAWN']);expect((await service.snapshot()).company.status).toBe('PAUSED');
 const unapproved=await create();await service.cancelAction(unapproved.id);
 await expect(service.recordActionCompletion(unapproved.id,receipt)).rejects.toThrow('approved proposal');
 expect((await db.query('SELECT * FROM ledger WHERE action_id=$1',[unapproved.id])).rows).toHaveLength(0);
});
