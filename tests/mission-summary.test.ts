import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,one,writeDocument} from '../packages/runtime/src/index.js';
import {createMission,activateMission} from '../packages/runtime/src/missions.js';
import {requestMissionCompletion,confirmMissionCompletion} from '../packages/runtime/src/mission-lifecycle.js';
import {missionSummaries} from '../packages/runtime/src/mission-summary.js';
it('preserves final spend and pinned deliverables in history and attributes new global events to the next mission',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service);
 expect((await service.snapshot()).mission.onboarding_completed).toBe(false);
 const input={template:'research',title:'Research',objective:'Answer a question',definitionOfDone:['Deliver a report'],kind:'FINITE',budgetUsd:'5',capabilities:['core','documents','research'],deliverable:'report.md'};
 const first=await createMission(service,input);await activateMission(service,first.id);
 const ceo=await db.transaction(tx=>org.ensureCEO(tx));const task=await service.createTask({objective:'Prepare report',employeeId:ceo.id});
 await db.transaction(tx=>writeDocument(tx,{path:'first/report.md',title:'Report',content:'Bounded findings and limitations.',expectedVersion:0},ceo.id,task.id));
 await db.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,task_id,description) VALUES('cost','cost','OPERATING','COST',1500000,$1,'Synthetic cost')",[task.id]);
 const completion=await db.transaction(tx=>requestMissionCompletion(tx,{...task,employee_id:ceo.id,mission_id:first.id},{conditions:[{conditionIndex:0,evidence:[{kind:'DOCUMENT',id:'first/report.md',version:1}]}],deliverable:{path:'first/report.md',version:1}}));
 await expect(service.resolveRequest(completion.id,'DONE','Bypass',0)).rejects.toThrow('dedicated approval');
 await confirmMissionCompletion(service,completion.id,completion.hash,true);
 const second=await createMission(service,{...input,title:'Second research'});await activateMission(service,second.id);await service.setStatus('PAUSED');
 const latest=await one(db,"SELECT mission_id FROM events WHERE entity_id='company' ORDER BY sequence DESC LIMIT 1");expect(latest.mission_id).toBe(second.id);
 const rows=await missionSummaries(db),history=rows.find(r=>r.id===first.id)!;
 expect(history.status).toBe('COMPLETED');expect(history.spentMicroUsd).toBe('1500000');expect(history.completion.packet.deliverable).toEqual({path:'first/report.md',version:1});expect(history.ownerRequests).toHaveLength(0);
 expect(rows.find(r=>r.id===second.id)?.spentMicroUsd).toBe('0');
 }finally{await db.close();}
});
