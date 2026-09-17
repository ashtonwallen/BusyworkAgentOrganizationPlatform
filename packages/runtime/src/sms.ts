import { createHmac,randomUUID,timingSafeEqual } from "node:crypto";
import { parseUsd } from "@hive/core";
import { event,one,type Row } from "./db.js";
import { formatUsd } from "./contracts.js";
import { DomainError,HiveService,activeCalls } from "./service.js";

import {smsAuthorization,type SmsConfig} from './sms-config.js';
export * from './sms-config.js';

export function verifyTwilioSignature(config:SmsConfig,signature:string,params:Record<string,string>):boolean {
  if(!config.webhookUrl)return false;
  const material=config.webhookUrl+Object.keys(params).sort().map(key=>key+params[key]).join('');
  const expected=createHmac('sha1',config.authToken).update(material).digest('base64');
  return signature.length===expected.length&&timingSafeEqual(Buffer.from(signature),Buffer.from(expected));
}

export class SmsService {
  private busy=false;
  constructor(readonly service:HiveService,readonly config:SmsConfig,private readonly fetcher:typeof fetch=fetch){}
  async recover(){await this.service.db.transaction(async(tx)=>{const rows=await tx.query<Row>("UPDATE notifications SET status='UNCERTAIN',error='Interrupted SMS dispatch; reconcile provider status before retry' WHERE status='DISPATCHED' RETURNING id");for(const n of rows.rows)await event(tx,"notification.uncertain",n.id);});}
  async tick(){if(this.busy)return;this.busy=true;try{await this.sendOne();await this.reconcileOne();}finally{this.busy=false;}}
  private async sendOne(){
    const claim=await this.service.db.transaction(async(tx)=>{
      const company=await one(tx,"SELECT * FROM company WHERE id=1 FOR UPDATE");
      // Notification delivery is an explicit owner-enabled workflow, including its bounded SMS cost.
      if(company.status==='KILLED'||!company.approval_policy.smsEnabled)return null;
      const rows=await tx.query<Row>("SELECT n.*,a.target,a.action_type,a.max_cost,a.rationale FROM notifications n JOIN actions a ON a.id=n.action_id WHERE n.status='PENDING' AND a.status='PENDING' AND a.expires_at>$1 ORDER BY n.created_at LIMIT 1 FOR UPDATE",[this.service.now()]);
      if(!rows.rows.length)return null;
      const row=rows.rows[0],bound=parseUsd(this.config.maxCostUsd),day=this.service.now().toISOString().slice(0,10);
      if(await missionAdmission(tx,row.mission_id,bound))return null;
      const sms=await one(tx,"SELECT COALESCE(SUM(COALESCE(settled,0)+CASE WHEN settled IS NULL THEN reserved ELSE 0 END),0)::text AS cost FROM notifications WHERE budget_day=$1 OR (settled IS NULL AND reserved>0)",[day]);
      const calls=await one(tx,`SELECT COALESCE(SUM(COALESCE(settled,0)+CASE WHEN status IN ${activeCalls} THEN reserved ELSE 0 END),0)::text AS cost FROM calls WHERE budget_day=$1 OR status IN ${activeCalls}`,[day]);
      if(BigInt(sms.cost)+bound>parseUsd(this.config.dailyCapUsd)||BigInt(sms.cost)+BigInt(calls.cost)+bound>BigInt(company.daily_cap))return null;
      await tx.query("UPDATE notifications SET status='DISPATCHED',reserved=$2,budget_day=$3 WHERE id=$1",[row.id,bound.toString(),day]);
      await event(tx,"notification.dispatched",row.id,{maximumMicroUsd:bound.toString()});return row;
    });
    if(!claim)return;
    const clean=(v:string)=>v.replace(/[^\x20-\x7E]/g,' ').replace(/\s+/g,' ').slice(0,75);
    const body=`Busywork proposal ${claim.code}: ${clean(claim.action_type)} for ${clean(claim.target)}. Max USD ${formatUsd(claim.max_cost)}. Review in dashboard.${this.config.webhookUrl?` Reply APPROVE ${claim.code} or DENY ${claim.code}.`:''}`;
    let result:Response;
    try{result=await this.fetcher(`https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`,{method:'POST',headers:{Authorization:smsAuthorization(this.config),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({To:this.config.to,From:this.config.from,Body:body}).toString(),signal:AbortSignal.timeout(15000),redirect:'error'});}
    catch{await this.service.db.query("UPDATE notifications SET status='UNCERTAIN',error='SMS result unknown; do not resend automatically' WHERE id=$1",[claim.id]);return;}
    if(!result.ok){const definitelyRejected=[400,401,403,404,429].includes(result.status);await this.service.db.transaction(async(tx)=>{await tx.query("UPDATE notifications SET status=$2,settled=$3,error=$4 WHERE id=$1",[claim.id,definitelyRejected?'FAILED':'UNCERTAIN',definitelyRejected?'0':null,`SMS provider HTTP ${result.status}`]);await event(tx,"notification.failed",claim.id,{status:result.status});});return;}
    let data:any;try{data=await result.json();}catch{await this.service.db.query("UPDATE notifications SET status='UNCERTAIN',error='Unreadable SMS response' WHERE id=$1",[claim.id]);return;}
    if(typeof data.sid!=='string'||!/^SM[a-fA-F0-9]{32}$/.test(data.sid)){await this.service.db.query("UPDATE notifications SET status='UNCERTAIN',error='SMS receipt missing' WHERE id=$1",[claim.id]);return;}
    await this.service.db.transaction(async(tx)=>{await tx.query("UPDATE notifications SET status='SENT',provider_id=$2,sent_at=now() WHERE id=$1",[claim.id,data.sid]);await event(tx,"notification.sent",claim.id,{providerId:data.sid});});
  }
  private async reconcileOne(){
    const rows=await this.service.db.query<Row>("SELECT * FROM notifications WHERE status='SENT' AND settled IS NULL AND provider_id IS NOT NULL ORDER BY created_at LIMIT 1");
    if(!rows.rows.length)return;const n=rows.rows[0];
    let response:Response;try{response=await this.fetcher(`https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages/${n.provider_id}.json`,{headers:{Authorization:smsAuthorization(this.config)},signal:AbortSignal.timeout(10000),redirect:'error'});}catch{return;}
    if(!response.ok)return;
    const data=await response.json() as {price?:string|null;price_unit?:string};
    if(!data.price||data.price_unit?.toUpperCase()!=='USD')return;
    const cost=parseUsd(data.price.replace(/^-/,''));
    await this.service.db.transaction(async(tx)=>{
      const current=await one(tx,"SELECT * FROM notifications WHERE id=$1 FOR UPDATE",[n.id]);if(current.settled!==null)return;
      await tx.query("UPDATE notifications SET settled=$2 WHERE id=$1",[n.id,cost.toString()]);
      await tx.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,notification_id,description,external_reference) VALUES($1,$2,'OPERATING','COST',$3,$4,'Proposal SMS charge',$5)",[randomUUID(),`sms:${n.id}`,cost.toString(),n.id,n.provider_id]);
      if(cost>BigInt(n.reserved)){await tx.query("UPDATE company SET status='PAUSED',revision=revision+1 WHERE id=1");await event(tx,"company.sms_bound_exceeded","company",{notificationId:n.id});}
      await event(tx,"notification.settled",n.id,{costMicroUsd:cost.toString()});
    });
  }
  async receive(signature:string,params:Record<string,string>){
    if(!verifyTwilioSignature(this.config,signature,params)||params.From!==this.config.to||params.To!==this.config.from||params.AccountSid!==this.config.accountSid)throw new DomainError("Unverified SMS sender or signature.",403);
    if(!/^SM[a-fA-F0-9]{32}$/.test(params.MessageSid??''))throw new DomainError("Invalid SMS receipt.",400);
    const command=/^(APPROVE|DENY)\s+([A-F0-9]{10})$/i.exec((params.Body??'').trim());
    return this.service.db.transaction(async(tx)=>{
      const duplicate=await tx.query("SELECT provider_id FROM sms_replies WHERE provider_id=$1",[params.MessageSid]);if(duplicate.rows.length)return{accepted:true,duplicate:true};
      await tx.query("INSERT INTO sms_replies(provider_id) VALUES($1)",[params.MessageSid]);
      if(!command){await event(tx,"sms.reply_unrecognized",params.MessageSid);return{accepted:false};}
      const rows=await tx.query<Row>("SELECT a.* FROM notifications n JOIN actions a ON a.id=n.action_id WHERE n.code=$1 FOR UPDATE",[command[2].toUpperCase()]);
      const a=rows.rows[0];
      if(!a||a.status!=='PENDING'||new Date(a.expires_at)<=this.service.now()){await event(tx,"sms.reply_stale",params.MessageSid);return{accepted:false};}
      await this.service.approveActionInTransaction(tx,a.id,a.action_hash,command[1].toUpperCase()==='APPROVE'?'APPROVE':'REJECT',`Owner SMS reply ${params.MessageSid}`);
      await event(tx,"sms.reply_applied",params.MessageSid,{actionId:a.id},"owner");return{accepted:true};
    });
  }
}
import {missionAdmission} from './mission-lifecycle.js';
