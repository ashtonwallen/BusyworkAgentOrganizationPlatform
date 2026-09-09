import {one,event,type Tx,type Row} from './db.js';
import {readTaskResult} from './task-results.js';

export async function linkTaskExperiment(tx:Tx,taskId:string,experimentId:string|null,actor:string){
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');await one(tx,'SELECT id FROM tasks WHERE id=$1',[taskId]);
 if(actor!=='owner')await readTaskResult(tx,actor,taskId);
 if(experimentId)await one(tx,'SELECT id FROM experiments WHERE id=$1',[experimentId]);
 const previous=(await tx.query<Row>("SELECT payload FROM events WHERE type='task.experiment_linked' AND entity_id=$1 ORDER BY sequence DESC LIMIT 1",[taskId])).rows[0];
 if(previous&&previous.payload.experimentId===experimentId)return;
 await event(tx,'task.experiment_linked',taskId,{experimentId},actor);
}
/** Explicit accounting tags only. Nearest tagged ancestor supplies a default; null opts out. */
export async function experimentEconomics(tx:Pick<Tx,'query'>){
 const tasks=(await tx.query<Row>('SELECT id,parent_id FROM tasks')).rows;
 const parents=new Map(tasks.map(t=>[t.id,t.parent_id]));
 const tags=(await tx.query<Row>("SELECT DISTINCT ON(entity_id) entity_id,payload FROM events WHERE type='task.experiment_linked' ORDER BY entity_id,sequence DESC")).rows;
 const explicit=new Map(tags.map(t=>[t.entity_id,t.payload.experimentId as string|null]));
 const memo=new Map<string,string|null>();
 const attribution=(id:string|null):string|null=>{
  if(!id)return null;if(memo.has(id))return memo.get(id)!;
  const visited=new Set<string>();let cursor:string|null=id,result:string|null=null;
  while(cursor&&!visited.has(cursor)){visited.add(cursor);if(explicit.has(cursor)){result=explicit.get(cursor)!;break;}cursor=parents.get(cursor)??null;}
  memo.set(id,result);return result;
 };
 const rows=(await tx.query<Row>('SELECT id FROM experiments')).rows;
 const totals=new Map(rows.map(e=>[e.id,{experimentId:e.id,revenue:0n,refunds:0n,modelCosts:0n,otherCosts:0n,reservedModelCosts:0n,unresolvedCalls:0,ownerMinutes:0}]));
 let unattributedModelCosts=0n;
 const ledger=(await tx.query<Row>("SELECT experiment_id,task_id,kind,call_id IS NOT NULL AS model_cost,SUM(amount)::text AS amount FROM ledger WHERE account<>'TEST' GROUP BY experiment_id,task_id,kind,call_id IS NOT NULL")).rows;
 for(const entry of ledger){
  const experimentId=entry.experiment_id??attribution(entry.task_id),total=totals.get(experimentId),amount=BigInt(entry.amount);
  if(!total){if(entry.kind==='COST'&&entry.model_cost)unattributedModelCosts+=amount;continue;}
  if(entry.kind==='REVENUE')total.revenue+=amount;else if(entry.kind==='REFUND')total.refunds+=amount;else if(entry.kind==='COST'){if(entry.model_cost)total.modelCosts+=amount;else total.otherCosts+=amount;}
 }
 const holds=(await tx.query<Row>("SELECT task_id,SUM(reserved)::text AS reserved,COUNT(*)::int AS count FROM calls WHERE provider<>'mock' AND status IN ('RESERVED','DISPATCHED','UNCERTAIN') GROUP BY task_id")).rows;
 for(const hold of holds){const total=totals.get(attribution(hold.task_id));if(total){total.reservedModelCosts+=BigInt(hold.reserved);total.unresolvedCalls+=hold.count;}}
 const effort=(await tx.query<Row>("SELECT experiment_id,SUM(minutes)::text AS minutes FROM owner_requests WHERE status IN ('DONE','DECLINED') AND experiment_id IS NOT NULL GROUP BY experiment_id")).rows;
 for(const row of effort){const total=totals.get(row.experiment_id);if(total)total.ownerMinutes=Number(row.minutes);}
 return {experiments:[...totals.values()].map(t=>({experimentId:t.experimentId,revenueMicroUsd:t.revenue.toString(),refundsMicroUsd:t.refunds.toString(),modelCostsMicroUsd:t.modelCosts.toString(),otherCostsMicroUsd:t.otherCosts.toString(),netMicroUsd:(t.revenue-t.refunds-t.modelCosts-t.otherCosts).toString(),reservedModelCostsMicroUsd:t.reservedModelCosts.toString(),unresolvedCalls:t.unresolvedCalls,ownerMinutes:t.ownerMinutes})),unattributedModelCostsMicroUsd:unattributedModelCosts.toString(),taskAttributions:tasks.map(t=>({taskId:t.id,experimentId:attribution(t.id),explicit:explicit.has(t.id)})),scope:'Ledger experiment tags take precedence; otherwise explicit task tags inherit down delegation. Model reservations are not settled expenses. Owner minutes are recorded request time only, without an inferred hourly cost. Untagged costs are not guessed.'};
}

export async function experimentEconomicsContext(tx:Pick<Tx,'query'>,taskId:string){
 const {taskAttributions,...report}=await experimentEconomics(tx);
 return {...report,currentTaskExperimentId:taskAttributions.find(t=>t.taskId===taskId)?.experimentId??null};
}
