import {randomUUID} from 'node:crypto';
import {parseUsd} from '@hive/core';
import {one,event,type Tx,type Row} from './db.js';
import {DomainError,activeCalls,type HiveService} from './service.js';
import {readTaskResult} from './task-results.js';

export async function pendingFollowUps(tx:Pick<Tx,'query'>){
 return (await tx.query<Row>(`SELECT e.entity_id AS id,e.payload,e.created_at FROM events e
 WHERE e.type='followup.scheduled' AND NOT EXISTS(SELECT 1 FROM events done WHERE done.entity_id=e.entity_id AND done.type IN ('followup.started','followup.cancelled')) ORDER BY e.sequence`)).rows;
}
export async function scheduleFollowUp(tx:Tx,source:Row,dependencyId:string,instructions:string,title:string,budgetUsd:string,tokenBudget:number){
 if(!source.employee_id)throw new DomainError('Follow-up requires an assigned employee.');
 if(source.id===dependencyId)throw new DomainError('Choose another task to follow up on.');
 await readTaskResult(tx,source.employee_id,dependencyId);
 const existing=(await pendingFollowUps(tx)).find(r=>r.payload.employeeId===source.employee_id&&r.payload.dependencyId===dependencyId);
 if(existing)return existing.id;
 const pending=await pendingFollowUps(tx);
 if(pending.length>=100)throw new DomainError('Resolve or cancel existing follow-ups before scheduling more.');
 const id=randomUUID();
 await event(tx,'followup.scheduled',id,{employeeId:source.employee_id,sourceTaskId:source.id,dependencyId,instructions,title,budgetUsd,tokenBudget},source.employee_id);
 return id;
}
export async function cancelFollowUp(tx:Tx,id:string,actor:string,reason:string){
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 const pending=(await pendingFollowUps(tx)).find(r=>r.id===id);
 if(!pending)throw new DomainError('Follow-up is no longer pending.');
 if(actor!=='owner'&&pending.payload.employeeId!==actor)throw new DomainError('Only the responsible employee or owner may cancel this follow-up.');
 await event(tx,'followup.cancelled',id,{reason},actor);
}
/** Durable continuation scheduling only. Execution still uses the normal worker and policy. */
export async function runFollowUps(service:HiveService){
 await service.db.transaction(async tx=>{
  const company=await one(tx,'SELECT * FROM company WHERE id=1 FOR UPDATE');if(company.status!=='RUNNING')return;
  for(const followup of (await pendingFollowUps(tx)).slice(0,100)){
   const p=followup.payload;
   const source=(await tx.query<Row>('SELECT * FROM tasks WHERE id=$1',[p.sourceTaskId])).rows[0];
   if(source&&!(await tx.query("SELECT id FROM missions WHERE id=$1 AND status='ACTIVE' AND pause_reason IS NULL",[source.mission_id])).rows.length)continue;
   const employee=(await tx.query<Row>("SELECT * FROM employees WHERE id=$1 AND status='ACTIVE'",[p.employeeId])).rows[0];
   if(!source||!employee||source.status==='CANCELLED'||new Date(source.expires_at)<=service.now()||source.depth+1>company.max_depth){
    const reason='Source deadline, delegation limit or employee availability no longer permits this follow-up.';
    await event(tx,'followup.cancelled',followup.id,{reason},'company');
    const id=randomUUID();await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body) VALUES($1,'company',$2,'MESSAGE','Follow-up cancelled',$3)",[id,p.employeeId,reason+' '+p.title]);await event(tx,'message.created',id,{senderId:'company',recipientId:p.employeeId},'company');continue;
   }
   const dependency=(await tx.query<Row>('SELECT * FROM tasks WHERE id=$1',[p.dependencyId])).rows[0];
   if(!dependency||!['COMPLETED','FAILED','EXPIRED','CANCELLED'].includes(dependency.status)||(dependency.status==='COMPLETED'&&!dependency.operations_applied))continue;
   if((await tx.query("SELECT id FROM tasks WHERE employee_id=$1 AND status NOT IN ('COMPLETED','FAILED','EXPIRED','CANCELLED') LIMIT 1",[employee.id])).rows.length)continue;
   if((await tx.query(`SELECT c.id FROM calls c JOIN tasks t ON t.id=c.task_id WHERE t.employee_id=$1 AND c.status IN ${activeCalls} LIMIT 1`,[employee.id])).rows.length)continue;
   try{await readTaskResult(tx,employee.id,p.dependencyId);}catch{await event(tx,'followup.cancelled',followup.id,{reason:'Access to prerequisite work changed.'},'company');continue;}
   const model=service.models.find(m=>m.id===(employee.role==='CEO'?company.ceo_model_id:employee.model_id)&&m.ready);if(!model)continue;
   const id=randomUUID();
   const objective=`${p.instructions}\nFollow up on task ${dependency.id}, now ${dependency.status}. Read its submitted results and actual operation outcomes with READ_TASK_RESULT. ${dependency.status==='COMPLETED'?'Completion is not evidence that every proposed action executed.':'No completed result is guaranteed; inspect the failure before deciding a next step.'} This follow-up does not authorize external actions or retries. Preserve current company direction and owner restrictions.`;
   await tx.query(`INSERT INTO tasks(id,parent_id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id,employee_id)
    VALUES($1,$2,$3,$4,$5,$6,'PLAN_PENDING',$7,$8,$9,$10,NULL,$11)`,[id,source.id,source.root_id,objective,'Follow-up: '+p.title,source.depth+1,parseUsd(p.budgetUsd).toString(),p.tokenBudget,source.expires_at,model.id,employee.id]);
   await event(tx,'followup.started',followup.id,{taskId:id,dependencyId:dependency.id,dependencyStatus:dependency.status},employee.id);
  }
 });
}
