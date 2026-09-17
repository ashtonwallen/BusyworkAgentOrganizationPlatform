import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {campaignInput} from './campaign-input.js';
import {one,event,type Tx,type Row} from './db.js';
import {DomainError,actionHash,type HiveService} from './service.js';
import {businessMailbox,type EmailDraft,type ProviderEmail} from './email-provider.js';
import {instanceSettings} from './instance-settings.js';
import {assertMissionExternal} from './mission-capabilities.js';
import {currentMission} from './missions.js';

const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function identifiedEmail<T extends {text:string;html:string}>(draft:T):T{
 const footer=`Sent by ${instanceSettings.companyName} (${businessMailbox}). Reply STOP or unsubscribe to opt out of further email.`;
 return {...draft,text:draft.text.endsWith(footer)?draft.text:[draft.text,footer].filter(Boolean).join('\n\n'),html:draft.html?draft.html.includes(escape(footer))?draft.html:draft.html+`<p>${escape(footer)}</p>`:''};
}
export async function assertContactable(tx:Pick<Tx,'query'>,addresses:string[]){
 const blocked=(await tx.query<Row>('SELECT address FROM do_not_contact WHERE address=ANY($1::text[])',[addresses.map(a=>a.toLowerCase())])).rows;
 if(blocked.length)throw new DomainError('Do-not-contact restriction: '+blocked.map(r=>r.address).join(', '));
}
export async function recordOptOut(tx:Tx,address:string,reason:string,sourceMessageId?:string){
 address=z.email().parse(address).toLowerCase();
 const inserted=await tx.query('INSERT INTO do_not_contact(address,reason,source_message_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING address',[address,reason,sourceMessageId??null]);
 if(inserted.rows.length)await event(tx,'email.opted_out',sourceMessageId??address,{address,reason},sourceMessageId?'business-email':'owner');
}
export async function ingestOptOut(tx:Tx,id:string,message:ProviderEmail){
 if(message.direction!=='INBOUND')return;
 // Inspect only the newly authored first nonempty line, never quoted history or HTML instructions.
 const first=message.text.split(/\r?\n/).map(s=>s.trim()).find(Boolean)??'';
 if(/^(?:stop|unsubscribe|please unsubscribe(?: me)?|remove me(?: from (?:your|the) (?:mailing )?list)?|do not (?:email|contact) me)[.!\s]*$/i.test(first))
  for(const address of message.from)if(z.email().safeParse(address).success)await recordOptOut(tx,address,'Explicit opt-out in received email.',id);
}
export async function proposeCampaign(tx:Tx,raw:unknown,actor:string,taskId?:string){
 await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
 const missionId=taskId?(await one(tx,'SELECT mission_id FROM tasks WHERE id=$1',[taskId])).mission_id:(await currentMission(tx))?.id;
 await assertMissionExternal(tx,missionId,'SEND_MESSAGE');
 const input=campaignInput.parse(raw);if(!businessMailbox)throw new DomainError('Configure the sender mailbox first.');
 for(const recipient of input.recipients){
  if(!recipient.sourceId){if(actor!=='owner')throw new DomainError('Agent-supplied recipients need a recorded source containing the exact address. Never guess or scrape personal addresses.');}
  else{const source=await one(tx,'SELECT content,kind FROM source_records WHERE id=$1',[recipient.sourceId]);if(source.kind!=='PAGE'||!Array.from(String(source.content).toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g)??[]).some(address=>address===recipient.address))throw new DomainError('Recipient address is not present in the fetched source.');}
 }
 await assertContactable(tx,input.recipients.map(r=>r.address));
 const definition={...identifiedEmail(input),sender:businessMailbox,recipientRule:'EXPLICIT_LIST_ONLY'},id=randomUUID(),hash=actionHash({id,missionId,definition});
 await tx.query('INSERT INTO outreach_campaigns(id,mission_id,task_id,author_id,definition,approval_hash) VALUES($1,$2,$3,$4,$5,$6)',[id,missionId,taskId??null,actor,JSON.stringify(definition),hash]);
 await tx.query('INSERT INTO owner_requests(id,title,details,mission_id) VALUES($1,$2,$3,$4)',[id,'Campaign approval: '+input.title,JSON.stringify({kind:'CAMPAIGN_APPROVAL',campaignId:id,hash,definition}),missionId]);
 await event(tx,'campaign.proposed',id,{hash,taskId:taskId??null,recipientCount:input.recipients.length},actor);return {id,hash};
}
export async function decideCampaign(service:HiveService,id:string,hash:string,decision:'APPROVE'|'REJECT'|'REVOKE'){
 return service.db.transaction(async tx=>{
  await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');const campaign=await one(tx,'SELECT * FROM outreach_campaigns WHERE id=$1',[id]);
  if(campaign.approval_hash!==hash)throw new DomainError('Campaign changed. Review its exact hash before deciding.');
  await tx.query('INSERT INTO campaign_decisions(id,campaign_id,approval_hash,decision) VALUES($1,$2,$3,$4)',[randomUUID(),id,hash,decision]);
  await tx.query("UPDATE owner_requests SET status=$2,response=$3 WHERE id=$1 AND status='OPEN'",[id,decision==='APPROVE'?'DONE':'DECLINED','Campaign '+decision.toLowerCase()+' by owner.']);
  await event(tx,'campaign.decided',id,{hash,decision},'owner');
 });
}
export async function campaignAuthorization(tx:Pick<Tx,'query'>,draft:EmailDraft,missionId:string|null,now:Date,messageId?:string){
 if(!draft.campaignId)return null;
 const campaign=(await tx.query<Row>(`SELECT c.*, (SELECT decision FROM campaign_decisions d WHERE d.campaign_id=c.id AND d.approval_hash=c.approval_hash ORDER BY sequence DESC LIMIT 1) AS decision FROM outreach_campaigns c WHERE c.id=$1`,[draft.campaignId])).rows[0];
 if(!campaign||campaign.mission_id!==missionId||campaign.decision!=='APPROVE')return null;
 const d=campaign.definition;
 if(now<new Date(d.startsAt)||now>=new Date(d.endsAt)||d.sender!==businessMailbox)return null;
 if(draft.to.length!==1||draft.cc.length||draft.bcc.length||draft.replyTo||draft.replyToMessageId||draft.documentAttachments.length||draft.workspaceAttachments.length)return null;
 if(draft.subject!==d.subject||draft.text!==d.text||draft.html!==d.html||!d.recipients.some((r:any)=>r.address===draft.to[0].toLowerCase()))return null;
 const used=(await tx.query<Row>('SELECT message_id,recipient FROM campaign_sends WHERE campaign_id=$1',[campaign.id])).rows;
 if(used.some(row=>row.message_id===messageId))return campaign;
 if(used.length>=d.sendCap||used.some(row=>row.recipient===draft.to[0].toLowerCase()))return null;
 return campaign;
}
export async function reserveCampaignSend(tx:Tx,campaign:Row,message:Row){
 await tx.query('INSERT INTO campaign_sends(message_id,campaign_id,recipient,approval_hash) VALUES($1,$2,$3,$4)',[message.id,campaign.id,message.draft.to[0].toLowerCase(),campaign.approval_hash]);
}
export async function campaignIndex(tx:Pick<Tx,'query'>){return (await tx.query<Row>(`SELECT c.*,(SELECT decision FROM campaign_decisions d WHERE d.campaign_id=c.id ORDER BY sequence DESC LIMIT 1) AS decision,(SELECT count(*)::int FROM campaign_sends s WHERE s.campaign_id=c.id) AS reserved_sends FROM outreach_campaigns c ORDER BY c.created_at DESC LIMIT 100`)).rows;}

export async function readCampaign(tx:Pick<Tx,'query'>,id:string,offset=0){
 const row=await one(tx,`SELECT c.*,(SELECT decision FROM campaign_decisions d WHERE d.campaign_id=c.id ORDER BY sequence DESC LIMIT 1) AS decision,(SELECT count(*)::int FROM campaign_sends s WHERE s.campaign_id=c.id) AS reserved_sends FROM outreach_campaigns c WHERE c.id=$1`,[id]);
 const content=JSON.stringify(row);if(offset>content.length)throw new DomainError('Campaign offset is out of range.');const end=Math.min(offset+4000,content.length);
 return {content:content.slice(offset,end),offset,nextOffset:end<content.length?end:null,contentHash:actionHash(row)};
}
