import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,one,writeDocument} from '../packages/runtime/src/index.js';
import {createMission,activateMission,currentMission} from '../packages/runtime/src/missions.js';
import {requestMissionCompletion,confirmMissionCompletion,missionAdmission,checkMissionStall,missionExposure} from '../packages/runtime/src/mission-lifecycle.js';
import {ToolGateway,ToolRegistry} from '../packages/runtime/src/tools.js';

async function fixture(){
 const db=await openDatabase(),service=new HiveService(db,createModels({})),org=new Organization(service);
 const {id}=await createMission(service,{template:'research',title:'Research',objective:'Compare sources',definitionOfDone:['Deliver the report'],kind:'FINITE',budgetUsd:'5',capabilities:['core','documents','research'],deliverable:'report.md',stallCycles:2});
 await activateMission(service,id);await db.query("UPDATE company SET ceo_model_id='mock-worker'");
 await service.setStatus('RUNNING');await org.tick();const task=await one(db,'SELECT * FROM tasks');return {db,service,org,task,id};
}
it('requires real condition evidence and an exact deliverable, then owner confirmation, before completion',async()=>{
 const {db,service,org,task,id}=await fixture();try{
  await db.transaction(tx=>writeDocument(tx,{path:'report.md',title:'Report',content:'Recorded findings and limitations.',expectedVersion:0},task.employee_id,task.id));
  const input={conditions:[{conditionIndex:0,evidence:[{kind:'DOCUMENT',id:'report.md',version:1}]}],deliverable:{path:'report.md',version:1}};
  await db.query("UPDATE employees SET role='Researcher' WHERE id=$1",[task.employee_id]);
  await expect(db.transaction(tx=>requestMissionCompletion(tx,task,input))).rejects.toThrow('Only the CEO');
  await db.query("UPDATE employees SET role='CEO' WHERE id=$1",[task.employee_id]);
  await expect(db.transaction(tx=>requestMissionCompletion(tx,task,{...input,conditions:[]}))).rejects.toThrow('every completion condition');
  await expect(db.transaction(tx=>requestMissionCompletion(tx,task,{...input,deliverable:{path:'missing.md',version:1}}))).rejects.toThrow();
  const proposal=await db.transaction(tx=>requestMissionCompletion(tx,task,input));
  expect((await currentMission(db))?.status).toBe('COMPLETING');
  const action=await service.createAction({actionType:'READ_PUBLIC_PAGE',target:'https://example.com',payload:{},rationale:'Fixture',maxCostUsd:'0',expiresAt:new Date(Date.now()+3600000).toISOString(),taskId:task.id});
  const record=await one(db,'SELECT * FROM actions WHERE id=$1',[action.id]);await service.approveAction(action.id,record.action_hash,'APPROVE','Fixture approval');
  let executions=0;
  const gateway=new ToolGateway(service,new ToolRegistry().register({name:'READ_PUBLIC_PAGE',version:1,description:'Fixture',approvalCategory:'research',maximumCostUsd:'0',execute:async()=>{executions++;return {result:{text:'Fixture'},actualCostUsd:'0'};}}));
  await expect(gateway.execute(action.id)).rejects.toThrow('Mission is not active');expect(executions).toBe(0);
  await org.tick();expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(1);
  await expect(confirmMissionCompletion(service,proposal.id,'0'.repeat(64),true)).rejects.toThrow('changed');
  await confirmMissionCompletion(service,proposal.id,proposal.hash,true);
  expect((await one(db,'SELECT status FROM missions WHERE id=$1',[id])).status).toBe('COMPLETED');
  expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[task.id])).status).toBe('CANCELLED');
 }finally{await db.close();}
});
it('escalates once after stagnant finite cycles and uses recorded progress rather than model assertions',async()=>{
 const {db,org,id}=await fixture();try{
  for(let cycle=0;cycle<3;cycle++){
   await db.query("UPDATE tasks SET status='COMPLETED',operations_applied=true,artifact=$1 WHERE mission_id=$2",[JSON.stringify({summary:'I made great progress'}),id]);
   await org.tick();
  }
  await org.tick();
  expect((await db.query('SELECT id FROM tasks WHERE mission_id=$1',[id])).rows).toHaveLength(3);
  expect((await one(db,'SELECT pause_reason FROM missions WHERE id=$1',[id])).pause_reason).toContain('No new recorded');
  expect((await db.query('SELECT id FROM owner_requests WHERE mission_id=$1',[id])).rows).toHaveLength(1);
 }finally{await db.close();}
});
it('includes uncertain holds in mission admission without releasing or inventing charges',async()=>{
 const {db,task,id}=await fixture();try{
  await db.query("INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,token_reserved,budget_day) VALUES('uncertain',$1,'WORK',1,'mock-worker','mock',false,'UNCERTAIN',4000000,1000,current_date)",[task.id]);
  expect((await missionExposure(db,id)).held).toBe(4000000n);
  const reason=await db.transaction(tx=>missionAdmission(tx,id,2000000n));expect(reason).toContain('budget');
  expect((await one(db,"SELECT status,reserved FROM calls WHERE id='uncertain'")).reserved).toBe('4000000');
  expect((await db.query('SELECT id FROM ledger')).rows).toHaveLength(0);
 }finally{await db.close();}
});
it('rejects aggregate delegated allocations beyond remaining parent money or tokens',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));
  const parent=await service.createTask({objective:'Root',modelId:'mock-worker',budgetUsd:'2',tokenBudget:10000,ttlMinutes:120});
  const child={objective:'Child',modelId:'mock-worker',parentId:parent.id,budgetUsd:'1',tokenBudget:6000,ttlMinutes:60};
  await service.createTask(child);await expect(service.createTask(child)).rejects.toThrow('remaining money or tokens');
  await expect(service.createTask({...child,budgetUsd:'2',tokenBudget:1000})).rejects.toThrow('remaining money or tokens');
 }finally{await db.close();}
});
