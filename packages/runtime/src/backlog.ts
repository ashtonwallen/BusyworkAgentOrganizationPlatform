import {linkTaskExperiment} from './experiment-economics.js';
import {backlogInput} from './backlog-input.js';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {parseUsd} from '@hive/core';
import {one,event,type Tx,type Row} from './db.js';
import {DomainError,type HiveService,activeCalls} from './service.js';

export {backlogInput} from './backlog-input.js';
export async function backlogItems(tx:Pick<Tx,'query'>){
 return (await tx.query<Row>(`WITH latest AS (SELECT DISTINCT ON(entity_id) entity_id,payload,created_at FROM events WHERE type='backlog.updated' ORDER BY entity_id,sequence DESC)
 SELECT l.entity_id AS id,l.payload,l.created_at,s.payload->>'taskId' AS task_id,t.status AS task_status,t.operations_applied
 FROM latest l LEFT JOIN LATERAL (SELECT payload FROM events WHERE type='backlog.started' AND entity_id=l.entity_id ORDER BY sequence DESC LIMIT 1) s ON true
 LEFT JOIN tasks t ON t.id=s.payload->>'taskId' ORDER BY CASE l.payload->>'priority' WHEN 'HIGH' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END,l.created_at`)).rows;
}
export async function saveBacklog(tx:Tx,id:string,raw:unknown,actor:string){
 const input=backlogInput.parse(raw);z.uuid().parse(id);await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 if(actor!=='owner'&&!(await tx.query("SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[actor])).rows.length)throw new DomainError('An active employee is required.');
 if(input.employeeId&&!(await tx.query("SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[input.employeeId])).rows.length)throw new DomainError('Select an active employee.');
 if(input.orderId)await one(tx,"SELECT entity_id FROM events WHERE type='order.updated' AND entity_id=$1 LIMIT 1",[input.orderId]);
 if(input.experimentId)await one(tx,'SELECT id FROM experiments WHERE id=$1',[input.experimentId]);
 const rows=await backlogItems(tx),prior=rows.find(r=>r.id===id);
 if((prior?.payload.version??0)!==input.expectedVersion)throw new DomainError('Backlog item changed. Read its latest version before editing.');
 if(!prior&&rows.length>=500)throw new DomainError('The backlog has reached its 500-item limit.');
 if(prior?.task_status==='COMPLETED')throw new DomainError('Completed work is preserved. Create a new backlog item for a new or revised deliverable.');
 if(prior?.task_id&&(!['COMPLETED','FAILED','EXPIRED','CANCELLED'].includes(prior.task_status)||prior.task_status==='COMPLETED'&&!prior.operations_applied))throw new DomainError('Wait for the linked work to finish before changing its brief. Cancel the objective separately if needed.');
 const dependencies=[...new Set(input.dependsOn)];
 for(const dependency of dependencies){
  if(!rows.some(r=>r.id===dependency))throw new DomainError('Dependency does not exist.');
  const seen=new Set<string>(),visit=(key:string):boolean=>{if(key===id)return true;if(seen.has(key))return false;seen.add(key);return (rows.find(r=>r.id===key)?.payload.dependsOn??[]).some(visit);};
  if(visit(dependency))throw new DomainError('Backlog dependencies cannot form a cycle.');
 }
 const {expectedVersion,...fields}=input;const payload={...fields,dependsOn:dependencies,version:expectedVersion+1,updatedBy:actor};
 await event(tx,'backlog.updated',id,payload,actor);return {id,...payload};
}
export async function startBacklog(tx:Tx,service:HiveService,id:string,actor:string,source?:Row){
 const company=await one(tx,'SELECT * FROM company WHERE id=1 FOR UPDATE');if(company.status==='KILLED')throw new DomainError('Restart the company before assigning backlog work.');
 const rows=await backlogItems(tx),item=rows.find(r=>r.id===id);if(!item)throw new DomainError('Backlog item not found.');
 if(item.payload.cancelled)throw new DomainError('This backlog item is cancelled.');
 if(item.task_id&&!['FAILED','EXPIRED','CANCELLED'].includes(item.task_status))return {id:item.task_id,existing:true};
 for(const dependencyId of item.payload.dependsOn){const dependency=rows.find(r=>r.id===dependencyId);if(!dependency||dependency.payload.cancelled||dependency.task_status!=='COMPLETED'||!dependency.operations_applied)throw new DomainError('Complete prerequisite backlog work before starting this item.');}
 let employeeId=item.payload.employeeId??(actor==='owner'?null:actor);
 if(!employeeId)employeeId=(await tx.query<Row>("SELECT id FROM employees WHERE role='CEO' AND status='ACTIVE' LIMIT 1")).rows[0]?.id;
 const employee=await one(tx,"SELECT * FROM employees WHERE id=$1 AND status='ACTIVE'",[employeeId??'']);
 if(actor!=='owner'){
  const reports=(await tx.query<Row>(`WITH RECURSIVE reports AS (SELECT id FROM employees WHERE id=$1 AND status='ACTIVE' UNION SELECT e.id FROM employees e JOIN reports r ON e.manager_id=r.id) SELECT id FROM reports`,[actor])).rows;
  if(!reports.some(r=>r.id===employee.id))throw new DomainError('Assign backlog work to yourself or your reporting chain; use a consultation for other departments.');
 }
 if(item.task_id&&(await tx.query(`SELECT id FROM calls WHERE task_id=$1 AND status IN ${activeCalls}`,[item.task_id])).rows.length)throw new DomainError('Reconcile unresolved calls on the prior attempt before scheduling another.');
 const order=item.payload.orderId?(await one(tx,"SELECT payload FROM events WHERE type='order.updated' AND entity_id=$1 ORDER BY sequence DESC LIMIT 1",[item.payload.orderId])).payload:null;
 if(order?.stage==='CANCELLED')throw new DomainError('This customer order is cancelled. Update the work plan before assigning it.');
 const depth=source?source.depth+1:0,expires=source?new Date(source.expires_at):new Date(service.now().getTime()+86400000);
 if(depth>company.max_depth||expires<=service.now())throw new DomainError('Delegation depth or source deadline prevents this assignment.');
 const model=service.model(employee.role==='CEO'?company.ceo_model_id:employee.model_id),taskId=randomUUID();
 const objective=`${order?'Customer order: '+order.title+' (version '+order.version+', ID '+item.payload.orderId+'). Recorded scope: '+order.scope+'\nUse READ_ORDER or an ORDER readRequest for current receipt and fulfillment evidence. Completion of this objective does not establish customer acceptance or payment.\n':''}${item.payload.instructions}\nSuccess criteria: ${item.payload.successCriteria}\nBacklog item: ${id}, version ${item.payload.version}. ${item.task_id?'Prior attempt: '+item.task_id+'. Inspect its outcome before repeating work. ':''}Current business direction and external-action approvals still apply. Completing this internal objective is not proof of a sale or external execution.`;
 await tx.query(`INSERT INTO tasks(id,parent_id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id,employee_id) VALUES($1,$2,$3,$4,$5,$6,'PLAN_PENDING',$7,$8,$9,$10,NULL,$11)`,[taskId,source?.id??null,source?.root_id??taskId,objective,item.payload.title,depth,source?.budget??parseUsd('1').toString(),source?.token_budget??60000,expires,model.id,employee.id]);
 if(item.payload.experimentId)await linkTaskExperiment(tx,taskId,item.payload.experimentId,actor);
 await event(tx,'backlog.started',id,{taskId,version:item.payload.version,employeeId:employee.id,orderId:item.payload.orderId??null,orderVersion:order?.version??null},actor);await event(tx,'task.created',taskId,{objective,backlogId:id,employeeId:employee.id},actor);
 return {id:taskId,existing:false};
}

/** Paged local planning data; '*' discovers the register without loading every brief. */
export async function readBacklog(tx:Pick<Tx,'query'>,actor:string,target:string,offset=0){
 await one(tx,"SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[actor]);z.number().int().min(0).max(1000000).parse(offset);
 const rows=await backlogItems(tx);
 const value=target==='*'?rows.map(b=>({id:b.id,title:b.payload.title,priority:b.payload.priority,employeeId:b.payload.employeeId,orderId:b.payload.orderId??null,cancelled:b.payload.cancelled,version:b.payload.version,taskStatus:b.task_status})).sort((a,b)=>a.id.localeCompare(b.id)):rows.find(b=>b.id===target);
 if(!value)throw new DomainError('Backlog item not found.');const serialized=JSON.stringify(value);if(offset>serialized.length)throw new DomainError('Backlog offset is out of range.');const end=Math.min(offset+4000,serialized.length);
 return {content:serialized.slice(offset,end),offset,nextOffset:end<serialized.length?end:null,version:Array.isArray(value)?undefined:value.payload.version,resultHash:createHash('sha256').update(serialized).digest('hex'),encoding:'JSON',note:'Concatenate pages with the same resultHash. Target * returns metadata; read an individual ID for full requirements. Plans are internal records, not external-action approval.'};
}
