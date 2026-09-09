import {z} from 'zod';
import {one,event,type Tx} from './db.js';
import {DomainError} from './service.js';
/** Withdraw only the employee's own unsent draft. No provider request or receipt mutation. */
export async function withdrawOwnEmail(tx:Tx,actor:string,emailId:string,reason:string){
 z.uuid().parse(emailId);reason=z.string().trim().min(1).max(2000).parse(reason);
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 await one(tx,"SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[actor]);
 const message=await one(tx,"SELECT m.id,m.author_id,m.status,m.action_id,a.status AS action_status FROM email_messages m JOIN actions a ON a.id=m.action_id WHERE m.id=$1 FOR UPDATE OF m,a",[emailId]);
 if(message.author_id!==actor)throw new DomainError('Withdraw only email proposals you authored.');
 if(message.status!=='QUEUED')throw new DomainError('This email may have been dispatched or is terminal. Inspect its original result; withdrawal cannot recall or retry it.');
 if(message.action_status==='CANCELLED')return {emailId,actionId:message.action_id,withdrawn:true,alreadyWithdrawn:true};
 if(!['PENDING','APPROVED'].includes(message.action_status))throw new DomainError('Only pending or approved unsent email proposals can be withdrawn.');
 await tx.query("UPDATE actions SET status='CANCELLED' WHERE id=$1",[message.action_id]);
 await tx.query("UPDATE notifications SET status='DISABLED' WHERE action_id=$1 AND status='PENDING'",[message.action_id]);
 await event(tx,'action.cancelled',message.action_id,{emailId,reason},actor);
 await event(tx,'email.withdrawn',emailId,{actionId:message.action_id,reason},actor);
 return {emailId,actionId:message.action_id,withdrawn:true,alreadyWithdrawn:false};
}
