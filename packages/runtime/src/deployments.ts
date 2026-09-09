import {randomUUID} from 'node:crypto';
import {parseUsd} from '@hive/core';
import {usd,shortText,text} from './contracts.js';
import {z} from 'zod';
import {one,event,type Tx,type Row} from './db.js';
import {DomainError} from './service.js';

const receiptSchema=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),siteId:z.uuid(),state:z.string().min(1).max(100),url:z.url().refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;}).optional(),required:z.array(z.string().regex(/^[a-f0-9]{40}$/)).max(50)}).strict();
/** Journal only. The caller admits and reserves the approved action before this call.
 * Commit its transaction before making the single creation POST. An existing record
 * never grants permission to repeat creation, even when no provider ID was saved. */
export async function claimDeploymentCreation(tx:Tx,actionId:string,now=new Date()){
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 const prior=(await tx.query<Row>('SELECT * FROM deployments WHERE action_id=$1',[actionId])).rows[0];
 if(prior)return {claimed:false,deployment:prior};
 const company=await one(tx,'SELECT status FROM company WHERE id=1');
 const action=await one(tx,'SELECT * FROM actions WHERE id=$1 FOR UPDATE',[actionId]);
 if(company.status!=='RUNNING'||action.status!=='EXECUTING'||new Date(action.expires_at)<=now)throw new DomainError('Deployment needs a running company and an admitted, unexpired action.');
 const payload=action.payload;
 if(action.action_type!=='PUBLISH'||payload.executionMode!=='NETLIFY_AUTOMATIC'||payload.provider!=='netlify'||payload.environment!=='production'||payload.executorVersion!==1)throw new DomainError('Deployment needs an explicitly automatic Netlify publishing proposal.');
 const release=await one(tx,'SELECT * FROM static_releases WHERE id=$1',[payload.releaseId]);
 if(action.target!==release.site_id||payload.siteId!==release.site_id||payload.releaseHash!==release.content_hash)throw new DomainError('Deployment proposal does not match the frozen release.');
 if(action.settled!==null||action.reservation!==action.max_cost)throw new DomainError('Deployment financial reservation is not intact.');
 const approval=(await tx.query<Row>("SELECT * FROM approvals WHERE action_id=$1 AND decision='APPROVE' AND action_hash=$2",[actionId,action.action_hash])).rows[0];
 if(!approval)throw new DomainError('Deployment requires an exact approval.');
 const deployment=(await tx.query<Row>("INSERT INTO deployments(action_id,release_id,site_id,content_hash,status) VALUES($1,$2,$3,$4,'CREATING') RETURNING *",[actionId,release.id,release.site_id,release.content_hash])).rows[0];
 await event(tx,'deployment.creation_claimed',actionId,{releaseId:release.id,contentHash:release.content_hash,siteId:release.site_id});
 return {claimed:true,deployment};
}
/** Save a creation response before uploads, or a subsequent observation of that same ID.
 * A ready site is not a settled expense: reservation and ledger remain untouched. */
export async function recordDeploymentReceipt(tx:Tx,actionId:string,raw:unknown){
 const receipt=receiptSchema.parse(raw);
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 const action=await one(tx,'SELECT * FROM actions WHERE id=$1 FOR UPDATE',[actionId]);
 const deployment=await one(tx,'SELECT * FROM deployments WHERE action_id=$1 FOR UPDATE',[actionId]);
 if(receipt.siteId!==deployment.site_id || (deployment.provider_id && receipt.id!==deployment.provider_id))throw new DomainError('Receipt does not match the recorded deployment identity.');
 const release=await one(tx,'SELECT manifest FROM static_releases WHERE id=$1',[deployment.release_id]);
 if(receipt.required.some(hash=>!release.manifest.files.some((file:{sha1:string})=>file.sha1===hash)))throw new DomainError('Receipt requests content outside the frozen release.');
 const status=receipt.state==='ready'?'READY':receipt.state==='error'?'FAILED':'ACTIVE';
 if(['READY','FAILED'].includes(deployment.status)){
   if(status!==deployment.status)throw new DomainError('A terminal deployment cannot return to an earlier state.');
   return deployment;
 }
 const row=(await tx.query<Row>('UPDATE deployments SET provider_id=$2,provider_state=$3,status=$4,error=NULL,updated_at=now() WHERE action_id=$1 RETURNING *',[actionId,receipt.id,JSON.stringify(receipt),status])).rows[0];
 if(['READY','FAILED'].includes(status)){
  const result={execution:'NETLIFY_AUTOMATIC',published:status==='READY',providerId:receipt.id,providerState:receipt.state,url:receipt.url,releaseId:deployment.release_id,releaseHash:deployment.content_hash,costConfirmed:false};
  await tx.query("UPDATE actions SET status='AWAITING_COST',result=$2 WHERE id=$1 AND settled IS NULL",[actionId,JSON.stringify(result)]);
  const source=action.task_id?(await tx.query<Row>('SELECT employee_id FROM tasks WHERE id=$1',[action.task_id])).rows[0]:null;
  const messageId=randomUUID();
  const body=JSON.stringify({...result,actionId,note:status==='READY'?'Publication confirmed by provider. This is not evidence of buyer demand or revenue. Final cost remains unconfirmed.':'Provider reported deployment failure. Do not claim publication. Final cost remains unconfirmed.'});
  await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'publishing',$2,'DECISION',$3,$4,$5)",[messageId,source?.employee_id??'company',status==='READY'?'Publication confirmed':'Deployment failed',body,action.task_id]);
  await event(tx,'message.created',messageId,{senderId:'publishing',recipientId:source?.employee_id??'company',actionId});
 }
 await event(tx,'deployment.receipt_recorded',actionId,{providerId:receipt.id,providerState:receipt.state,status});return row;
}
/** Call on exclusive process startup, never while creation requests remain in flight.
 * Lost creation responses need reconciliation. Known-ID uploads/reads can be resumed
 * by a future coordinator after authorization checks, without another creation POST. */
export async function recoverDeploymentCreations(tx:Tx){
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 const rows=(await tx.query<Row>("UPDATE deployments SET status='UNCERTAIN',error='Creation response was not durably recorded. Do not create a replacement deployment.',updated_at=now() WHERE status='CREATING' RETURNING action_id")).rows;
 await tx.query("UPDATE actions SET status='UNCERTAIN' WHERE status='EXECUTING' AND EXISTS(SELECT 1 FROM deployments d WHERE d.action_id=actions.id AND d.status='UNCERTAIN')");
 for(const row of rows)await event(tx,'deployment.creation_uncertain',row.action_id,{resultAvailable:false});
 return rows.length;
}

export const deploymentCostInput=z.object({actualCostUsd:usd,externalReference:shortText,resultNote:text}).strict();
/** Owner records an observed final charge; no deployment or outside action occurs here.
 * A failed deployment can have a real charge without becoming a successful publication. */
export async function reconcileDeploymentCost(tx:Tx,actionId:string,raw:unknown){
 const input=deploymentCostInput.parse(raw),cost=parseUsd(input.actualCostUsd);
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 const action=await one(tx,'SELECT * FROM actions WHERE id=$1 FOR UPDATE',[actionId]);
 const deployment=await one(tx,'SELECT * FROM deployments WHERE action_id=$1 FOR UPDATE',[actionId]);
 if(action.settled!==null){
  const prior=(await tx.query<Row>('SELECT * FROM ledger WHERE idempotency_key=$1',[`deployment:${actionId}`])).rows[0];
  if(prior&&BigInt(action.settled)===cost&&prior.external_reference===input.externalReference&&prior.description===input.resultNote)return action;
  throw new DomainError('Deployment already has a different cost settlement.');
 }
 if(!['READY','FAILED'].includes(deployment.status))throw new DomainError('Establish the original deployment outcome before settling its final cost.');
 if(action.action_type!=='PUBLISH'||action.payload.executionMode!=='NETLIFY_AUTOMATIC')throw new DomainError('This is not an automatic deployment action.');
 if(!(await tx.query("SELECT id FROM approvals WHERE action_id=$1 AND decision='APPROVE' AND action_hash=$2",[actionId,action.action_hash])).rows.length)throw new DomainError('Deployment does not have its original matching approval.');
 const published=deployment.status==='READY';
 const result={execution:'NETLIFY_AUTOMATIC',published,costConfirmed:true,url:deployment.provider_state?.url,providerId:deployment.provider_id,providerState:deployment.provider_state?.state,releaseId:deployment.release_id,releaseHash:deployment.content_hash,...input,costExceeded:cost>BigInt(action.max_cost)};
 const updated=(await tx.query<Row>('UPDATE actions SET status=$2,settled=$3,reservation=0,result=$4 WHERE id=$1 RETURNING *',[actionId,published?'EXECUTED':'FAILED',cost.toString(),JSON.stringify(result)])).rows[0];
 await tx.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,action_id,task_id,experiment_id,description,external_reference) VALUES($1,$2,'BUSINESS','COST',$3,$4,$5,$6,$7,$8)",[randomUUID(),`deployment:${actionId}`,cost.toString(),actionId,action.task_id,action.experiment_id,input.resultNote,input.externalReference]);
 if(result.costExceeded){
  await tx.query("UPDATE company SET status=CASE WHEN status='KILLED' THEN 'KILLED' ELSE 'PAUSED' END,revision=revision+1 WHERE id=1");
  await event(tx,'company.deployment_bound_exceeded','company',{actionId,actualMicroUsd:cost.toString(),maximumMicroUsd:action.max_cost});
 }
 await event(tx,'deployment.cost_reconciled',actionId,{...input,published,providerId:deployment.provider_id},'owner');
 return updated;
}
