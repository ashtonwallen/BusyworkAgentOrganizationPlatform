import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,BusinessEmail,proposeBusinessEmail,one,businessMailbox,EmailProviderError,type EmailProvider,type ProviderEmail} from '../packages/runtime/src/index.js';
import {proposeCampaign,decideCampaign,recordOptOut} from '../packages/runtime/src/campaigns.js';
const definition=()=>({title:'Approved outreach',subject:'A bounded invitation',text:'An invitation.',recipients:[{address:'first@example.com'},{address:'second@example.com'}],sendCap:1,startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString()});
async function fixture(){
 const db=await openDatabase(),service=new HiveService(db,createModels({}));let sends=0;
 const provider:EmailProvider={name:'fixture',profile:async()=>({emailAddress:businessMailbox,historyId:'1'}),send:async()=>{sends++;return {providerMessageId:'sent-'+sends,threadId:'thread'};},list:async()=>({messageIds:[]}),changes:async()=>({messageIds:[]}),get:async()=>null,findSent:async()=>[]};
 await db.query("INSERT INTO email_mailboxes(address,provider,enabled) VALUES($1,'gmail',true)",[businessMailbox]);await service.setStatus('RUNNING');
 return {db,service,provider,email:new BusinessEmail(service,provider),sends:()=>sends};
}
it('binds template, list, window and cap; out-of-bounds sends need exact individual approval even with communications disabled',async()=>{
 const f=await fixture();try{
 const c=await f.db.transaction(tx=>proposeCampaign(tx,definition(),'owner'));
 await expect(decideCampaign(f.service,c.id,'0'.repeat(64),'APPROVE')).rejects.toThrow('hash');
 await decideCampaign(f.service,c.id,c.hash,'APPROVE');
 const valid={campaignId:c.id,to:['first@example.com'],subject:definition().subject,text:definition().text};
 const changed=await f.db.transaction(tx=>proposeBusinessEmail(tx,{...valid,subject:'Different message'},'owner'));
 await f.db.query(`UPDATE company SET approval_policy=approval_policy || '{"communications":false}'`);
 await f.email.sendNext();expect(f.sends()).toBe(0);
 await f.db.transaction(tx=>proposeBusinessEmail(tx,valid,'owner'));await f.email.sendNext();expect(f.sends()).toBe(1);
 await f.db.transaction(tx=>proposeBusinessEmail(tx,{...valid,to:['second@example.com']},'owner'));await f.email.sendNext();expect(f.sends()).toBe(1);
 const action=await one(f.db,'SELECT * FROM actions WHERE id=$1',[changed.id]);await f.service.approveAction(action.id,action.action_hash,'APPROVE','Approve this exact exception');await f.email.sendNext();expect(f.sends()).toBe(2);
 const used=await one(f.db,'SELECT * FROM campaign_sends');expect(used.approval_hash).toBe(c.hash);
 await expect(f.db.query("UPDATE outreach_campaigns SET definition='{}' WHERE id=$1",[c.id])).rejects.toThrow('append-only');
 await expect(f.db.query('DELETE FROM campaign_sends')).rejects.toThrow('append-only');
 }finally{await f.db.close();}
});
it('retains uncertain campaign slots, honours revocation and time bounds',async()=>{
 const f=await fixture();try{
 const c=await f.db.transaction(tx=>proposeCampaign(tx,definition(),'owner'));await decideCampaign(f.service,c.id,c.hash,'APPROVE');
 const valid={campaignId:c.id,to:['first@example.com'],subject:definition().subject,text:definition().text};
 await f.db.transaction(tx=>proposeBusinessEmail(tx,valid,'owner'));let attempts=0;f.provider.send=async()=>{attempts++;throw new EmailProviderError('UNKNOWN',undefined,true);};await f.email.sendNext();await f.email.sendNext();expect(attempts).toBe(1);
 await f.db.transaction(tx=>proposeBusinessEmail(tx,{...valid,to:['second@example.com']},'owner'));await f.email.sendNext();expect(attempts).toBe(1);
 const future=await f.db.transaction(tx=>proposeCampaign(tx,{...definition(),startsAt:new Date(Date.now()+600000).toISOString()},'owner'));await decideCampaign(f.service,future.id,future.hash,'APPROVE');await f.db.transaction(tx=>proposeBusinessEmail(tx,{...valid,campaignId:future.id},'owner'));await f.email.sendNext();expect(attempts).toBe(1);
 await decideCampaign(f.service,c.id,c.hash,'REVOKE');expect((await f.db.query('SELECT * FROM campaign_sends')).rows).toHaveLength(1);
 }finally{await f.db.close();}
});
it('blocks all recipient fields after an opt-out, including approved mail, and records replies idempotently',async()=>{
 const f=await fixture();try{
 const message=await f.db.transaction(tx=>proposeBusinessEmail(tx,{to:['first@example.com'],bcc:['second@example.com'],subject:'Fixture',text:'Fixture'},'owner'));
 expect(message.draft.text).toContain('Reply STOP');expect(message.draft.text).toContain(businessMailbox);
 const action=await one(f.db,'SELECT * FROM actions WHERE id=$1',[message.id]);await f.service.approveAction(action.id,action.action_hash,'APPROVE','Fixture');
 const incoming:ProviderEmail={providerMessageId:'optout',threadId:'thread',direction:'INBOUND',from:['SECOND@example.com'],to:[businessMailbox],cc:[],bcc:[],replyTo:[],subject:'Re: Fixture',text:'STOP\n\n> prior content',html:'',receivedAt:new Date().toISOString(),headers:{'message-id':'<optout@example.com>'},attachments:[],bodyTruncated:false};
 await f.email.ingest(incoming);await f.email.ingest(incoming);expect((await f.db.query('SELECT * FROM do_not_contact')).rows).toHaveLength(1);
 await f.email.sendNext();expect(f.sends()).toBe(0);
 await expect(f.db.transaction(tx=>proposeBusinessEmail(tx,{to:['second@example.com'],subject:'Again',text:'No'},'owner'))).rejects.toThrow('Do-not-contact');
 await f.db.transaction(tx=>recordOptOut(tx,'first@example.com','Owner recorded request'));await expect(f.db.query('DELETE FROM do_not_contact')).rejects.toThrow('append-only');
 }finally{await f.db.close();}
});
