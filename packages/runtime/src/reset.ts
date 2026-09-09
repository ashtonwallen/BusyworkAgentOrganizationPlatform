import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import type {HiveService} from './service.js';
import {one,event,type Row} from './db.js';
import * as schema from './schema.js';
import {Workspaces} from './workspaces.js';

export async function resetPreview(service:HiveService){
 return service.db.transaction(async tx=>{
  const company=await one(tx,'SELECT status,revision FROM company WHERE id=1');
  const active=await one(tx,`SELECT (
   (SELECT count(*) FROM calls WHERE status IN ('RESERVED','DISPATCHED'))+
   (SELECT count(*) FROM actions WHERE status='EXECUTING')+
   (SELECT count(*) FROM email_messages WHERE status='DISPATCHING')+
   (SELECT count(*) FROM notifications WHERE status='DISPATCHED')+
   (SELECT count(*) FROM deployments WHERE status IN ('CREATING','ACTIVE'))
  )::integer AS count`);
  const counts=await one(tx,`SELECT (SELECT count(*) FROM tasks)::integer AS tasks,
   (SELECT count(*) FROM employees)::integer AS employees,(SELECT count(*) FROM ledger)::integer AS ledger,
   (SELECT count(*) FROM email_messages)::integer AS emails,(SELECT count(*) FROM documents)::integer AS documents`);
  return {status:company.status,revision:Number(company.revision),active:active.count,counts};
 });
}

/** Owner-only fresh business. Archive the entire schema atomically instead of disabling audit guards. */
export async function resetBusiness(service:HiveService,revision:number,workspaceBase:string){
 const archive='business_archive_'+randomUUID().replaceAll('-','');
 const oldWorkspace=service.workspaces?.root??null;
 const workspaceRoot=resolve(workspaceBase,archive);
 const result=await service.db.transaction(async tx=>{
  const company=await one(tx,'SELECT * FROM company WHERE id=1 FOR UPDATE');
  if(company.status==='RUNNING'||company.revision!==revision)throw new Error('Pause the company and review a fresh reset confirmation.');
  const active=await one(tx,`SELECT (
   (SELECT count(*) FROM calls WHERE status IN ('RESERVED','DISPATCHED'))+
   (SELECT count(*) FROM actions WHERE status='EXECUTING')+
   (SELECT count(*) FROM email_messages WHERE status='DISPATCHING')+
   (SELECT count(*) FROM notifications WHERE status='DISPATCHED')+
   (SELECT count(*) FROM deployments WHERE status IN ('CREATING','ACTIVE'))
  )::integer AS count`);
  if(active.count)throw new Error('Wait for active calls and outside actions to finish before resetting.');
  const modelSettings=(await tx.query<Row>(`SELECT DISTINCT ON(type,entity_id) type,entity_id,payload FROM events
   WHERE type IN ('model.profile_created','model.settings_updated','model.local_settings_updated','model.spending_caps_updated') ORDER BY type,entity_id,sequence DESC`)).rows;
  const mailbox=(await tx.query<Row>('SELECT * FROM email_mailboxes')).rows;
  const priorConstraints=(await tx.query<Row>("SELECT body FROM company_records WHERE title='Unresolved outside actions from archived run' AND kind='CONSTRAINT'")).rows;
  const unresolved=(await tx.query(`SELECT id,action_type AS kind,target,status FROM actions WHERE status IN ('UNCERTAIN','AWAITING_COST')
   UNION ALL SELECT id,'MODEL_CALL',model_id,status FROM calls WHERE status='UNCERTAIN'
   UNION ALL SELECT id,'EMAIL',content->>'subject',status FROM email_messages WHERE status='UNCERTAIN'
   UNION ALL SELECT id,'SMS',code,status FROM notifications WHERE status='UNCERTAIN'`)).rows;
  // The archive name is generated internally and contains only identifier-safe characters.
  await tx.exec(`ALTER SCHEMA public RENAME TO ${archive}; CREATE SCHEMA public; SET LOCAL search_path TO public;`);
  await tx.exec('CREATE TABLE hive_migrations(version INTEGER PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for(let version=1;version<=16;version++){
   await tx.exec((schema as Record<string,string>)['migration'+version]);
   if(version===1)await tx.query('INSERT INTO company(id,daily_cap) VALUES(1,10000000)');
   await tx.query('INSERT INTO hive_migrations(version) VALUES($1)',[version]);
  }
  const preserved=['daily_cap','live_cap','capital_allocation','max_depth','max_agents','max_concurrency','approval_policy','ceo_model_id','ceo_review_model_id','cycle_budget','cycle_tokens','cycle_interval_minutes'];
  await tx.query(`UPDATE company SET ${preserved.map((key,i)=>`${key}=$${i+1}`).join(',')},revision=$${preserved.length+1},status='PAUSED' WHERE id=1`,
   [...preserved.map(key=>key==='approval_policy'?JSON.stringify({...company[key],smsEnabled:false}):company[key]),Number(company.revision)+1]);
  for(const setting of modelSettings)await event(tx,setting.type,setting.entity_id,setting.payload,'owner');
  // Retain encrypted OAuth connection state and cursor; keep ingestion disabled until deliberately enabled.
  for(const row of mailbox){
   const columns=Object.keys(row);row.enabled=false;
   await tx.query(`INSERT INTO email_mailboxes(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(key=>row[key]));
  }
  if(unresolved.length||priorConstraints.length)await tx.query('INSERT INTO company_records(id,kind,title,body) VALUES($1,$2,$3,$4)',[
   randomUUID(),'CONSTRAINT','Unresolved outside actions from archived run',
   'These prior actions have no confirmed final outcome. Do not retry or replace them without owner authorization. Real charges and commitments remain possible. Original records are retained in '+archive+'.\n'+JSON.stringify(unresolved)+'\n'+priorConstraints.map(r=>r.body).join('\n')]);
  await event(tx,'company.reset','company',{archive,oldWorkspace,workspaceRoot,unresolvedCount:unresolved.length,status:'PAUSED'},'owner');
  return {archive,status:'PAUSED',unresolvedCount:unresolved.length};
 });
 service.workspaces=new Workspaces(workspaceRoot);
 return result;
}
