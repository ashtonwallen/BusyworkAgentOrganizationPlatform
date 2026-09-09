import {z} from 'zod';
import {documentPath,readDocument} from './documents.js';
import {prepareStaticRelease} from './netlify.js';
import {actionHash,DomainError} from './service.js';
import {event,type Tx,type Row} from './db.js';
export const releaseInput=z.object({requestId:z.uuid(),title:z.string().trim().min(1).max(250),siteId:z.uuid(),files:z.array(z.object({path:z.string().min(1).max(180),documentPath:z.lazy(()=>documentPath),version:z.number().int().min(1)}).strict()).min(1).max(50)}).strict();
/** Caller holds the company lock. Preparing a release never authorizes publication. */
export async function createStaticRelease(tx:Tx,raw:unknown,authorId:string,taskId?:string){
 const x=releaseInput.parse(raw);const fingerprint=actionHash({input:x,authorId,taskId:taskId??null});
 const prior=(await tx.query<Row>('SELECT * FROM static_releases WHERE id=$1',[x.requestId])).rows[0];
 if(prior){if(prior.request_hash!==fingerprint)throw new DomainError('Release request ID already belongs to different content.',409);return prior;}
 if(authorId!=='owner' && !(await tx.query("SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[authorId])).rows.length)throw new DomainError('Only the owner or an active employee can prepare a release.');
 if(taskId && !(await tx.query("SELECT id FROM tasks WHERE id=$1 AND (employee_id=$2 OR $2='owner')",[taskId,authorId])).rows.length)throw new DomainError('Release task does not belong to this author.');
 const sources=[];const files=[];
 for(const file of x.files){const document=await readDocument(tx,file.documentPath,file.version);sources.push({path:file.path,documentId:document.id,documentPath:document.path,version:document.version});files.push({path:file.path,content:document.content});}
 const manifest=prepareStaticRelease({siteId:x.siteId,files});
 const row=(await tx.query<Row>(`INSERT INTO static_releases(id,title,provider,site_id,manifest,content_hash,source_versions,request_hash,author_id,task_id) VALUES($1,$2,'netlify',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[x.requestId,x.title,x.siteId,JSON.stringify(manifest),manifest.sha256,JSON.stringify(sources),fingerprint,authorId,taskId??null])).rows[0];
 await event(tx,'release.prepared',x.requestId,{title:x.title,siteId:x.siteId,contentHash:manifest.sha256,fileCount:files.length},authorId);return row;
}

/** A release-bound proposal stays owner-assisted even after adapters are installed. */
export async function staticPublication(tx:Tx,releaseId:string,target:string){
 const id=z.uuid().parse(releaseId);
 const release=await oneRelease(tx,id);
 if(target!==release.site_id)throw new DomainError('Publishing destination must match the prepared release site ID.');
 return {releaseId:id,releaseHash:release.content_hash,siteId:release.site_id,provider:'netlify',environment:'production',executorVersion:1,executionMode:'OWNER_ASSISTED'};
}
async function oneRelease(tx:Tx,id:string){
 const row=(await tx.query<Row>('SELECT * FROM static_releases WHERE id=$1',[id])).rows[0];
 if(!row)throw new DomainError('Prepared release not found.',404);
 return row;
}
