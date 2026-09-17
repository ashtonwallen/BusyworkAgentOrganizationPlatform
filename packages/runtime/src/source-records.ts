import {createHash,randomUUID} from 'node:crypto';
import {one,event,type Tx,type Row} from './db.js';
import {DomainError} from './service.js';

/** Only called with a confirmed tool result, in the same transaction as its receipt. */
export async function recordSource(tx:Tx,action:Row,result:any,now:Date){
 if(!result||typeof result!=='object')return null;
 const search=action.action_type==='SEARCH_WEB';
 if(!search&&(action.action_type!=='READ_PUBLIC_PAGE'||typeof result.text!=='string'))return null;
 const raw=search?JSON.stringify({query:result.query,results:result.results}):result.text;
 const content=raw.slice(0,32000),hash=createHash('sha256').update(content).digest('hex');
 const prior=(await tx.query<Row>('SELECT * FROM source_records WHERE action_id=$1',[action.id])).rows[0];
 if(prior){if(prior.content_hash!==hash)throw new DomainError('Source receipt content changed.');return prior.id as string;}
 const id=randomUUID();
 const url=search?(result.provider==='brave'?'https://api.search.brave.com/res/v1/web/search':'urn:search:'+String(result.provider)):action.target;
 await tx.query('INSERT INTO source_records(id,action_id,task_id,url,retrieved_at,content_hash,content,truncated,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [id,action.id,action.task_id,url,now,hash,content,raw.length>content.length||result.truncated===true,search?'SEARCH_RESULTS':'PAGE']);
 await event(tx,'source.recorded',id,{actionId:action.id,taskId:action.task_id,url,contentHash:hash});return id;
}
export async function sourceIndex(tx:Pick<Tx,'query'>,missionId:string|null){
 return (await tx.query<Row>('SELECT id,action_id,url,retrieved_at,content_hash,truncated,kind,trust FROM source_records WHERE mission_id=$1 ORDER BY retrieved_at DESC,id LIMIT 40',[missionId])).rows;
}
export async function readSource(tx:Pick<Tx,'query'>,id:string,offset=0){
 const record=await one(tx,'SELECT * FROM source_records WHERE id=$1',[id]);
 if(!Number.isInteger(offset)||offset<0||offset>record.content.length)throw new DomainError('Invalid source offset.');
 return {...record,content:record.content.slice(offset,offset+4000),offset,nextOffset:offset+4000<record.content.length?offset+4000:null,hashBasis:'Complete retained text; truncated indicates an incomplete page capture.'};
}
export async function claimsForDocument(tx:Pick<Tx,'query'>,id:string,version:number){
 const claims=(await tx.query<Row>('SELECT claim_index AS index,claim AS text,kind FROM document_claims WHERE document_id=$1 AND version=$2 ORDER BY claim_index',[id,version])).rows;
 const links=(await tx.query<Row>(`SELECT c.claim_index,s.id,s.url,s.retrieved_at,s.content_hash,s.truncated,s.kind,s.mission_id FROM claim_sources c JOIN source_records s ON s.id=c.source_id WHERE c.document_id=$1 AND c.version=$2 ORDER BY c.claim_index,s.id`,[id,version])).rows;
 return claims.map(claim=>({...claim,sources:links.filter(link=>link.claim_index===claim.index),uncited:!links.some(link=>link.claim_index===claim.index)}));
}
