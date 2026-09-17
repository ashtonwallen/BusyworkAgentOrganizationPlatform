import {type Tx,type Row} from './db.js';
import {missionExposure,missionProgress} from './mission-lifecycle.js';
export async function missionSummaries(tx:Pick<Tx,'query'>){
 const rows=(await tx.query<Row>('SELECT * FROM missions ORDER BY created_at DESC LIMIT 100')).rows;
 const summaries=[];
 for(const mission of rows){
  const exposure=await missionExposure(tx,mission.id),progress=await missionProgress(tx,mission.id);
  const completion=(await tx.query<Row>("SELECT payload FROM events WHERE type='mission.completion_requested' AND entity_id=$1 ORDER BY sequence DESC LIMIT 1",[mission.id])).rows[0]?.payload;
  const unresolved=(await tx.query<Row>("SELECT id,title FROM owner_requests WHERE mission_id=$1 AND status='OPEN' ORDER BY created_at",[mission.id])).rows;
  summaries.push({...mission,spentMicroUsd:exposure.spent.toString(),heldMicroUsd:exposure.held.toString(),progress,completion:completion??null,ownerRequests:unresolved});
 }
 return summaries;
}
