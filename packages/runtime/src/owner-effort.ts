import type {Tx,Row} from './db.js';
/** Report recorded time only; never infer an hourly rate or total unrecorded effort. */
export async function ownerEffort(tx:Pick<Tx,'query'>){
 const groups=(await tx.query<Row>(`SELECT experiment_id,COUNT(*)::int AS resolved_requests,
 COUNT(*) FILTER(WHERE minutes>0)::int AS requests_with_time,COALESCE(SUM(minutes),0)::text AS minutes
 FROM owner_requests WHERE status IN ('DONE','DECLINED') GROUP BY experiment_id ORDER BY experiment_id NULLS FIRST`)).rows;
 return {minutes:groups.reduce((total,g)=>total+Number(g.minutes),0),resolvedRequests:groups.reduce((total,g)=>total+g.resolved_requests,0),requestsWithTime:groups.reduce((total,g)=>total+g.requests_with_time,0),byOpportunity:groups.map(g=>({experimentId:g.experiment_id,minutes:Number(g.minutes),resolvedRequests:g.resolved_requests,requestsWithTime:g.requests_with_time})),scope:'Recorded owner-request time only. Zero may mean no time was entered. No hourly rate or cash cost is inferred.'};
}
