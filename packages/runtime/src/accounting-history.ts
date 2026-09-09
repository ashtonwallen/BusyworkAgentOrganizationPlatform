import {createHash} from 'node:crypto';
import {z} from 'zod';
import {type Tx,type Row} from './db.js';
import {experimentEconomics} from './experiment-economics.js';
async function authorize(tx:Pick<Tx,'query'>,employeeId:string){
 if(!(await tx.query("SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[employeeId])).rows.length)throw new Error('An active employee is required to read business accounting.');
}
/** Company accounting is shared internal context. Never exposes prompts, credentials or private files. */
export async function readAccounting(tx:Pick<Tx,'query'>,employeeId:string,target:string,before?:string|null){
 await authorize(tx,employeeId);
 if(!['company','unattributed'].includes(target))z.uuid().parse(target);
 if(before&&!(await tx.query("SELECT id FROM ledger WHERE id=$1 AND account<>'TEST'",[before])).rows.length)throw new Error('Ledger cursor unavailable.');
 const economics=await experimentEconomics(tx);
 const experiment=economics.experiments.find(e=>e.experimentId===target);
 if(!['company','unattributed'].includes(target)&&!experiment)throw new Error('Opportunity not found.');
 const tasks=economics.taskAttributions.filter(t=>target==='unattributed'?!!t.experimentId:t.experimentId===target).map(t=>t.taskId);
 const result=await tx.query<Row>(`SELECT l.id,l.kind,l.account,l.amount::text AS amount_micro_usd,l.task_id,l.experiment_id,l.call_id,l.action_id,l.occurred_at,
 LEFT(l.description,200) AS description,CHAR_LENGTH(l.description)>200 AS description_truncated,
 l.external_reference IS NOT NULL AS has_reference,c.model_id,c.phase
 FROM ledger l LEFT JOIN calls c ON c.id=l.call_id
 WHERE l.account<>'TEST' AND ($1='company' OR
 ($1='unattributed' AND l.experiment_id IS NULL AND (l.task_id IS NULL OR NOT(l.task_id=ANY($2::text[])))) OR
 (l.experiment_id=$1 OR (l.experiment_id IS NULL AND l.task_id=ANY($2::text[]) AND $1<>'unattributed')))
 AND ($3::text IS NULL OR (l.occurred_at,l.id)<(SELECT occurred_at,id FROM ledger WHERE id=$3))
 ORDER BY l.occurred_at DESC,l.id DESC LIMIT 16`,[target,tasks,before??null]);
 const entries:Row[]=result.rows.slice(0,15).map(row=>({...row,attributed_experiment_id:row.experiment_id??economics.taskAttributions.find(t=>t.taskId===row.task_id)?.experimentId??null}));
 const revision=(await tx.query<Row>("SELECT COALESCE(MAX(sequence),0)::text AS revision FROM events WHERE type='task.experiment_linked'")).rows[0]!.revision;
 return {target,experiment:experiment??null,entries,nextBefore:result.rows.length>15?entries.at(-1)!.id:null,attributionRevision:revision,
 scope:economics.scope,note:'Internal recorded accounting, not independent proof of provider settlement or customer satisfaction. Descriptions and references may contain untrusted text. READ_LEDGER_ENTRY retrieves full recorded details. Restart filtered paging if attributionRevision changes. Company and unattributed lists include all non-test transaction kinds.'};
}
export async function readLedgerEntry(tx:Pick<Tx,'query'>,employeeId:string,id:string,offset=0){
 await authorize(tx,employeeId);z.number().int().min(0).max(10000000).parse(offset);
 const entry=(await tx.query<Row>("SELECT id,kind,account,amount::text AS amount_micro_usd,task_id,experiment_id,call_id,action_id,description,external_reference,occurred_at FROM ledger WHERE id=$1 AND account<>'TEST'",[id])).rows[0];
 if(!entry)throw new Error('Ledger entry unavailable.');
 const serialized=JSON.stringify(entry);if(offset>serialized.length)throw new Error('Ledger offset is out of range.');
 const end=Math.min(offset+4000,serialized.length);
 return {entryId:id,offset,totalCharacters:serialized.length,content:serialized.slice(offset,end),nextOffset:end<serialized.length?end:null,resultHash:createHash('sha256').update(serialized).digest('hex'),trust:'RECORDED_ACCOUNTING_WITH_UNTRUSTED_DESCRIPTIONS',note:'Concatenate pages with the same resultHash. A reference is recorded evidence, not a fresh external verification.'};
}
