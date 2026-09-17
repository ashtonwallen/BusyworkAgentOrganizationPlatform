import {assertMissionExternal} from './mission-capabilities.js';
import {z} from 'zod';
import {parseUsd} from '@hive/core';
import {one,event,type Tx} from './db.js';
import {DomainError} from './service.js';
import {missionAdmission} from './mission-lifecycle.js';
export interface HostingSetup {enabled:boolean;ready:boolean;missing:string[];siteId?:string;maxDeploymentUsd?:string;totalCapUsd?:string;}
/** Nonsecret setup description. Never return the token to snapshots or model context. */
export function hostingSetup(env:Record<string,string|undefined>):HostingSetup {
 const enabled=env.HIVE_NETLIFY_ENABLED==='true',missing:string[]=[];
 const siteId=env.HIVE_NETLIFY_SITE_ID?.trim(),maxDeploymentUsd=env.HIVE_NETLIFY_MAX_DEPLOY_USD?.trim(),totalCapUsd=env.HIVE_NETLIFY_TOTAL_CAP_USD?.trim();
 if(!env.HIVE_NETLIFY_TOKEN?.trim())missing.push('HIVE_NETLIFY_TOKEN');
 if(!z.uuid().safeParse(siteId).success)missing.push('HIVE_NETLIFY_SITE_ID');
 let maximum:bigint|undefined,total:bigint|undefined;
 try{maximum=parseUsd(maxDeploymentUsd??'');}catch{missing.push('HIVE_NETLIFY_MAX_DEPLOY_USD');}
 try{total=parseUsd(totalCapUsd??'');}catch{missing.push('HIVE_NETLIFY_TOTAL_CAP_USD');}
 if(maximum!==undefined&&total!==undefined&&maximum>total)missing.push('HIVE_NETLIFY_TOTAL_CAP_USD');
 return {enabled,ready:enabled&&missing.length===0,missing,siteId:z.uuid().safeParse(siteId).success?siteId:undefined,maxDeploymentUsd:maximum===undefined?undefined:maxDeploymentUsd,totalCapUsd:total===undefined?undefined:totalCapUsd};
}
/** Serializes financial admission. Lifetime usage includes every unsettled reservation,
 * including uncertain attempts, and settled charges. No elapsed-day reset clears holds. */
export async function admitPublishing(tx:Tx,actionId:string,config:HostingSetup,now=new Date()){
 if(!config.ready||!config.siteId||config.maxDeploymentUsd===undefined||config.totalCapUsd===undefined)throw new DomainError('Automatic publishing setup is incomplete or disabled.');
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 const company=await one(tx,'SELECT * FROM company WHERE id=1');
 const action=await one(tx,'SELECT * FROM actions WHERE id=$1 FOR UPDATE',[actionId]);
 await assertMissionExternal(tx,action.mission_id,'PUBLISH');
 const blocked=await missionAdmission(tx,action.mission_id,BigInt(action.max_cost));if(blocked)throw new DomainError(blocked);
 if(company.status!=='RUNNING'||action.status!=='APPROVED'||new Date(action.expires_at)<=now)throw new DomainError('Publishing needs a running company and an unexpired approval.');
 if(action.action_type!=='PUBLISH'||action.payload.executionMode!=='NETLIFY_AUTOMATIC'||action.target!==config.siteId)throw new DomainError('Publishing action does not match the configured integration.');
 if(BigInt(action.max_cost)!==parseUsd(config.maxDeploymentUsd))throw new DomainError('Configured publishing cost bound changed; prepare a new proposal.');
 if(action.reservation!=='0'||action.settled!==null)throw new DomainError('Publishing action already has a financial allocation.');
 if(!(await tx.query("SELECT id FROM approvals WHERE action_id=$1 AND decision='APPROVE' AND action_hash=$2",[actionId,action.action_hash])).rows.length)throw new DomainError('Publishing requires a matching owner approval.');
 const release=await one(tx,'SELECT * FROM static_releases WHERE id=$1',[action.payload.releaseId]);
 if(action.payload.provider!=='netlify'||action.payload.environment!=='production'||action.payload.executorVersion!==1||release.site_id!==action.target||action.payload.siteId!==release.site_id||action.payload.releaseHash!==release.content_hash)throw new DomainError('Publishing approval does not match the frozen release.');
 if(action.task_id){const task=await one(tx,'SELECT status,expires_at FROM tasks WHERE id=$1',[action.task_id]);if(['CANCELLED','EXPIRED'].includes(task.status)||new Date(task.expires_at)<=now)throw new DomainError('Source task expired or was cancelled.');}
 const slots=await one(tx,"SELECT ((SELECT COUNT(*) FROM calls WHERE status IN ('RESERVED','DISPATCHED'))+(SELECT COUNT(*) FROM actions WHERE status='EXECUTING'))::int AS count");
 if(slots.count>=company.max_concurrency)throw new DomainError('All execution slots are in use.');
 const used=await one(tx,"SELECT COALESCE(SUM(COALESCE(settled,0)+reservation),0)::text AS amount FROM actions WHERE action_type='PUBLISH' AND payload->>'executionMode'='NETLIFY_AUTOMATIC'");
 if(BigInt(used.amount)+BigInt(action.max_cost)>parseUsd(config.totalCapUsd))throw new DomainError('Publishing lifetime cap cannot cover this deployment; reconcile existing charges or adjust the cap.');
 await tx.query("UPDATE actions SET status='EXECUTING',reservation=max_cost WHERE id=$1",[actionId]);
 await event(tx,'deployment.admitted',actionId,{reservedMicroUsd:action.max_cost,siteId:config.siteId});
 return action;
}
