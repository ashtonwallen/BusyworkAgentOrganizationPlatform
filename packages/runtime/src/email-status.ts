import {staleOrderEmails} from './order-email-status.js';
import type {Tx,Row} from './db.js';

/** Read-only queue explanation. Dispatch still rechecks authority under its lock. */
export async function emailQueueStatus(db:Pick<Tx,'query'>,now:Date){
 const rows=(await db.query<Row>(`SELECT m.id,a.status AS action_status,a.expires_at,
 a.task_id,a.revises_action_id,t.status AS task_status,t.expires_at AS task_expires,
 c.status AS company_status,c.approval_policy,c.max_concurrency,
 b.enabled,(b.credential_ciphertext IS NOT NULL) AS connected,b.daily_send_limit,
 (m.author_id='owner' OR (e.status='ACTIVE' AND COALESCE(p.can_send,e.role='CEO'))) AS permitted,
 EXISTS(SELECT 1 FROM approvals ap WHERE ap.action_id=a.id AND ap.decision='APPROVE' AND ap.action_hash=a.action_hash) AS approved,
 (SELECT COUNT(*) FROM email_messages sent WHERE sent.mailbox=m.mailbox AND sent.dispatched_at>=date_trunc('day',$1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS daily_used,
 ((SELECT COUNT(*) FROM calls WHERE status IN ('RESERVED','DISPATCHED'))+(SELECT COUNT(*) FROM actions WHERE status='EXECUTING'))::int AS occupied
 FROM email_messages m CROSS JOIN company c
 LEFT JOIN actions a ON a.id=m.action_id LEFT JOIN tasks t ON t.id=a.task_id
 LEFT JOIN email_mailboxes b ON b.address=m.mailbox
 LEFT JOIN employees e ON e.id=m.author_id LEFT JOIN email_permissions p ON p.employee_id=e.id
 WHERE m.status='QUEUED' AND c.id=1`,[now])).rows;
 const stale=await staleOrderEmails(db);
 return Object.fromEntries(rows.map(r=>{
  const reasons:{code:string;message:string}[]=[];
  const add=(code:string,message:string)=>reasons.push({code,message});
  if(stale.has(r.id))add('ORDER_CHANGED','The linked order scope, price, deadline, deliverables or cancellation state changed. Review the current order and prepare a new proposal. This draft will not be sent.');
  if(!['PENDING','APPROVED'].includes(r.action_status))add('ACTION_UNAVAILABLE','The email proposal is no longer pending or approved.');
  if(r.expires_at&&new Date(r.expires_at)<=now)add('EXPIRED','The email proposal has expired. It will not be sent.');
  if(r.task_id&&(!r.task_status||['CANCELLED','EXPIRED'].includes(r.task_status)||new Date(r.task_expires)<=now))add('SOURCE_INACTIVE','The originating objective was cancelled or expired.');
  if(!r.permitted)add('PERMISSION_REQUIRED','The author no longer has permission to send business email.');
  if(r.action_status==='APPROVED'&&!r.approved)add('APPROVAL_INVALID','No matching approval exists for this exact email.');
  if(r.action_status==='PENDING'&&(r.revises_action_id || r.approval_policy.communications!==false))add('AWAITING_APPROVAL','Owner approval is required. Open Waiting on you to review the proposal.');
  if(!r.connected)add('CONNECTION_REQUIRED','Connect Google Workspace in Business email.');
  if(!r.enabled)add('MAILBOX_DISABLED','Enable the mailbox in Email settings.');
  if(r.company_status!=='RUNNING')add('COMPANY_STOPPED','The company must be running to send email.');
  if(r.daily_used>=r.daily_send_limit)add('DAILY_LIMIT','The daily email send limit is reached. It resets at midnight UTC.');
  if(r.occupied>=r.max_concurrency)add('WAITING_FOR_CAPACITY','Waiting for an available execution slot.');
  return [r.id,{reasons,message:reasons.length?reasons.map(x=>x.message).join(' '):'Queued for the next email worker check. Provider and integrity checks still apply.'}];
 }));
}
