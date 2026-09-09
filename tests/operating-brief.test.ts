import {it,expect} from 'vitest';
import {openDatabase,HiveService,Organization,createModels,one} from '../packages/runtime/src/index.js';
import {operatingBrief,delegatedWork} from '../packages/runtime/src/operating-brief.js';
it('gives the actual CEO bounded cross-department results and full-history counts',async()=>{
  const db=await openDatabase();
  try{
    const service=new HiveService(db,createModels({}));
    await db.query("UPDATE company SET ceo_model_id='mock-worker',ceo_review_model_id='mock-reviewer' WHERE id=1");
    const ceo=await db.transaction(tx=>new Organization(service).ensureCEO(tx));
    for(let i=0;i<5;i++)await service.createTask({objective:`Blocked departmental work ${i}`});
    await db.query("UPDATE tasks SET status='BLOCKED_BUDGET',error='A bounded allocation needs review'");
    const request=await service.createRequest({title:'Account access',details:'Need owner input'});
    await service.resolveRequest(request.id,'DECLINED','Use the existing tool instead.',0);
    const action=await service.createAction({actionType:'PUBLISH',target:'example.invalid',payload:{},rationale:'Offline fixture',maxCostUsd:'0',expiresAt:new Date(Date.now()+60000).toISOString()});
    const proposal=await one(db,'SELECT action_hash FROM actions WHERE id=$1',[action.id]);
    await service.approveAction(action.id,proposal.action_hash,'REJECT','Do not publish this version.');
    const brief=await operatingBrief(db,ceo.id);
    expect(brief?.blockedWork).toHaveLength(3);
    expect(brief?.taskCounts).toContainEqual({status:'BLOCKED_BUDGET',count:5});
    expect(brief?.recentOutsideActions[0]).toMatchObject({id:action.id,status:'REJECTED',owner_rationale:'Do not publish this version.'});
    expect(brief?.recentOwnerResponses[0]).toMatchObject({id:request.id,status:'DECLINED',response:'Use the existing tool instead.'});
    expect(await operatingBrief(db,null)).toBeUndefined();
    expect(await operatingBrief(db,'not-the-ceo')).toBeUndefined();
  }finally{await db.close();}
});

it('keeps a supervisors delegated outcomes visible beyond unrelated recent work',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));
  const ceo=await db.transaction(tx=>new Organization(service).ensureCEO(tx));
  const parent=await service.createTask({objective:'Coordinate evaluation',employeeId:ceo.id,tokenBudget:200000,ttlMinutes:120});
  const child=await service.createTask({objective:'Evaluate supporting evidence',parentId:parent.id,tokenBudget:1000,ttlMinutes:60});
  await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[child.id,JSON.stringify({summary:'Buyer evidence is still missing.',evidence:[{kind:'HYPOTHESIS',observation:'Untested demand'}]})]);
  for(let i=0;i<6;i++)await service.createTask({objective:'Unrelated recent task '+i});
  const results=await delegatedWork(db,ceo.id);
  expect(results).toHaveLength(1);expect(results[0]).toMatchObject({id:child.id,parent_id:parent.id,result:'Buyer evidence is still missing.'});
  expect(results[0].evidence).toContain('HYPOTHESIS');
  expect(await delegatedWork(db,'unrelated-supervisor')).toEqual([]);
 }finally{await db.close();}
});

it('hands off submitted memos with explicit truncation and actual operation status',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));
  const ceo=await db.transaction(tx=>new Organization(service).ensureCEO(tx));
  const parent=await service.createTask({objective:'Coordinate audit',employeeId:ceo.id,tokenBudget:200000,ttlMinutes:120});
  const child=await service.createTask({objective:'Audit fulfillment limits',parentId:parent.id,tokenBudget:1000,ttlMinutes:60});
  const artifact={summary:'Audit complete.',deliverables:[{filename:'full.md',content:'a'.repeat(2100)}],operations:[
   {type:'REQUEST_OWNER',instructions:'Not a submitted document'},
   {type:'WORKSPACE_WRITE',target:'private/audit.md',instructions:'Material defect: no input volume limit.'},
   {type:'WRITE_DOCUMENT',target:'audit/v2.md',instructions:'b'.repeat(3100)},
   {type:'WORKSPACE_WRITE',target:'shared/omitted.md',instructions:'Additional memo'}]};
  await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[child.id,JSON.stringify(artifact)]);
  await db.query("INSERT INTO operations(id,task_id,operation_index,status,result) VALUES('memo-written',$1,1,'APPLIED','{}'),('memo-blocked',$1,2,'BLOCKED','{}')",[child.id]);
  const [result]=await delegatedWork(db,ceo.id);
  expect(result.submission.proposedDocuments).toEqual([
   {type:'WORKSPACE_WRITE',target:'private/audit.md',operationStatus:'APPLIED',content:{text:'Material defect: no input volume limit.',complete:true}},
   {type:'WRITE_DOCUMENT',target:'audit/v2.md',operationStatus:'BLOCKED',content:{text:'b'.repeat(3000),complete:false}}]);
  expect(result.submission.omittedDocuments).toBe(1);
  expect(result.submission.deliverables[0].content).toEqual({text:'a'.repeat(2000),complete:false});
  expect(JSON.stringify(result)).not.toContain('Not a submitted document');
  await db.query('DELETE FROM operations WHERE task_id=$1',[child.id]);
  expect((await delegatedWork(db,ceo.id))[0].submission.proposedDocuments[0].operationStatus).toBe('NOT_APPLIED');
  expect(await delegatedWork(db,'unrelated-supervisor')).toEqual([]);
 }finally{await db.close();}
});
