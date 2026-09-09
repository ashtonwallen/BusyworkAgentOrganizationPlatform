import {randomUUID} from 'node:crypto';
import {parseUsd} from '@hive/core';
import {one,event,type Tx,type Row} from './db.js';
import type {HiveService} from './service.js';

export async function queueCallReconciliations(service:HiveService){
 await service.db.transaction(async tx=>{
  const company=await one(tx,'SELECT * FROM company WHERE id=1 FOR UPDATE');
  if(company.status==='KILLED')return;
  const employee=(await tx.query<Row>("SELECT id,model_id FROM employees WHERE role='CEO' AND status='ACTIVE'")).rows[0];
  if(!employee)return;
  const calls=(await tx.query<Row>(`SELECT c.id,c.provider,c.model_id FROM calls c WHERE c.status='UNCERTAIN'
   AND NOT EXISTS(SELECT 1 FROM events e WHERE e.type='call.reconciliation_queued' AND e.entity_id=c.id)
   AND NOT EXISTS(SELECT 1 FROM events e WHERE e.type='call.reconciliation_queued' AND e.payload->>'taskId' IN (c.task_id,(SELECT root_id FROM tasks WHERE id=c.task_id)))
   ORDER BY c.created_at LIMIT 10`)).rows;
  for(const call of calls){
   const id=randomUUID();
   const objective=`Investigate original model call ${call.id} (${call.provider}/${call.model_id}). Use reconciliationCase, which contains the recorded original call and frozen pricing. Resolve accounting from evidence, never guess token usage or a paid charge. A zero-priced local call may use RECONCILE_LOCAL_CALL; that records zero configured token fees while retaining unknown usage and retries only the original internal inference task when safe. It does not repeat any external business action. For paid calls, identify the specific missing provider receipt or access, continue other authorized work, and request owner help only when that information cannot be obtained internally. Do not initiate a replacement paid call or change provider caps to resolve this case. Return a concise findings memo.`;
   await tx.query(`INSERT INTO tasks(id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id,employee_id)
    VALUES($1,$1,$2,'Call reconciliation',0,'PLAN_PENDING',$3,$4,$5,$6,NULL,$7)`,
    [id,objective,company.cycle_budget,company.cycle_tokens,new Date(service.now().getTime()+86400000),employee.model_id,employee.id]);
   await event(tx,'call.reconciliation_queued',call.id,{taskId:id,employeeId:employee.id,provider:call.provider},'system');
  }
 });
}

export async function reconciliationCase(tx:Pick<Tx,'query'>,taskId:string){
 return (await tx.query<Row>(`WITH RECURSIVE lineage AS (
  SELECT id,parent_id FROM tasks WHERE id=$1 UNION SELECT t.id,t.parent_id FROM tasks t JOIN lineage l ON l.parent_id=t.id
 ) SELECT c.id,c.task_id,c.provider,c.model_id,c.status,c.is_live,c.pricing,
  c.reserved,c.settled,c.input_tokens,c.output_tokens,c.request_id,c.error,c.created_at,c.completed_at,
  c.result IS NOT NULL AS has_stored_response
  FROM events e JOIN calls c ON c.id=e.entity_id JOIN lineage l ON l.id=e.payload->>'taskId' WHERE e.type='call.reconciliation_queued' LIMIT 1`,[taskId])).rows[0];
}

export async function reconcileLocalCall(tx:Tx,taskId:string,callId:string,actor:string){
 const link=await reconciliationCase(tx,taskId);
 if(!link||link.id!==callId)throw new Error('This task is not assigned to investigate that call.');
 const call=await one(tx,'SELECT * FROM calls WHERE id=$1 FOR UPDATE',[callId]);
 if(call.status==='RECONCILED')return;
 if(call.status!=='UNCERTAIN'||call.provider!=='lmstudio'||call.is_live||BigInt(call.reserved)!==0n||!call.pricing
  ||parseUsd(call.pricing.inputPerMillionUsd)!==0n||parseUsd(call.pricing.outputPerMillionUsd)!==0n)
  throw new Error('Automatic reconciliation requires a local call with frozen zero token prices. Paid or unproven charges require provider evidence.');
 await tx.query("UPDATE calls SET status='RECONCILED',settled=0 WHERE id=$1",[callId]);
 await tx.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,task_id,call_id,description) VALUES($1,$2,'OPERATING','COST',0,$3,$4,$5)",
  [randomUUID(),'call:'+callId,call.task_id,callId,'Agent reconciliation: frozen local token prices are zero; response and token usage remain unconfirmed.']);
 // Inference only produces a proposed artifact. No external operations from the lost response were applied.
 // Stop repeated local failures instead of creating an endless automatic retry loop.
 const failures=await one(tx,"SELECT count(*)::integer AS count FROM calls WHERE task_id=$1 AND error IS NOT NULL AND provider='lmstudio'",[call.task_id]);
 const changed=await tx.query(`UPDATE tasks SET status=CASE WHEN $2 THEN CASE phase WHEN 'PLAN' THEN 'PLAN_PENDING' WHEN 'REVIEW' THEN 'REVIEW' ELSE 'READY' END ELSE 'FAILED' END,
  error=CASE WHEN $2 THEN NULL ELSE 'Repeated local inference failures; supervisor should adjust the model or assignment.' END,updated_at=now()
  WHERE id=$1 AND status='BLOCKED_APPROVAL' AND expires_at>now()
  AND NOT EXISTS(SELECT 1 FROM calls WHERE task_id=$1 AND status IN ('RESERVED','DISPATCHED','UNCERTAIN')) RETURNING id`,[call.task_id,failures.count<3]);
 await event(tx,'call.reconciled',callId,{amountUsd:'0',basis:'FROZEN_LOCAL_ZERO_PRICES',usageKnown:false,taskId,sourceTaskRequeued:changed.rows.length>0&&failures.count<3},actor);
}
