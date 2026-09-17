import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {one,event,type Tx,type Row} from './db.js';
import {DomainError,activeCalls,type HiveService} from './service.js';
import {backlogItems,startBacklog} from './backlog.js';
export async function pendingBacklogStarts(tx:Pick<Tx,'query'>){return (await tx.query<Row>(`SELECT e.entity_id AS id,e.payload,e.created_at FROM events e WHERE e.type='backlog.scheduled' AND NOT EXISTS(SELECT 1 FROM events done WHERE done.entity_id=e.entity_id AND done.type IN ('backlog.schedule_started','backlog.schedule_cancelled')) ORDER BY e.sequence`)).rows;}
async function assignee(tx:Pick<Tx,'query'>,actor:string,employeeId:string){
 const reports=(await tx.query<Row>(`WITH RECURSIVE reports AS (SELECT id FROM employees WHERE id=$1 AND status='ACTIVE' UNION SELECT e.id FROM employees e JOIN reports r ON e.manager_id=r.id WHERE e.status='ACTIVE') SELECT id FROM reports`,[actor])).rows;
 if(!reports.some(r=>r.id===employeeId))throw new DomainError('Schedule work for yourself or your active reporting chain.');
}
export async function scheduleBacklog(tx:Tx,source:Row,id:string,expectedVersion:number,scheduledAt:string|null,now:Date){
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 if(!source.employee_id)throw new DomainError('An employed agent is required.');
 const item=(await backlogItems(tx)).find(b=>b.id===id);if(!item||item.payload.cancelled)throw new DomainError('Choose an available backlog item.');
 if(item.payload.version!==expectedVersion)throw new DomainError('Read the latest backlog version before scheduling.');
 if(item.task_id&&!['FAILED','EXPIRED','CANCELLED'].includes(item.task_status))throw new DomainError('This backlog item already has assigned work.');
 const due=scheduledAt?new Date(z.iso.datetime().parse(scheduledAt)):now;
 if(due>=new Date(source.expires_at)||now>=new Date(source.expires_at))throw new DomainError('Scheduled work must start before the source deadline.');
 const employeeId=item.payload.employeeId??source.employee_id;await assignee(tx,source.employee_id,employeeId);
 const pending=await pendingBacklogStarts(tx),existing=pending.find(s=>s.payload.backlogId===id);
 if(existing){if(existing.payload.version===expectedVersion&&existing.payload.sourceTaskId===source.id&&existing.payload.notBefore===due.toISOString())return existing.id;throw new DomainError('Cancel the existing schedule before replacing it.');}
 if(pending.length>=100)throw new DomainError('Resolve existing schedules before adding more.');
 const scheduleId=randomUUID();await event(tx,'backlog.scheduled',scheduleId,{backlogId:id,version:expectedVersion,employeeId,sourceTaskId:source.id,requestedBy:source.employee_id,notBefore:due.toISOString(),title:item.payload.title},source.employee_id);return scheduleId;
}
export async function cancelBacklogStart(tx:Tx,id:string,actor:string,reason:string){
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');const schedule=(await pendingBacklogStarts(tx)).find(s=>s.id===id);
 if(!schedule)throw new DomainError('Schedule is no longer pending.');
 if(actor!=='owner'&&actor!==schedule.payload.requestedBy)throw new DomainError('Only the requesting employee or owner may cancel this schedule.');
 await event(tx,'backlog.schedule_cancelled',id,{reason},actor);
}
async function cancelWithNotice(tx:Tx,schedule:Row,reason:string){
 await event(tx,'backlog.schedule_cancelled',schedule.id,{reason},'company');const id=randomUUID();
 await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body) VALUES($1,'company',$2,'MESSAGE','Scheduled work cancelled',$3)",[id,schedule.payload.requestedBy,`${schedule.payload.title}: ${reason} Review the current plan before scheduling new work. Continue independent work.`]);
 await event(tx,'message.created',id,{senderId:'company',recipientId:schedule.payload.requestedBy},'company');
}
async function readiness(tx:Tx,service:HiveService,schedule:Row,company:Row,items:Row[]){
 const p=schedule.payload,source=(await tx.query<Row>('SELECT * FROM tasks WHERE id=$1',[p.sourceTaskId])).rows[0],item=items.find(b=>b.id===p.backlogId);
 const cancelled=(reason:string)=>({state:'CANCELLED',reason,source,taskId:null as string|null});
 const waiting=(state:string,reason:string)=>({state,reason,source,taskId:null as string|null});
 if(company.status!=='RUNNING')return waiting('PAUSED','Company runtime is '+company.status.toLowerCase()+'.');
 if(!source||['CANCELLED','EXPIRED'].includes(source.status)||new Date(source.expires_at)<=service.now()||source.depth+1>company.max_depth)return cancelled('The source deadline, cancellation or delegation limit prevents assignment.');
 if(!item||item.payload.cancelled||item.payload.version!==p.version)return cancelled('The planned work changed or was cancelled.');
 try{await assignee(tx,p.requestedBy,p.employeeId);}catch{return cancelled('The employee or reporting authority changed.');}
 if(item.payload.orderId){const order=(await tx.query<Row>("SELECT payload FROM events WHERE type='order.updated' AND entity_id=$1 ORDER BY sequence DESC LIMIT 1",[item.payload.orderId])).rows[0];if(!order||order.payload.stage==='CANCELLED')return cancelled('The customer order is unavailable or cancelled.');}
 if(item.task_id&&!['FAILED','EXPIRED','CANCELLED'].includes(item.task_status))return {state:'ASSIGNED',reason:'This plan already has assigned work.',source,taskId:item.task_id as string|null};
 const dependencies=item.payload.dependsOn.map((id:string)=>items.find(b=>b.id===id));
 if(dependencies.some((d:Row|undefined)=>!d||d.payload.cancelled))return cancelled('A prerequisite plan was cancelled or removed.');
 const incomplete=dependencies.filter((d:Row)=>d.task_status!=='COMPLETED'||!d.operations_applied);
 if(incomplete.length)return waiting('PREREQUISITES',incomplete.length+' prerequisite plan(s) have not completed and applied their operations.');
 if(new Date(p.notBefore)>service.now())return waiting('SCHEDULED_TIME','Waiting until '+p.notBefore+'.');
 if((await tx.query("SELECT id FROM tasks WHERE employee_id=$1 AND status NOT IN ('COMPLETED','FAILED','EXPIRED','CANCELLED') LIMIT 1",[p.employeeId])).rows.length)return waiting('EMPLOYEE_BUSY','The employee has active work.');
 if((await tx.query(`SELECT c.id FROM calls c JOIN tasks t ON t.id=c.task_id WHERE t.employee_id=$1 AND c.status IN ${activeCalls} LIMIT 1`,[p.employeeId])).rows.length)return waiting('UNRESOLVED_CALL','The employee has an active or unconfirmed model call.');
 if(item.task_id&&(await tx.query(`SELECT id FROM calls WHERE task_id=$1 AND status IN ${activeCalls}`,[item.task_id])).rows.length)return waiting('PRIOR_CALL','The prior attempt has an active or unconfirmed model call.');
 const employee=(await tx.query<Row>('SELECT * FROM employees WHERE id=$1',[p.employeeId])).rows[0];
 if(!service.models.some(m=>m.id===(employee.role==='CEO'?company.ceo_model_id:employee.model_id)&&m.ready))return waiting('MODEL_UNAVAILABLE','The employee model is not ready.');
 return waiting('READY','Ready for the next scheduler tick.');
}
/** Read the same readiness decision used by execution; never schedules or emits events. */
export async function backlogScheduleStatus(tx:Tx,service:HiveService){
 const company=await one(tx,'SELECT * FROM company WHERE id=1'),items=await backlogItems(tx),result:Row[]=[];
 for(const schedule of await pendingBacklogStarts(tx)){const {state,reason,taskId}=await readiness(tx,service,schedule,company,items);result.push({...schedule,state,reason,taskId});}
 return result;
}
export async function runBacklogSchedules(service:HiveService){
 await service.db.transaction(async tx=>{
 const company=await one(tx,'SELECT * FROM company WHERE id=1 FOR UPDATE');if(company.status!=='RUNNING')return;
 for(const schedule of await pendingBacklogStarts(tx)){
 if(!(await tx.query("SELECT id FROM missions WHERE id=(SELECT mission_id FROM events WHERE entity_id=$1 AND type='backlog.scheduled' ORDER BY sequence DESC LIMIT 1) AND status='ACTIVE' AND pause_reason IS NULL",[schedule.id])).rows.length)continue;
 const decision=await readiness(tx,service,schedule,company,await backlogItems(tx));
 if(decision.state==='CANCELLED'){await cancelWithNotice(tx,schedule,decision.reason);continue;}
 if(decision.state==='ASSIGNED'){await event(tx,'backlog.schedule_started',schedule.id,{taskId:decision.taskId,alreadyAssigned:true},schedule.payload.requestedBy);continue;}
 if(decision.state!=='READY')continue;
 const started=await startBacklog(tx,service,schedule.payload.backlogId,schedule.payload.requestedBy,decision.source);
 await event(tx,'backlog.schedule_started',schedule.id,{taskId:started.id},schedule.payload.requestedBy);
 const id=randomUUID();await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Scheduled work assigned',$3,$4)",[id,schedule.payload.requestedBy,schedule.payload.title+': assigned to '+schedule.payload.employeeId+'. Task '+started.id+'. Assignment does not mean completion or external execution.',started.id]);
 await event(tx,'message.created',id,{senderId:'company',recipientId:schedule.payload.requestedBy,taskId:started.id},'company');
 }
 });
}
