import {one,type Tx,type Row} from './db.js';
import {DomainError} from './service.js';
export async function remainingTaskAllocation(tx:Pick<Tx,'query'>,task:Row){
 const row=await one(tx,`SELECT
 (SELECT COALESCE(sum(budget),0) FROM tasks WHERE parent_id=$1 AND meeting_id IS NULL)+
 (SELECT COALESCE(sum(budget),0) FROM meetings WHERE source_task_id=$1 AND status<>'CANCELLED')+
 (SELECT COALESCE(sum(COALESCE(settled,0)+CASE WHEN status IN ('RESERVED','DISPATCHED','UNCERTAIN') THEN reserved ELSE 0 END),0) FROM calls WHERE task_id=$1)+
 (SELECT COALESCE(sum(amount),0) FROM ledger WHERE task_id=$1 AND call_id IS NULL AND account<>'TEST' AND kind='COST')+
 (SELECT COALESCE(sum(reservation),0) FROM actions WHERE task_id=$1 AND action_type<>'MODEL_CALL') AS money,
 (SELECT COALESCE(sum(token_budget),0) FROM tasks WHERE parent_id=$1 AND meeting_id IS NULL)+
 (SELECT COALESCE(sum(token_budget),0) FROM meetings WHERE source_task_id=$1 AND status<>'CANCELLED')+
 (SELECT COALESCE(sum(CASE WHEN status IN ('RESERVED','DISPATCHED','UNCERTAIN') OR (status='RECONCILED' AND (input_tokens IS NULL OR output_tokens IS NULL)) THEN token_reserved ELSE COALESCE(input_tokens,0)+COALESCE(output_tokens,0) END),0) FROM calls WHERE task_id=$1) AS tokens,
 EXISTS(SELECT 1 FROM tasks WHERE parent_id=$1) OR EXISTS(SELECT 1 FROM meetings WHERE source_task_id=$1 AND status<>'CANCELLED') AS has_delegation`,[task.id]);
 return {cost:BigInt(task.budget)-BigInt(row.money),tokens:task.token_budget-Number(row.tokens),enforced:!!task.parent_id||row.has_delegation};
}
export async function assertDelegatedSpend(tx:Pick<Tx,'query'>,taskId:string|null|undefined,maximum:bigint){
 if(!taskId)return;
 const task=await one(tx,'SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId]),remaining=await remainingTaskAllocation(tx,task);
 if(remaining.enforced&&maximum>remaining.cost)throw new DomainError('Delegated task allocation cannot cover this action while preserving parent money limits.');
}
