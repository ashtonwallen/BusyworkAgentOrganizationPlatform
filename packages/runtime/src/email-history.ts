import {z} from 'zod';
import {emailQueueStatus} from './email-status.js';
import {createHash} from 'node:crypto';
import type {Tx,Row} from './db.js';
import {DomainError} from './service.js';
import {emailPermission} from './email.js';
import {businessMailbox} from './email-provider.js';

/** Read persisted mailbox data only; no provider request or send authority. */
export async function readBusinessEmail(tx:Pick<Tx,'query'>,actor:string,target:string,before?:string|null,offset=0,search=''){
 if(!await emailPermission(tx,actor,'can_read'))throw new DomainError('Business-email read permission is required.');
 search=z.string().trim().max(250).parse(search);
 if(target==='inbox'){
  if(before&&!(await tx.query('SELECT id FROM email_messages WHERE id=$1 AND mailbox=$2',[before,businessMailbox])).rows.length)throw new DomainError('Email cursor is unavailable.');
  const rows=(await tx.query<Row>(`SELECT id,direction,status,thread_id,provider_message_id,content->>'subject' AS subject,
   content->'from' AS sender,content->'to' AS recipients,content->'cc' AS cc_recipients,content->'bcc' AS bcc_recipients,error,received_at,created_at
   FROM email_messages WHERE mailbox=$1
   AND ($3='' OR strpos(lower(concat_ws(' ',content->>'subject',content->>'text',(content->'from')::text,(content->'to')::text,(content->'cc')::text,(content->'bcc')::text)),lower($3))>0)
   AND ($2::text IS NULL OR (COALESCE(received_at,created_at),id)<(SELECT COALESCE(received_at,created_at),id FROM email_messages WHERE id=$2))
   ORDER BY COALESCE(received_at,created_at) DESC,id DESC LIMIT 31`,[businessMailbox,before??null,search])).rows;
  const visible=rows.slice(0,30),queue=visible.some(m=>m.status==='QUEUED')?await emailQueueStatus(tx,new Date()):{};
  return {search,messages:visible.map(m=>({...m,queueStatus:queue[m.id]})),nextBefore:rows.length>30?rows[29]!.id:null,note:'Queue reasons describe current control state, not sending authority. Continue independent work while dependencies wait. Use messageBefore to read older metadata, or target a message ID to read its content.'};
 }
 if(!Number.isInteger(offset)||offset<0||offset>10000000)throw new DomainError('Email result offset is out of range.');
 const message=(await tx.query<Row>(`SELECT m.id,m.direction,m.status,m.thread_id,m.provider_message_id,m.rfc_message_id,m.received_at,m.created_at,m.content,
  (SELECT COALESCE(jsonb_agg(l ORDER BY l.kind,l.entity_id),'[]') FROM email_links l WHERE l.message_id=m.id) AS links
  FROM email_messages m WHERE m.id=$1 AND m.mailbox=$2`,[target,businessMailbox])).rows[0];
 if(!message)throw new DomainError('Email is unavailable.');
 const queueStatus=message.status==='QUEUED'?(await emailQueueStatus(tx,new Date()))[message.id]:undefined;
 const serialized=JSON.stringify(message);
 if(offset>serialized.length)throw new DomainError('Email result offset is out of range.');
 const end=Math.min(offset+4000,serialized.length);
 return {emailId:target,queueStatus,content:serialized.slice(offset,end),offset,totalCharacters:serialized.length,
  contentHash:createHash('sha256').update(serialized).digest('hex'),nextOffset:end<serialized.length?end:null,complete:offset===0&&end===serialized.length,
  sourceBodyTruncated:message.content?.bodyTruncated===true,
  note:'Concatenate content pages in offset order with the same contentHash, then parse JSON. If the hash changes, restart at offset 0. queueStatus is a separate current queue observation and is not part of the stored-content hash. Reread it before relying on a prior observation; it grants no sending authority. All pages cover stored content only; sourceBodyTruncated means ingestion did not retain the whole original body. Attachment metadata alone is not file content. textCacheStatus=CACHED identifies stored text available through IMPORT_EMAIL_ATTACHMENT.'};
}
