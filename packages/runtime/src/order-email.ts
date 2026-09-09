import {z} from 'zod';
import {one,event,type Tx} from './db.js';
import {DomainError} from './service.js';
import {readOrder,saveOrder} from './orders.js';
import {emailPermission,proposeBusinessEmail} from './email.js';
import type {Workspaces} from './workspaces.js';
/** Caller transaction binds the proposal and order association; no dispatch occurs here. */
export async function proposeOrderEmail(tx:Tx,draft:unknown,actor:string,taskId:string|undefined,requestId:string,workspaces:Workspaces|undefined,reference?:{id:string;version:number}|null){
 if(reference){z.object({id:z.uuid(),version:z.number().int().positive()}).strict().parse(reference);if(!await emailPermission(tx,actor,'can_read'))throw new DomainError('Email read permission is required to link order correspondence.');}
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 const linked=(await tx.query<{payload:{orderId:string;orderVersion:number}}>("SELECT payload FROM events WHERE type='order.email_proposed' AND entity_id=$1",[requestId])).rows[0];
 if(linked&&(linked.payload.orderId!==reference?.id||linked.payload.orderVersion!==reference?.version))throw new DomainError('This email request is already associated with a different order version.');
 const order=reference?await readOrder(tx,reference.id,actor):null;
 if(order&&!linked&&order.version!==reference!.version)throw new DomainError('Order changed. Review the current order before proposing delivery.');
 const message=await proposeBusinessEmail(tx,draft,actor,taskId,requestId,workspaces);
 if(order&&!linked){const {version,updatedBy,...record}=order.record;await saveOrder(tx,order.id,{...record,emailIds:[...new Set([...record.emailIds,message.id])],expectedVersion:version},actor);await event(tx,'order.email_proposed',requestId,{orderId:order.id,orderVersion:version},actor);}
 return message;
}
