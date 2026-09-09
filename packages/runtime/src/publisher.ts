import {admitPublishing} from './hosting.js';
import {one,event} from './db.js';
import {DomainError,HiveService} from './service.js';
import {claimDeploymentCreation,recordDeploymentReceipt,recoverDeploymentCreations} from './deployments.js';
import {DeploymentTransportError,type NetlifyDeploymentClient} from './netlify.js';

/** Admits exact approved releases and advances one durable publishing step at a time. */
export class StaticPublisher {
 private readonly inFlight=new Set<string>();
 constructor(private readonly service:HiveService,private readonly siteId:string,private readonly client:Pick<NetlifyDeploymentClient,'start'|'inspect'|'uploadRequired'>){}
 private async authorized(actionId:string){
  return this.service.db.transaction(async tx=>{
   await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
   const company=await one(tx,'SELECT status FROM company WHERE id=1');
   const action=await one(tx,'SELECT * FROM actions WHERE id=$1',[actionId]);
   if(company.status!=='RUNNING'||action.status!=='EXECUTING'||new Date(action.expires_at)<=this.service.now())throw new DomainError('Publishing is paused, withdrawn or expired.');
   if(action.target!==this.siteId||action.payload.executionMode!=='NETLIFY_AUTOMATIC')throw new DomainError('This publisher is not authorized for the proposal destination or execution mode.');
   if(action.reservation!==action.max_cost||action.settled!==null)throw new DomainError('Publishing reservation is not intact.');
   if(!(await tx.query("SELECT id FROM approvals WHERE action_id=$1 AND decision='APPROVE' AND action_hash=$2",[actionId,action.action_hash])).rows.length)throw new DomainError('Publishing approval does not match.');
   if(action.task_id){const task=await one(tx,'SELECT status,expires_at FROM tasks WHERE id=$1',[action.task_id]);if(['CANCELLED','EXPIRED'].includes(task.status)||new Date(task.expires_at)<=this.service.now())throw new DomainError('Publishing source allocation has expired or been cancelled.');}
   return action;
  });
 }
 async advance(actionId:string){
  if(this.inFlight.has(actionId))return;
  this.inFlight.add(actionId);
  try{
   const prior=(await this.service.db.query('SELECT * FROM deployments WHERE action_id=$1',[actionId])).rows[0] as {status:string}|undefined;
   if(prior&&['READY','FAILED','UNCERTAIN'].includes(prior.status))return prior;
   if(prior)await this.authorized(actionId);
   const claim=await this.service.db.transaction(async tx=>{
    await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
    const action=await one(tx,'SELECT * FROM actions WHERE id=$1',[actionId]);
    if(action.target!==this.siteId)throw new DomainError('Publisher destination mismatch.');
    if(action.status==='APPROVED')await admitPublishing(tx,actionId,this.service.hosting,this.service.now());
    return claimDeploymentCreation(tx,actionId,this.service.now());
   });
   const deployment=claim.deployment;
   const release=await one(this.service.db,'SELECT manifest FROM static_releases WHERE id=$1',[deployment.release_id]);
   if(claim.claimed){
    try{
     await this.authorized(actionId);
     const receipt=await this.client.start(release.manifest);
     // Durable identity precedes any upload. A late response is saved even after pause.
     return await this.service.db.transaction(tx=>recordDeploymentReceipt(tx,actionId,receipt));
    }catch(error){
     await this.failure(actionId,error,true);return;
    }
   }
   if(deployment.status!=='ACTIVE')return deployment;
   try{
    await this.authorized(actionId);
    const receipt=await this.client.inspect(this.siteId,deployment.provider_id);
    const recorded=await this.service.db.transaction(tx=>recordDeploymentReceipt(tx,actionId,receipt));
    if(recorded.status==='ACTIVE'&&receipt.required.length){
     await this.client.uploadRequired(release.manifest,receipt,async()=>{await this.authorized(actionId);});
    }
    return recorded;
   }catch(error){await this.failure(actionId,error,false);return;}
  }finally{this.inFlight.delete(actionId);}
 }
 async tick(){
  if(!this.service.hosting.ready||this.inFlight.size)return;
  const company=await one(this.service.db,'SELECT status FROM company WHERE id=1');if(company.status!=='RUNNING')return;
  const rows=await this.service.db.query<{id:string}>(`SELECT a.id FROM actions a LEFT JOIN deployments d ON d.action_id=a.id
   WHERE a.action_type='PUBLISH' AND a.target=$1 AND a.payload->>'executionMode'='NETLIFY_AUTOMATIC'
   AND a.expires_at>$2 AND (a.status='APPROVED' OR (a.status='EXECUTING' AND d.status='ACTIVE' AND d.updated_at<$3))
   ORDER BY CASE WHEN d.status='ACTIVE' THEN 0 ELSE 1 END,a.created_at LIMIT 30`,[this.siteId,this.service.now(),new Date(this.service.now().getTime()-15000)]);
  for(const row of rows.rows){try{await this.advance(row.id);break;}catch(error){if(!(error instanceof DomainError))throw error;}}
 }
 private async failure(actionId:string,error:unknown,creation:boolean){
  // Never persist arbitrary exceptions that might contain provider credentials or bodies.
  const message=error instanceof DeploymentTransportError?error.message:error instanceof DomainError?'Publishing authorization or receipt validation needs attention.':'Publishing transport or persistence needs attention.';
  await this.service.db.transaction(async tx=>{
   await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
   await one(tx,'SELECT id FROM actions WHERE id=$1 FOR UPDATE',[actionId]);
   const current=await one(tx,'SELECT * FROM deployments WHERE action_id=$1 FOR UPDATE',[actionId]);
   if(creation&&current.status==='CREATING'){await tx.query("UPDATE deployments SET status='UNCERTAIN',error=$2,updated_at=now() WHERE action_id=$1",[actionId,message]);await tx.query("UPDATE actions SET status='UNCERTAIN' WHERE id=$1 AND status='EXECUTING'",[actionId]);}
   else await tx.query('UPDATE deployments SET error=$2,updated_at=now() WHERE action_id=$1',[actionId,message]);
   await event(tx,'deployment.needs_attention',actionId,{phase:creation?'CREATION':'KNOWN_DEPLOYMENT',message,providerId:current.provider_id??null});
  });
 }
 /** Exclusive startup only; never call while another publisher instance is active. */
 async recover(){if(this.inFlight.size)throw new DomainError('Wait for active publishing calls before recovery.');return this.service.db.transaction(tx=>recoverDeploymentCreations(tx));}
}
