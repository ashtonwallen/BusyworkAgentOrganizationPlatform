import {readDocument} from './documents.js';
import {createHash,randomUUID} from 'node:crypto';
import {DomainError} from './service.js';
import {z} from 'zod';
import {parseUsd} from '@hive/core';
import {one,event,type Tx,type Row} from './db.js';
import {orderInput} from './order-input.js';
import {readTaskResult} from './task-results.js';
import {emailPermission} from './email.js';
async function permitted(tx:Pick<Tx,'query'>,actor:string){if(actor!=='owner'&&!(await tx.query("SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[actor])).rows.length)throw new DomainError('An active employee is required to maintain customer orders.');}
async function records(tx:Pick<Tx,'query'>){return (await tx.query<Row>("SELECT DISTINCT ON(entity_id) entity_id AS id,payload,created_at FROM events WHERE type='order.updated' ORDER BY entity_id,sequence DESC")).rows;}
export async function saveOrder(tx:Tx,id:string,raw:unknown,actor:string){
 const input=orderInput.parse(raw);z.uuid().parse(id);await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');await permitted(tx,actor);
 const all=await records(tx),prior=all.find(o=>o.id===id);if((prior?.payload.version??0)!==input.expectedVersion)throw new DomainError('Order changed. Read the latest version before saving.');if(!prior&&all.length>=500)throw new DomainError('The order register has reached its 500-record limit.');
 await one(tx,"SELECT id FROM email_entities WHERE kind='CUSTOMER' AND id=$1",[input.customerId]);
 if(input.employeeId&&input.employeeId!==prior?.payload.employeeId)await one(tx,"SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[input.employeeId]);
 if(input.experimentId)await one(tx,'SELECT id FROM experiments WHERE id=$1',[input.experimentId]);
 const canReadEmail=await emailPermission(tx,actor,'can_read');
 if(input.emailIds.length&&!canReadEmail)throw new DomainError('Email read permission is required to link correspondence.');
 const ledgerIds=[...new Set(input.ledgerIds)],taskIds=[...new Set(input.taskIds)],emailIds=canReadEmail?[...new Set(input.emailIds)]:prior?.payload.emailIds??[];
 for(const ledgerId of ledgerIds){
  if(all.some(o=>o.id!==id&&o.payload.ledgerIds.includes(ledgerId)))throw new DomainError('A ledger receipt is already assigned to another order.');
  const row=await one(tx,"SELECT id,experiment_id FROM ledger WHERE id=$1 AND account='BUSINESS' AND kind IN ('REVENUE','REFUND')",[ledgerId]);
  if(row.experiment_id&&row.experiment_id!==input.experimentId)throw new DomainError('Receipt opportunity attribution must match the order.');
 }
 for(const taskId of taskIds){if(actor==='owner')await one(tx,'SELECT id FROM tasks WHERE id=$1',[taskId]);else if(!prior?.payload.taskIds.includes(taskId))await readTaskResult(tx,actor,taskId);}
 for(const emailId of emailIds)await one(tx,'SELECT id FROM email_messages WHERE id=$1',[emailId]);
 const documentRefs=[...new Map(input.documentRefs.map(ref=>[JSON.stringify(ref),ref])).values()];
 for(const ref of documentRefs)await readDocument(tx,ref.path,ref.version);
 const {expectedVersion,...fields}=input,payload={...fields,ledgerIds,taskIds,emailIds,documentRefs,version:expectedVersion+1,updatedBy:actor};await event(tx,'order.updated',id,payload,actor);
 if(prior){
  const changed=['scope','priceUsd','dueAt','employeeId','customerId','experimentId'].filter(key=>prior.payload[key]!==payload[key as keyof typeof payload]);
  if(prior.payload.stage!==payload.stage&&(prior.payload.stage==='CANCELLED'||payload.stage==='CANCELLED'))changed.push('stage');
  if(changed.length){
   const recipients=(await tx.query<Row>(`SELECT DISTINCT e.id FROM employees e WHERE e.status='ACTIVE' AND (e.id=ANY($1::text[]) OR e.id IN (SELECT t.employee_id FROM tasks t WHERE t.status NOT IN ('COMPLETED','FAILED','EXPIRED','CANCELLED') AND (t.id=ANY($2::text[]) OR EXISTS(SELECT 1 FROM events s WHERE s.type='backlog.started' AND s.payload->>'orderId'=$3 AND s.payload->>'taskId'=t.id))))`,[[prior.payload.employeeId,payload.employeeId].filter(Boolean),[...new Set([...prior.payload.taskIds,...taskIds])],id])).rows;
   for(const recipient of recipients){
    const messageId=randomUUID(),body=`Order "${payload.title}" changed from version ${prior.payload.version} to ${payload.version}. Changed fields: ${changed.join(', ')}. Current stage: ${payload.stage}. Read the current order (${id}) before continuing fulfillment or proposing delivery. Reassess affected plans; a cancelled order does not authorize continued delivery. Active objectives have not been automatically cancelled. Continue unrelated useful work. This internal notice is not external authorization.`;
    await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body) VALUES($1,'company',$2,'MESSAGE',$3,$4)",[messageId,recipient.id,'Customer order changed: '+payload.title,body]);
    await event(tx,'message.created',messageId,{senderId:'company',recipientId:recipient.id,orderId:id,orderVersion:payload.version},actor);
   }
  }
 }
 return {id,...payload,emailIds:canReadEmail?emailIds:[],emailReferencesHidden:!canReadEmail&&emailIds.length>0};
}
export async function orderRegister(tx:Pick<Tx,'query'>){
 const all=await records(tx),ledger=(await tx.query<Row>("SELECT id,kind,amount FROM ledger WHERE account='BUSINESS' AND kind IN ('REVENUE','REFUND')")).rows,customers=(await tx.query<Row>("SELECT id,label FROM email_entities WHERE kind='CUSTOMER'")).rows;
 const ledgerById=new Map(ledger.map(r=>[r.id,r])),customerById=new Map(customers.map(r=>[r.id,r.label]));
 return all.map(o=>{const p=o.payload;let revenue=0n,refunds=0n;for(const id of p.ledgerIds){const r=ledgerById.get(id);if(r?.kind==='REVENUE')revenue+=BigInt(r.amount);if(r?.kind==='REFUND')refunds+=BigInt(r.amount);}const net=revenue-refunds,price=parseUsd(p.priceUsd);return {id:o.id,title:p.title,customerId:p.customerId,customer:customerById.get(p.customerId)??p.customerId,stage:p.stage,employeeId:p.employeeId,experimentId:p.experimentId,dueAt:p.dueAt,priceMicroUsd:price.toString(),receivedMicroUsd:revenue.toString(),refundedMicroUsd:refunds.toString(),netReceivedMicroUsd:net.toString(),paymentState:net<0n?'NET_REFUND':price===0n?'NO_PRICE':net>=price?'COVERED':net>0n?'PARTIAL':'UNPAID',version:p.version,updatedAt:o.created_at};}).sort((a,b)=>new Date(b.updatedAt).getTime()-new Date(a.updatedAt).getTime());
}
export async function readOrder(tx:Pick<Tx,'query'>,id:string,actor:string){
 await permitted(tx,actor);const row=(await records(tx)).find(o=>o.id===id);if(!row)throw new DomainError('Order not found.');const summary=(await orderRegister(tx)).find(o=>o.id===id)!;
 const canReadEmail=await emailPermission(tx,actor,'can_read');
 const customerAddresses=canReadEmail?(await one(tx,"SELECT addresses FROM email_entities WHERE kind='CUSTOMER' AND id=$1",[row.payload.customerId])).addresses:[];
 const emails=canReadEmail?(await tx.query<Row>(`WITH seeds AS (SELECT id,mailbox,thread_id,rfc_message_id FROM email_messages WHERE id=ANY($1::text[])), matched AS (
 SELECT m.id,m.direction,m.status,m.provider_message_id,m.thread_id,m.content->>'subject' AS subject,m.received_at,m.created_at,
 CASE WHEN m.id=ANY($1::text[]) THEN 'EXPLICIT' WHEN EXISTS(SELECT 1 FROM seeds s WHERE s.mailbox=m.mailbox AND s.rfc_message_id IS NOT NULL AND s.rfc_message_id=ANY(regexp_split_to_array(concat_ws(' ',m.content->'headers'->>'in-reply-to',m.content->'headers'->>'references'),'[[:space:]]+'))) THEN 'REFERENCE' ELSE 'THREAD' END AS association
 FROM email_messages m WHERE m.id=ANY($1::text[]) OR EXISTS(SELECT 1 FROM seeds s WHERE s.mailbox=m.mailbox AND ((s.thread_id IS NOT NULL AND s.thread_id<>'' AND s.thread_id=m.thread_id) OR (s.rfc_message_id IS NOT NULL AND s.rfc_message_id=ANY(regexp_split_to_array(concat_ws(' ',m.content->'headers'->>'in-reply-to',m.content->'headers'->>'references'),'[[:space:]]+'))))))
 SELECT *,count(*) OVER()::integer AS total_matches FROM matched ORDER BY CASE WHEN association='EXPLICIT' THEN 0 ELSE 1 END,received_at DESC NULLS LAST,created_at DESC,id LIMIT 100`,[row.payload.emailIds])).rows:[];
 const receipts=(await tx.query<Row>('SELECT id,kind,amount::text AS amount,description,external_reference FROM ledger WHERE id=ANY($1::text[]) ORDER BY id',[row.payload.ledgerIds])).rows;
 const fulfillment=(await tx.query<Row>(`WITH latest AS (SELECT DISTINCT ON(entity_id) entity_id,payload FROM events WHERE type='backlog.updated' ORDER BY entity_id,sequence DESC) SELECT l.entity_id AS id,l.payload->>'title' AS title,l.payload->>'cancelled'='true' AS cancelled,s.payload->>'taskId' AS task_id,t.status AS task_status,t.operations_applied FROM latest l LEFT JOIN LATERAL (SELECT payload FROM events WHERE type='backlog.started' AND entity_id=l.entity_id AND payload->>'orderId'=$1 ORDER BY sequence DESC LIMIT 1) s ON true LEFT JOIN tasks t ON t.id=s.payload->>'taskId' WHERE l.payload->>'orderId'=$1 ORDER BY l.entity_id`,[id])).rows;
 const deliverables=[];for(const ref of row.payload.documentRefs??[]){const doc=await readDocument(tx,ref.path,ref.version);deliverables.push({path:doc.path,version:doc.version,currentVersion:doc.current_version,title:doc.title,authorId:doc.author_id,contentHash:createHash('sha256').update(doc.content).digest('hex')});}
 return {...summary,receipts,fulfillment,deliverables,customerAddresses,record:{...row.payload,emailIds:canReadEmail?row.payload.emailIds:[]},emails,correspondenceCount:emails[0]?.total_matches??0,emailReferencesHidden:!canReadEmail&&row.payload.emailIds.length>0,note:'Internal scope and workflow record. Payment coverage derives only from linked business revenue/refund ledger entries, without independent bank verification. Related correspondence uses thread/reference matching and may cover other work; inspect the message before relying on it. Up to100 messages are shown with explicit links first; use the mailbox reader for older correspondence. Email provider acceptance is not customer delivery or acceptance. Stage changes do not send mail, transfer money or establish consent.'};
}

/** Metadata discovery across the whole register, including closed orders. */
export async function findOrders(tx:Pick<Tx,'query'>,actor:string,search:string,before:string|null=null){
 await permitted(tx,actor);
 const all=(await orderRegister(tx)).sort((a,b)=>a.id.localeCompare(b.id));
 const query=search.toLowerCase(),matches=all.filter(o=>search==='*'||(o.title+' '+o.customer).toLowerCase().includes(query));
 const remaining=matches.filter(o=>before===null||o.id>before),page=remaining.slice(0,20);
 return {orders:page.map(o=>({id:o.id,title:o.title,customer:o.customer,stage:o.stage,employeeId:o.employeeId,dueAt:o.dueAt,paymentState:o.paymentState,version:o.version})),totalMatches:matches.length,nextBefore:remaining.length>20?page[19]!.id:null,indexRevision:createHash('sha256').update(JSON.stringify(all)).digest('hex'),note:'Metadata only, including closed and cancelled records. Read an ORDER by ID for scope, receipts and fulfillment. Pass nextBefore as before; restart paging if indexRevision changes. Customer and order records alone do not establish demand or payment.'};
}

/** Planning observations are time-sensitive; keep them out of versioned order read hashes. */
export function orderPlanningContext(register:Awaited<ReturnType<typeof orderRegister>>,now=new Date()) {
 const asOf=now.getTime(),day=24*60*60*1000;
 const open=register.filter(order=>!['CLOSED','CANCELLED'].includes(order.stage));
 const deadline=(order:typeof open[number])=>order.dueAt?new Date(order.dueAt).getTime():Infinity;
 const orders=[...open].sort((a,b)=>{
  const left=deadline(a),right=deadline(b);
  if(left!==right)return left<right?-1:1;
  return new Date(a.updatedAt).getTime()-new Date(b.updatedAt).getTime()||a.id.localeCompare(b.id);
 }).slice(0,30).map(order=>({...order,dueState:deadline(order)<asOf?'OVERDUE':deadline(order)<=asOf+day?'DUE_WITHIN_24_HOURS':order.dueAt?'UPCOMING':'NO_DUE_DATE'}));
 return {orders,summary:{asOf:now.toISOString(),open:open.length,overdue:open.filter(order=>deadline(order)<asOf).length,dueWithin24Hours:open.filter(order=>deadline(order)>=asOf&&deadline(order)<=asOf+day).length,unassigned:open.filter(order=>!order.employeeId).length,omitted:Math.max(0,open.length-orders.length),note:'Open-order observations, earliest due dates first. READY still needs fulfillment follow-through until closed. A deadline does not grant external authority or prove a contractual breach. Read the current order and coordinate existing assignments before creating duplicate work. ORDER_FIND searches the full register.'}};
}
