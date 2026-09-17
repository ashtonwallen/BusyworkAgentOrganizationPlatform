import {assertMissionExternal} from './mission-capabilities.js';
import {recoverDeploymentCreations} from './deployments.js';
import {recordSource} from './source-records.js';
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { parseUsd } from "@hive/core";
import { event,one,type Row } from "./db.js";
import { DomainError,HiveService } from "./service.js";

export interface ExternalTool {
  name:string;version:number;description:string;approvalCategory:string;maximumCostUsd:string;
  validate?(target:string,payload:Record<string,unknown>):void;
  execute(input:{target:string;payload:Record<string,unknown>;actionId:string}):Promise<{result:unknown;actualCostUsd:string}>;
}
export class ToolRegistry {
  private tools=new Map<string,ExternalTool>();
  register(tool:ExternalTool){if(this.tools.has(tool.name))throw new Error(`Duplicate tool ${tool.name}`);parseUsd(tool.maximumCostUsd);this.tools.set(tool.name,tool);return this;}
  get(name:string){return this.tools.get(name);}
  list(){return [...this.tools.values()].map(({execute,validate,...tool})=>tool);}
}
export function runtimeToolRegistry(service:HiveService){const registry=new ToolRegistry().register(publicPageTool);if(service.searchTool)registry.register(service.searchTool);return registry;}
export function isPublicAddress(address:string):boolean {
  // The initial public-fetch adapter deliberately supports only IPv4 destinations.
  if(isIP(address)!==4)return false;
  const [a,b,c]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19))||(a===192&&b===0)||(a===198&&b===51&&c===100)||(a===203&&b===0&&c===113));
}
export class PublicReadFailure extends Error {
  constructor(readonly code:'BROWSER_UNAVAILABLE'|'INVALID_URL'|'PRIVATE_ADDRESS'|'DNS_FAILED'|'HTTP_STATUS'|'CONTENT_TYPE'|'SIZE_LIMIT'|'TIMEOUT'|'CONNECTION_FAILED',readonly httpStatus?:number){super(`Public read failed: ${code}${httpStatus===undefined?'':` (HTTP ${httpStatus})`}.`);}
}
export async function fetchPublicPage(target:string){
    let url:URL;try{url=new URL(target);}catch{throw new PublicReadFailure('INVALID_URL');}
    if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443'))throw new PublicReadFailure('INVALID_URL');
    const addresses=await lookup(url.hostname,{all:true,family:4}).catch(()=>{throw new PublicReadFailure('DNS_FAILED');});
    if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw new PublicReadFailure('PRIVATE_ADDRESS');
    const chosen=addresses[0];
    return await new Promise<{status:number;contentType:string;text:string}>((resolve,reject)=>{
      const req=request(url,{method:'GET',family:4,headers:{'User-Agent':'HiveResearch/0.1','Accept':'text/html, text/plain, application/json'},
        lookup:(_host,_options,callback)=>callback(null,chosen.address,4)},res=>{
          const status=res.statusCode??0,type=String(res.headers['content-type']??'');
          if(status<200||status>=300||!/(text\/|application\/json)/i.test(type)){res.resume();reject(new PublicReadFailure(status<200||status>=300?'HTTP_STATUS':'CONTENT_TYPE',status));return;}
          const chunks:Buffer[]=[];let bytes=0;
          res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1000000){req.destroy(new PublicReadFailure('SIZE_LIMIT'));return;}chunks.push(chunk);});
          res.on('end',()=>resolve({status,contentType:type,text:Buffer.concat(chunks).toString('utf8')}));res.on('error',()=>reject(new PublicReadFailure('CONNECTION_FAILED')));
        });
      req.setTimeout(15000,()=>req.destroy(new PublicReadFailure('TIMEOUT')));req.on('error',error=>reject(error instanceof PublicReadFailure?error:new PublicReadFailure('CONNECTION_FAILED')));req.end();
    });
}
export const publicPageTool:ExternalTool={
  name:'READ_PUBLIC_PAGE',version:1,description:'Read a public HTTPS page as untrusted source text. No cookies, credentials, scripts, redirects, or private network access.',approvalCategory:'research',maximumCostUsd:'0',
  async execute({target,payload}){
    if(payload?.renderer==='browser'){const {browserRead}=await import('./browser.js');return browserRead(target,fetchPublicPage);}
    const page=await fetchPublicPage(target);
    const text=page.text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
    return{result:{source:target,fetchedAt:new Date().toISOString(),status:page.status,text:text.slice(0,20000),truncated:text.length>20000,trust:'UNTRUSTED_EXTERNAL_SOURCE'},actualCostUsd:'0'};
  }
};
export class ToolGateway {
  constructor(readonly service:HiveService,readonly registry:ToolRegistry){}
  async tick(){
    const names=this.registry.list().map(tool=>tool.name);if(!names.length)return;
    const candidates=await this.service.db.query<Row>(`SELECT a.id,a.action_type FROM actions a
      WHERE a.status IN ('PENDING','APPROVED') AND a.expires_at>$1 AND a.action_type=ANY($2::text[])
      AND (a.status='APPROVED' OR (a.revises_action_id IS NULL AND EXISTS(SELECT 1 FROM grants g WHERE g.action_type=a.action_type AND g.target=a.target AND NOT g.revoked AND g.expires_at>$1 AND (g.experiment_id IS NULL OR g.experiment_id=a.experiment_id))))
      ORDER BY CASE WHEN a.status='APPROVED' THEN 0 ELSE 1 END,a.created_at,a.id LIMIT 30`,[this.service.now(),names]);
    // Complete at most one external dispatch per tick so queued internal work also gets a turn.
    for(const a of candidates.rows){try{await this.execute(a.id);break;}catch(error){if(!(error instanceof DomainError))throw error;}}
  }
  async execute(id:string){
    const admission=await this.service.db.transaction(async(tx)=>{
      const c=await one(tx,"SELECT * FROM company WHERE id=1 FOR UPDATE");
      const a=await one(tx,"SELECT * FROM actions WHERE id=$1 FOR UPDATE",[id]);
      if(a.status==='EXECUTED')return{done:true,result:a.result} as const;
      await assertMissionExternal(tx,a.mission_id,a.action_type);
      if(c.status!=='RUNNING')throw new DomainError('Company is not running.');
      const slots=await one(tx,"SELECT ((SELECT COUNT(*) FROM calls WHERE status IN ('RESERVED','DISPATCHED'))+(SELECT COUNT(*) FROM actions WHERE status='EXECUTING' AND action_type<>'MODEL_CALL'))::integer AS count");
      if(slots.count>=c.max_concurrency)throw new DomainError('All configured execution slots are in use.');
      if(a.payload?.executionMode==='OWNER_ASSISTED')throw new DomainError('This approval is for owner-assisted execution. Create a new proposal for an automated integration.');
      const tool=this.registry.get(a.action_type);if(!tool)throw new DomainError('This proposal needs an integration or an owner-assisted completion. No executable tool is installed.');
      if(!['PENDING','APPROVED'].includes(a.status)||new Date(a.expires_at)<=this.service.now())throw new DomainError('Action is not currently executable.');
      if(tool.version!==1)throw new DomainError('Tool version changed; submit a new version-bound proposal.');
      try{tool.validate?.(a.target,a.payload);}catch{throw new DomainError('Tool request or provider pricing changed; prepare a valid new proposal.');}
      const maximum=parseUsd(tool.maximumCostUsd);if(BigInt(a.max_cost)<maximum)throw new DomainError('Proposal does not cover the tool cost bound.');
      const missionBlocked=await missionAdmission(tx,a.mission_id,BigInt(a.max_cost));
      if(missionBlocked)return {blocked:missionBlocked} as const;
      // Only the typed, price-bound search contract enables paid gateway calls.
      if(tool.name==='SEARCH_WEB'){
        if(!tool.validate||BigInt(a.max_cost)!==maximum)throw new DomainError('Search must use the exact configured per-query cost.');
        const exposure=await one(tx,`SELECT
         ((SELECT COALESCE(sum(amount),0) FROM ledger WHERE kind='COST' AND account<>'TEST' AND occurred_at::date=$1::date)+
          (SELECT COALESCE(sum(reserved),0) FROM calls WHERE status IN ('RESERVED','DISPATCHED','UNCERTAIN'))+
          (SELECT COALESCE(sum(reservation),0) FROM actions)+
          (SELECT COALESCE(sum(reserved),0) FROM notifications WHERE settled IS NULL))::text AS daily,
         ((SELECT COALESCE(sum(COALESCE(settled,0)+CASE WHEN status IN ('RESERVED','DISPATCHED','UNCERTAIN') THEN reserved ELSE 0 END),0) FROM calls WHERE is_live)+
          (SELECT COALESCE(sum(COALESCE(settled,0)+reservation),0) FROM actions WHERE action_type='SEARCH_WEB'))::text AS lifetime`,[this.service.now().toISOString().slice(0,10)]);
        if(BigInt(exposure.daily)+maximum>BigInt(c.daily_cap))throw new DomainError('Daily cap cannot cover this search.');
        if(maximum>0n&&BigInt(exposure.lifetime)+maximum>BigInt(c.live_cap))throw new DomainError('Lifetime paid cap cannot cover this search.');
      }else if(maximum!==0n||BigInt(a.max_cost)!==0n)throw new DomainError('This gateway adapter is restricted to zero cost.');
      if(a.task_id){const task=await one(tx,"SELECT * FROM tasks WHERE id=$1",[a.task_id]);if(['CANCELLED','EXPIRED'].includes(task.status)||new Date(task.expires_at)<=this.service.now())throw new DomainError('Source task has expired or been cancelled.');}
      let grantId:string|null=null;
      if(a.status==='APPROVED'){
        const approval=await one(tx,"SELECT * FROM approvals WHERE action_id=$1",[id]);if(approval.decision!=='APPROVE'||approval.action_hash!==a.action_hash)throw new DomainError('Approval does not match this action.');
      }else{
        if(a.revises_action_id || c.approval_policy[tool.approvalCategory]!==false)throw new DomainError('This external action requires owner approval.');
        const rows=await tx.query<Row>("SELECT * FROM grants WHERE action_type=$1 AND target=$2 AND NOT revoked AND expires_at>$3 AND (experiment_id IS NULL OR experiment_id=$4) ORDER BY created_at,id FOR UPDATE",[a.action_type,a.target,this.service.now(),a.experiment_id]);
        for(const g of rows.rows){const used=await one(tx,"SELECT COALESCE(SUM(COALESCE(settled,0)+reservation),0)::text AS amount FROM actions WHERE grant_id=$1",[g.id]);if(BigInt(a.max_cost)<=BigInt(g.max_transaction)&&BigInt(a.max_cost)+BigInt(used.amount)<=BigInt(g.total_cap)){grantId=g.id;break;}}
        if(!grantId)throw new DomainError('No matching active authority exists for this external action.');
      }
      await tx.query("UPDATE actions SET status='EXECUTING',reservation=max_cost,grant_id=$2 WHERE id=$1",[id,grantId]);await event(tx,'tool.dispatched',id,{tool:tool.name,version:tool.version});
      return{done:false,action:a,tool} as const;
    });
    if('blocked' in admission)throw new DomainError(admission.blocked??'Mission is blocked.');
    if(admission.done)return admission.result;
    let outcome:Awaited<ReturnType<ExternalTool['execute']>>;
    try{outcome=await admission.tool.execute({target:admission.action.target,payload:admission.action.payload,actionId:id});}
    catch(error){
      const diagnostic=error instanceof PublicReadFailure?{code:error.code,httpStatus:error.httpStatus,message:error.message}: {code:'UNCLASSIFIED',message:'Tool did not return a confirmed result. Inspect before retrying.'};
      await this.service.db.transaction(async(tx)=>{await tx.query("UPDATE actions SET status='UNCERTAIN',result=$2 WHERE id=$1",[id,JSON.stringify({error:diagnostic.message,diagnostic,resultAvailable:false})]);await event(tx,'tool.uncertain',id,{diagnostic,resultAvailable:false});});
      throw new DomainError('Tool result is uncertain; the action was not retried.');
    }
    const cost=parseUsd(outcome.actualCostUsd);
    await this.service.db.transaction(async(tx)=>{
      const sourceId=await recordSource(tx,admission.action,outcome.result,this.service.now());
      if(sourceId)outcome.result={...(outcome.result as Record<string,unknown>),sourceRecordId:sourceId};
      await tx.query("UPDATE actions SET status='EXECUTED',reservation=0,settled=$2,result=$3 WHERE id=$1",[id,cost.toString(),JSON.stringify(outcome.result)]);
      await tx.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,action_id,task_id,description,experiment_id) VALUES($1,$2,'OPERATING','COST',$3,$4,$5,$6,$7)",[randomUUID(),`tool:${id}`,cost.toString(),id,admission.action.task_id,`${admission.tool.name} execution`,admission.action.experiment_id]);
      if(cost>BigInt(admission.action.max_cost)){await tx.query("UPDATE company SET status='PAUSED',revision=revision+1 WHERE id=1");await event(tx,'company.tool_bound_exceeded','company',{actionId:id});}
      if(admission.action.experiment_id && admission.tool.name==='READ_PUBLIC_PAGE') {
        const raw=outcome.result as Record<string,unknown> | null;
        const note={kind:'SOURCE_RECORD',source:'tool-gateway',actionId:id,taskId:admission.action.task_id,
          url:admission.action.target,date:this.service.now().toISOString(),trust:'UNTRUSTED_EXTERNAL_SOURCE',
          note:typeof raw?.text==='string'?raw.text.slice(0,1500):'The source request completed. Inspect its recorded result.',
          excerptTruncated:typeof raw?.text==='string' && (raw.text.length>1500 || raw.truncated===true)};
        await tx.query('UPDATE experiments SET evidence=evidence || $2::jsonb WHERE id=$1',[admission.action.experiment_id,JSON.stringify([note])]);
        await event(tx,'experiment.source_recorded',admission.action.experiment_id,{actionId:id,url:admission.action.target});
      }
      const source=admission.action.task_id?await one(tx,"SELECT employee_id FROM tasks WHERE id=$1",[admission.action.task_id]):null;
      await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'tool-gateway',$2,'DECISION',$3,$4,$5)",[randomUUID(),source?.employee_id??'company',`Result: ${admission.tool.name}`,JSON.stringify(outcome.result).slice(0,12000),admission.action.task_id]);
      await event(tx,'tool.completed',id,{tool:admission.tool.name,costMicroUsd:cost.toString()});
    });return outcome.result;
  }
  async recover(){await this.service.db.transaction(async(tx)=>{const rows=await tx.query<Row>("UPDATE actions SET status='UNCERTAIN' WHERE status='EXECUTING' AND action_type<>'MODEL_CALL' AND NOT EXISTS(SELECT 1 FROM deployments d WHERE d.action_id=actions.id) RETURNING id");for(const a of rows.rows)await event(tx,'tool.recovered_uncertain',a.id);await recoverDeploymentCreations(tx);});}
}
import {missionAdmission} from './mission-lifecycle.js';
