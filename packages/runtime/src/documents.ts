import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { event, type Tx, type Row } from './db.js';
import { DomainError } from './service.js';

export const documentPath = z.string().trim().min(1).max(250).regex(/^[a-zA-Z0-9][a-zA-Z0-9_. /-]*$/)
  .refine(path => path.split('/').every(part => part.trim() === part && part.length > 0 && part !== '.' && part !== '..'), 'Use a relative document path without dot segments.');
export const documentInput = z.object({path:documentPath,title:z.string().trim().min(1).max(250),content:z.string().min(1).max(12000),expectedVersion:z.number().int().min(0)}).strict();

/** Caller holds the company lock: owner writes and agent operations serialize together. */
export async function writeDocument(tx:Tx,raw:unknown,authorId:string,taskId?:string) {
 const x=documentInput.parse(raw);
 if(authorId !== 'owner' && !(await tx.query("SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[authorId])).rows.length) throw new DomainError('Only the owner or an active employee can write shared documents.');
 const prior=(await tx.query<Row>('SELECT * FROM documents WHERE path=$1 FOR UPDATE',[x.path])).rows[0];
 if((prior?.version ?? 0)!==x.expectedVersion)throw new DomainError('This document has changed. Read the latest version before saving your edits.',409);
 const id=prior?.id ?? randomUUID(),version=(prior?.version ?? 0)+1;
 if(prior) await tx.query('UPDATE documents SET title=$2,version=$3,updated_by=$4,updated_at=now() WHERE id=$1',[id,x.title,version,authorId]);
 else await tx.query('INSERT INTO documents(id,path,title,version,updated_by) VALUES($1,$2,$3,$4,$5)',[id,x.path,x.title,version,authorId]);
 await tx.query('INSERT INTO document_versions(document_id,version,title,content,author_id,task_id) VALUES($1,$2,$3,$4,$5,$6)',[id,version,x.title,x.content,authorId,taskId ?? null]);
 await event(tx,'document.saved',id,{path:x.path,title:x.title,version,taskId:taskId ?? null},authorId);
 return {id,path:x.path,version};
}
export async function readDocument(tx:Pick<Tx,'query'>,path:string,version?:number) {
 path=documentPath.parse(path);
 const record=(await tx.query<Row>(`SELECT d.id,d.path,d.version AS current_version,v.version,v.title,v.content,v.author_id,v.task_id,v.created_at
 FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.version=COALESCE($2,d.version) WHERE d.path=$1`,[path,version ?? null])).rows[0];
 if(!record)throw new DomainError('Document or version not found.',404);
 return record;
}
export async function documentIndex(tx:Pick<Tx,'query'>,search='') {
 return (await tx.query<Row>(`SELECT id,path,title,version,updated_by,updated_at FROM documents
 WHERE path ILIKE $1 OR title ILIKE $1 ORDER BY path LIMIT 200`,['%'+search+'%'])).rows;
}

/** Hydrate explicitly named shared documents, never infer missing content or authority. */
export async function taskDocuments(tx:Pick<Tx,'query'>, task:Row) {
 const references=new Map<string,number|undefined>();
 for(const op of task.artifact?.operations??[]){
  if(['READ_DOCUMENT','WRITE_DOCUMENT'].includes(op.type)&&typeof op.target==='string')references.set(op.target,op.expectedVersion>0?op.expectedVersion:undefined);
 }
 const context=JSON.stringify({objective:task.objective,plan:task.plan});
 const index=(await tx.query<Row>('SELECT path FROM documents ORDER BY length(path) DESC,path')).rows;
 for(const doc of index)if(context.includes(doc.path)&&!references.has(doc.path))references.set(doc.path,undefined);
 const selected=[...references].slice(0,3),documents=[];
 for(const [path,version] of selected){
  try{const doc=await readDocument(tx,path,version);documents.push({path:doc.path,version:doc.version,currentVersion:doc.current_version,title:doc.title,content:doc.content,complete:true,trust:'REFERENCE_ONLY_NOT_AUTHORIZATION'});}
  catch(error){if(!(error instanceof DomainError))throw error;documents.push({path,version:version??null,complete:false,reason:'Requested document or version unavailable; do not infer its contents.'});}
 }
 return {documents,omittedReferences:Math.max(0,references.size-selected.length)};
}
