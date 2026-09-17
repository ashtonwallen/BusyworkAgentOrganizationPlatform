import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {parseUsd} from '@hive/core';
import {one,event,type Tx,type Row} from './db.js';
import {DomainError,actionHash,type HiveService} from './service.js';
import {readDocument} from './documents.js';
import {completionInput,completionReference as reference} from './mission-completion-input.js';

export async function missionExposure(tx:Pick<Tx,'query'>,id:string){
 const row=await one(tx,`SELECT
  (SELECT COALESCE(sum(amount),0)::text FROM ledger WHERE mission_id=$1 AND kind='COST' AND account<>'TEST') AS spent,
  ((SELECT COALESCE(sum(reserved),0) FROM calls WHERE mission_id=$1 AND status IN ('RESERVED','DISPATCHED','UNCERTAIN'))+
   (SELECT COALESCE(sum(reservation),0) FROM actions WHERE mission_id=$1)+
   (SELECT COALESCE(sum(reserved),0) FROM notifications WHERE mission_id=$1 AND settled IS NULL))::text AS held`,[id]);
 return {spent:BigInt(row.spent),held:BigInt(row.held)};
}
export async function pauseMission(tx:Tx,mission:Row,reason:string){
 if(mission.pause_reason)return;
 await tx.query('UPDATE missions SET pause_reason=$2,revision=revision+1 WHERE id=$1',[mission.id,reason]);
 const id=randomUUID();await tx.query('INSERT INTO owner_requests(id,title,details,mission_id) VALUES($1,$2,$3,$4)',
  [id,'Mission needs attention: '+mission.title,reason,mission.id]);
 await event(tx,'mission.paused',mission.id,{reason,requestId:id},'system');
}
/** Call while holding the company lock; return a denial so the pause/request commits. */
export async function missionAdmission(tx:Tx,id:string|null,additional=0n){
 if(!id)return 'Select an active mission before executing work.';
 const m=await one(tx,'SELECT * FROM missions WHERE id=$1 FOR UPDATE',[id]);
 if(m.status!=='ACTIVE')return 'Mission is not active.';
 if(m.pause_reason)return m.pause_reason as string;
 const used=await missionExposure(tx,id);
 if(m.budget!==null&&(used.spent+used.held+additional>BigInt(m.budget)||(used.spent+used.held>=BigInt(m.budget)&&additional===0n))){
  const reason='Mission budget cannot cover further work, including unresolved reservations. Review the mission budget or stop the mission.';
  await pauseMission(tx,m,reason);return reason;
 }
 if(m.deadline&&new Date(m.deadline)<=new Date()){
  const reason='Mission deadline reached. Review the result or extend the deadline.';await pauseMission(tx,m,reason);return reason;
 }
 return null;
}
export async function missionProgress(tx:Pick<Tx,'query'>,id:string){
 return one(tx,`SELECT
 (SELECT count(*)::integer FROM tasks t WHERE mission_id=$1 AND status='COMPLETED'
   AND NOT EXISTS(SELECT 1 FROM events e WHERE e.entity_id=t.id AND e.type='company.ceo_cycle_started')) AS completed,
 (SELECT count(*)::integer FROM document_versions WHERE mission_id=$1) AS documents,
 (SELECT count(*)::integer FROM actions WHERE mission_id=$1 AND status='EXECUTED' AND action_type='READ_PUBLIC_PAGE') AS sources,
 (SELECT count(*)::integer FROM approvals WHERE mission_id=$1 AND decision='APPROVE'
  AND action_id IN (SELECT id FROM actions WHERE action_type<>'MODEL_CALL')) AS approved`,[id]);
}
export async function checkMissionStall(tx:Tx,mission:Row,latest:Row|undefined){
 if(mission.kind!=='FINITE'||!latest)return false;
 const prior=(await tx.query<Row>("SELECT payload FROM events WHERE type='mission.progress_checked' AND entity_id=$1 ORDER BY sequence DESC LIMIT 1",[mission.id])).rows[0]?.payload;
 if(prior?.cycleId===latest.id)return false;
 const progress=await missionProgress(tx,mission.id);
 const changed=!prior||Object.keys(progress).some(key=>progress[key]>prior.progress[key]);
 const stagnant=changed?0:(prior.stagnant??0)+1;
 await event(tx,'mission.progress_checked',mission.id,{cycleId:latest.id,progress,stagnant});
 if(stagnant<mission.stall_cycles)return false;
 await pauseMission(tx,mission,`No new recorded task results, document versions, fetched sources or non-model approvals in ${stagnant} CEO cycles. Recorded progress: ${JSON.stringify(progress)}. Review scope, dependencies or acceptance conditions before resuming.`);
 return true;
}
async function validateEvidence(tx:Tx,missionId:string,ref:z.infer<typeof reference>){
 if(ref.kind==='DOCUMENT'){
  if(!ref.version)throw new DomainError('Cite an exact document version.');
  const doc=await readDocument(tx,ref.id,ref.version);
  await one(tx,'SELECT document_id FROM document_versions WHERE document_id=$1 AND version=$2 AND mission_id=$3',[doc.id,ref.version,missionId]);
 }else if(ref.kind==='TASK')await one(tx,"SELECT id FROM tasks WHERE id=$1 AND mission_id=$2 AND status='COMPLETED'",[ref.id,missionId]);
 else if(ref.kind==='SOURCE')await one(tx,'SELECT id FROM source_records WHERE id=$1 AND mission_id=$2',[ref.id,missionId]);
 else await one(tx,"SELECT id FROM actions WHERE id=$1 AND mission_id=$2 AND status='EXECUTED' AND result IS NOT NULL",[ref.id,missionId]);
}
export async function requestMissionCompletion(tx:Tx,task:Row,raw:unknown){
 const input=completionInput.parse(raw),employee=await one(tx,"SELECT role FROM employees WHERE id=$1 AND status='ACTIVE'",[task.employee_id]);
 if(employee.role!=='CEO')throw new DomainError('Only the CEO can request mission completion.');
 const m=await one(tx,'SELECT * FROM missions WHERE id=$1 FOR UPDATE',[task.mission_id]);
 if(m.status!=='ACTIVE')throw new DomainError('Mission is not active.');
 if(input.conditions.length!==m.definition_of_done.length||new Set(input.conditions.map(c=>c.conditionIndex)).size!==m.definition_of_done.length)throw new DomainError('Cite evidence for every completion condition.');
 for(const condition of input.conditions){
  if(condition.conditionIndex>=m.definition_of_done.length)throw new DomainError('Unknown completion condition.');
  for(const ref of condition.evidence)await validateEvidence(tx,m.id,ref);
 }
 await validateEvidence(tx,m.id,{kind:'DOCUMENT',id:input.deliverable.path,version:input.deliverable.version});
 const pending=await one(tx,"SELECT count(*)::integer AS count FROM calls WHERE mission_id=$1 AND status IN ('RESERVED','DISPATCHED','UNCERTAIN')",[m.id]);
 const outside=await one(tx,"SELECT count(*)::integer AS count FROM actions WHERE mission_id=$1 AND (reservation>0 OR status IN ('EXECUTING','UNCERTAIN','AWAITING_COST'))",[m.id]);
 if(pending.count||outside.count)throw new DomainError('Resolve active or uncertain execution before requesting completion.');
 const packet={missionId:m.id,revision:m.revision,objective:m.objective,definitionOfDone:m.definition_of_done,...input};
 const hash=actionHash(packet),id=randomUUID();
 await tx.query('INSERT INTO owner_requests(id,title,details,mission_id) VALUES($1,$2,$3,$4)',[id,'Confirm mission completion: '+m.title,JSON.stringify({kind:'MISSION_COMPLETION',hash,packet}),m.id]);
 await tx.query("UPDATE missions SET status='COMPLETING',revision=revision+1 WHERE id=$1",[m.id]);
 await event(tx,'mission.completion_requested',m.id,{requestId:id,hash,packet},task.employee_id);return {id,hash};
}
export async function confirmMissionCompletion(service:HiveService,id:string,hash:string,accept:boolean){
 return service.db.transaction(async tx=>{
  await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
  const request=await one(tx,'SELECT * FROM owner_requests WHERE id=$1 FOR UPDATE',[id]);
  const data=JSON.parse(request.details);
  if(data.kind!=='MISSION_COMPLETION'||data.hash!==hash||actionHash(data.packet)!==hash||request.status!=='OPEN')throw new DomainError('Completion request changed or was already decided.');
  const m=await one(tx,'SELECT * FROM missions WHERE id=$1 FOR UPDATE',[request.mission_id]);
  if(m.status!=='COMPLETING'||m.revision!==data.packet.revision+1)throw new DomainError('Mission changed after completion was requested.');
  await tx.query("UPDATE owner_requests SET status=$2,response=$3 WHERE id=$1",[id,accept?'DONE':'DECLINED',accept?'Completion confirmed.':'Continue mission work.']);
  await tx.query("UPDATE missions SET status=$2,completed_at=CASE WHEN $2='COMPLETED' THEN now() ELSE NULL END,revision=revision+1 WHERE id=$1",[m.id,accept?'COMPLETED':'ACTIVE']);
  if(accept)await tx.query("UPDATE tasks SET status='CANCELLED',error='Mission completed by owner confirmation.' WHERE mission_id=$1 AND status NOT IN ('COMPLETED','FAILED','EXPIRED','CANCELLED')",[m.id]);
  await event(tx,accept?'mission.completed':'mission.completion_declined',m.id,{requestId:id,hash,deliverable:data.packet.deliverable},'owner');
 });
}
export async function stopMission(service:HiveService,id:string){
 return service.db.transaction(async tx=>{
  await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
  const m=await one(tx,'SELECT * FROM missions WHERE id=$1 FOR UPDATE',[id]);
  if(['COMPLETED','STOPPED'].includes(m.status))return;
  const busy=await one(tx,"SELECT count(*)::integer AS count FROM calls WHERE mission_id=$1 AND status IN ('RESERVED','DISPATCHED')",[id]);
  if(busy.count)throw new DomainError('Wait for dispatched model calls before stopping this mission.');
  const external=await one(tx,"SELECT count(*)::integer AS count FROM actions WHERE mission_id=$1 AND status='EXECUTING'",[id]);
  if(external.count)throw new DomainError('Wait for dispatched external actions before stopping this mission.');
  await tx.query("UPDATE missions SET status='STOPPED',revision=revision+1 WHERE id=$1",[id]);
  await tx.query("UPDATE tasks SET status='CANCELLED',error='Mission stopped by owner.' WHERE mission_id=$1 AND status NOT IN ('COMPLETED','FAILED','EXPIRED','CANCELLED')",[id]);
  await event(tx,'mission.stopped',id,{},'owner');
 });
}
export async function resumeMission(service:HiveService,id:string,raw:unknown){
 const input=z.object({revision:z.number().int(),reason:z.string().trim().min(1).max(2000),budgetUsd:z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable().optional(),deadline:z.iso.datetime().nullable().optional()}).strict().parse(raw);
 return service.db.transaction(async tx=>{
  await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
  const m=await one(tx,'SELECT * FROM missions WHERE id=$1 FOR UPDATE',[id]);
  if(m.status!=='ACTIVE'||m.revision!==input.revision)throw new DomainError('Refresh the active mission before resuming.');
  const budget=input.budgetUsd===undefined?m.budget:input.budgetUsd===null?null:parseUsd(input.budgetUsd).toString();
  const exposure=await missionExposure(tx,id);
  if(budget!==null&&exposure.spent+exposure.held>=BigInt(budget))throw new DomainError('Budget must cover recorded spending, unresolved holds and further work.');
  await tx.query('UPDATE missions SET budget=$2,deadline=$3,pause_reason=NULL,revision=revision+1 WHERE id=$1',[id,budget,input.deadline===undefined?m.deadline:input.deadline]);
  await tx.query("UPDATE tasks SET status=CASE phase WHEN 'PLAN' THEN 'PLAN_PENDING' WHEN 'REVIEW' THEN 'REVIEW' ELSE 'READY' END,error=NULL WHERE mission_id=$1 AND status='BLOCKED_BUDGET' AND error LIKE 'Mission %'",[id]);
  await event(tx,'mission.progress_checked',id,{cycleId:null,progress:await missionProgress(tx,id),stagnant:0},'owner');
  await event(tx,'mission.resumed',id,{reason:input.reason,budget},'owner');
 });
}
