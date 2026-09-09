import {createHash} from 'node:crypto';
import {z} from 'zod';
import {event,one,type Tx} from './db.js';

export const businessEntityInput=z.object({
 kind:z.enum(['CAMPAIGN','PROSPECT','CUSTOMER','PROJECT','EXPERIMENT']),
 id:z.string().trim().min(1).max(250),label:z.string().trim().min(1).max(250),
 addresses:z.array(z.string().trim().email()).max(100),
 expected:z.object({label:z.string().min(1).max(250),addresses:z.array(z.string().email()).max(100)}).strict().nullish()
}).strict();

/** Internal address-book records. A matching address is association, not verified demand or consent. */
export async function saveBusinessEntity(tx:Tx,input:unknown,actor:string,taskId?:string){
 const x=businessEntityInput.parse(input);
 if(actor!=='owner'&&!(await tx.query("SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[actor])).rows.length)
  throw new Error('An active employee or owner must maintain business records.');
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 const addresses=[...new Set(x.addresses.map(a=>a.toLowerCase()))];
 const prior=(await tx.query<{label:string;addresses:string[]}>('SELECT label,addresses FROM email_entities WHERE kind=$1 AND id=$2',[x.kind,x.id])).rows[0];
 const fingerprint=(record:{label:string;addresses:string[]})=>JSON.stringify({label:record.label,addresses:[...new Set(record.addresses.map(a=>a.toLowerCase()))].sort()});
 const unchanged=prior&&fingerprint(prior)===fingerprint({label:x.label,addresses});
 if(prior&&!unchanged&&(!x.expected||fingerprint(prior)!==fingerprint(x.expected)))
  throw new Error('Business record changed or prior values were not supplied. Read the current record and provide expected label and addresses before editing.');
 if(!prior&&x.expected)throw new Error('Business record no longer exists. Read the register before creating a replacement.');
 await tx.query('INSERT INTO email_entities(kind,id,label,addresses) VALUES($1,$2,$3,$4) ON CONFLICT(kind,id) DO UPDATE SET label=$3,addresses=$4',
  [x.kind,x.id,x.label,JSON.stringify(addresses)]);
 // Also link messages received before the business record existed. Keep prior associations as history.
 const linked=await tx.query(`INSERT INTO email_links(message_id,kind,entity_id,source)
  SELECT m.id,$1,$2,'ADDRESS' FROM email_messages m WHERE EXISTS(
   SELECT 1 FROM jsonb_each(m.content) field,
   LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(field.value)='array' THEN field.value ELSE '[]'::jsonb END) address
   WHERE field.key IN ('from','to','cc','bcc') AND lower(address.value)=ANY($3::text[])
  ) ON CONFLICT DO NOTHING RETURNING message_id`,[x.kind,x.id,addresses]);
 await event(tx,'email.entity_updated',x.id,{kind:x.kind,label:x.label,addressCount:addresses.length,linkedMessages:linked.rows.length,taskId:taskId??null},actor);
 const {expected,...record}=x;
 return {...record,addresses,linkedMessages:linked.rows.length};
}

/** Full internal address-book search, returned in bounded prompt-sized pages. */
export async function findBusinessEntities(tx:Pick<Tx,'query'>,actor:string,target:string,offset=0) {
 if(!(await tx.query("SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[actor])).rows.length)
  throw new Error('Business record search requires an active employee.');
 z.string().trim().min(1).max(250).parse(target);
 z.number().int().min(0).max(1000000).parse(offset);
 const records=(await tx.query(`SELECT kind,id,label,addresses FROM email_entities
  WHERE $1='*' OR strpos(lower(concat_ws(' ',kind,id,label,addresses::text)),lower($1))>0
  ORDER BY kind,id`,[target])).rows;
 const value=JSON.stringify(records);
 if(offset>value.length)throw new Error('Business record offset is out of range.');
 const end=Math.min(offset+4000,value.length);
 return {content:value.slice(offset,end),offset,nextOffset:end<value.length?end:null,totalMatches:records.length,
  resultHash:createHash('sha256').update(value).digest('hex'),encoding:'JSON',
  note:'Concatenate pages with the same resultHash; restart if it changes. Search matches literal kind, ID, label or recorded address. These internal associations do not verify demand, payment, consent or permission to send. No external lookup was performed.'};
}
