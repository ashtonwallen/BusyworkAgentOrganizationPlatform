import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {one,event,type Tx,type Row} from './db.js';
import {DomainError} from './service.js';
export async function cancelAssignedWork(tx:Tx,actor:string,target:string,sourceId:string,reason:string){
 z.uuid().parse(target);reason=z.string().trim().min(1).max(2000).parse(reason);await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 const allowed=(await tx.query<Row>(`WITH RECURSIVE reports AS (SELECT id FROM employees WHERE id=$1 AND status='ACTIVE' UNION SELECT e.id FROM employees e JOIN reports r ON e.manager_id=r.id) SELECT t.id FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_id WHERE t.id=$2 AND (t.employee_id IN (SELECT id FROM reports) OR p.employee_id=$1) AND EXISTS(SELECT 1 FROM employees WHERE id=$1 AND status='ACTIVE')`,[actor,target])).rows.length;
 if(!allowed)throw new DomainError('Cancel your own work, your reporting chain work, or a directly commissioned assignment.');
 const branch=(await tx.query<Row>(`WITH RECURSIVE branch AS (SELECT id,employee_id FROM tasks WHERE id=$1 UNION SELECT t.id,t.employee_id FROM tasks t JOIN branch b ON t.parent_id=b.id) SELECT * FROM branch`,[target])).rows;
 if(branch.some(t=>t.id===sourceId))throw new DomainError('Do not cancel the operation source or its ancestors.');
 const changed=(await tx.query<Row>("UPDATE tasks SET status='CANCELLED',updated_at=now() WHERE id=ANY($1::text[]) AND (status NOT IN ('COMPLETED','CANCELLED','EXPIRED') OR (status='COMPLETED' AND NOT operations_applied)) RETURNING id,employee_id",[branch.map(t=>t.id)])).rows;
 for(const task of changed)await event(tx,'task.cancelled',task.id,{reason,sourceTaskId:sourceId},actor);
 for(const employeeId of new Set(changed.map(t=>t.employee_id).filter(Boolean))){const id=randomUUID();await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body) VALUES($1,'company',$2,'MESSAGE','Assignment cancelled',$3)",[id,employeeId,`Assignment ${target} and unfinished delegated work were cancelled by ${actor}. Reason: ${reason} Calls and external-action receipts remain recorded; cancellation does not recall or retry external work. Continue other useful authorized work.`]);await event(tx,'message.created',id,{senderId:'company',recipientId:employeeId},actor);}
 return {taskId:target,cancelledTaskIds:changed.map(t=>t.id)};
}
