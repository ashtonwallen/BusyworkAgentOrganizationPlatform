import {z} from 'zod';
import {type Tx,type Row} from './db.js';
export async function consultations(tx:Pick<Tx,'query'>,actor:string,scope='open',before?:string|null){
 z.enum(['open','all']).parse(scope);if(before)z.string().regex(/^[0-9]{1,20}$/).parse(before);
 if(actor!=='owner'&&!(await tx.query("SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[actor])).rows.length)throw new Error('Consultation access requires an active employee.');
 const rows=(await tx.query<Row>(`SELECT e.sequence::text AS cursor,e.entity_id AS task_id,e.created_at,e.payload->>'requesterId' AS requester_id,e.payload->>'employeeId' AS employee_id,e.payload->>'sourceTaskId' AS source_task_id,
 m.id AS request_message_id,LEFT(m.subject,250) AS subject,LEFT(m.body,300) AS question_preview,
 t.status AS task_status,t.expires_at,LEFT(t.error,300) AS error,r.id AS reply_message_id,
 CASE WHEN r.id IS NOT NULL THEN 'DELIVERED' WHEN t.status IN ('FAILED','EXPIRED','CANCELLED') THEN 'UNANSWERED' WHEN t.status='COMPLETED' THEN 'AWAITING_DELIVERY' ELSE 'PENDING' END AS response_status
 FROM events e JOIN tasks t ON t.id=e.entity_id LEFT JOIN messages m ON m.id=e.payload->>'messageId' LEFT JOIN messages r ON r.id='reply:'||t.id
 WHERE e.type='peer.reply_requested'
 AND ($1='owner' OR e.payload->>'requesterId'=$1 OR e.payload->>'employeeId'=$1)
 AND ($2='all' OR (r.id IS NULL AND t.status NOT IN ('FAILED','EXPIRED','CANCELLED')))
 AND ($3::bigint IS NULL OR e.sequence<$3::bigint)
 ORDER BY e.sequence DESC LIMIT 21`,[actor,scope,before??null])).rows;
 return {scope,items:rows.slice(0,20),nextBefore:rows.length>20?rows[19]!.cursor:null,note:'Delivery means a checked summary was sent, not that the requester accepted it or external work succeeded. Read request/reply messages for full context. Continue independent work while waiting.'};
}
