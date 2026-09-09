import {emailQueueStatus} from '../packages/runtime/src/email-status.js';
import {MockProvider} from '../packages/providers/src/index.js';
import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const {simpleParser}=createRequire(new URL('../packages/runtime/package.json',import.meta.url))('mailparser');
import {openDatabase,HiveService,createModels,BusinessEmail,proposeBusinessEmail,one,businessMailbox,EmailProviderError,Worker,setEmailPermission,type EmailProvider,type ProviderEmail,Organization} from '../packages/runtime/src/index.js';
const draft={to:['buyer@example.com'],cc:['cc@example.com'],bcc:['private@example.com'],subject:'Pilot proposal',text:'Plain text body',html:'<p>HTML body</p>',replyTo:'busywork@example.com',links:[{kind:'CAMPAIGN',id:'pilot'}]};
function incoming(id='g-in',threadId='thread-1'):ProviderEmail{return {providerMessageId:id,threadId,direction:'INBOUND',from:['buyer@example.com'],to:[businessMailbox],cc:[],bcc:[],replyTo:[],subject:'Re: Pilot proposal',text:'Interested. Tell me more.',html:'<script>bad()</script>',receivedAt:new Date().toISOString(),headers:{'message-id':'<reply@example.com>'},attachments:[{filename:'brief.pdf',mimeType:'application/pdf',size:200,providerAttachmentId:'attachment-1'}],bodyTruncated:false};}
async function fixture(){const db=await openDatabase(),service=new HiveService(db,createModels({}));await db.query("INSERT INTO email_mailboxes(address,provider,enabled) VALUES($1,'gmail',true)",[businessMailbox]);let sent=0;const raw:string[]=[];const provider:EmailProvider={name:'fixture',profile:async()=>({emailAddress:businessMailbox,historyId:'100'}),send:async value=>{sent++;raw.push(value);return {providerMessageId:'g-out',threadId:'thread-1'};},list:async()=>({messageIds:[]}),changes:async()=>({messageIds:[],historyId:'101'}),get:async id=>incoming(id),findSent:async()=>[]};return {db,service,provider,email:new BusinessEmail(service,provider),raw,sent:()=>sent};}
it('binds exact recipients, bodies and replies to approval and sends once',async()=>{
 const f=await fixture();try{
 const message=await f.db.transaction(tx=>proposeBusinessEmail(tx,draft,'owner'));await f.service.setStatus('RUNNING');await f.email.sendNext();expect(f.sent()).toBe(0);
 const action=await one(f.db,'SELECT * FROM actions WHERE id=$1',[message.id]);await f.service.approveAction(action.id,action.action_hash,'APPROVE','Fixture');await Promise.all([f.email.sendNext(),f.email.sendNext()]);await f.email.sendNext();expect(f.sent()).toBe(1);
 const parsed=await simpleParser(Buffer.from(f.raw[0],'base64url'));expect(parsed.to).toMatchObject({value:[{address:'buyer@example.com'}]});expect(parsed.bcc).toMatchObject({value:[{address:'private@example.com'}]});expect(parsed.html).toContain('HTML body');expect(parsed.messageId).toBe(message.rfc_message_id);
 expect((await one(f.db,'SELECT * FROM email_messages WHERE id=$1',[message.id])).provider_message_id).toBe('g-out');expect((await f.db.query('SELECT * FROM ledger')).rows).toHaveLength(0);
 const received=await f.email.ingest(incoming());const reply=await f.db.transaction(tx=>proposeBusinessEmail(tx,{to:['buyer@example.com'],subject:'Re: Pilot proposal',text:'Here are details.',replyToMessageId:received},'owner'));expect(reply.thread_id).toBe('thread-1');const replyMime=await simpleParser(Buffer.from(reply.raw_mime,'base64url'));expect(replyMime.inReplyTo).toBe('<reply@example.com>');expect(replyMime.references).toContain('<reply@example.com>');
 }finally{await f.db.close();}
});
it('deduplicates inbound delivery and associates thread, reference and contact context',async()=>{
 const f=await fixture();try{
 const message=await f.db.transaction(tx=>proposeBusinessEmail(tx,draft,'owner'));await f.db.query("UPDATE email_messages SET thread_id='thread-1' WHERE id=$1",[message.id]);await f.db.query("INSERT INTO email_entities(kind,id,label,addresses) VALUES('CUSTOMER','customer-1','Buyer',$1)",[JSON.stringify(['buyer@example.com'])]);
 const id=await f.email.ingest(incoming());expect(await f.email.ingest(incoming())).toBe(id);const links=(await f.db.query('SELECT * FROM email_links WHERE message_id=$1',[id])).rows;expect(links).toEqual(expect.arrayContaining([expect.objectContaining({kind:'CAMPAIGN',entity_id:'pilot',source:'THREAD'}),expect.objectContaining({kind:'CUSTOMER',entity_id:'customer-1',source:'ADDRESS'})]));expect((await f.db.query("SELECT * FROM messages WHERE sender_id='business-email'")).rows).toHaveLength(1);
 const ref=incoming('ref','different-thread');ref.headers['in-reply-to']=message.rfc_message_id;const refId=await f.email.ingest(ref);expect((await f.db.query('SELECT * FROM email_links WHERE message_id=$1',[refId])).rows).toEqual(expect.arrayContaining([expect.objectContaining({kind:'CAMPAIGN',source:'REFERENCE'})]));
 }finally{await f.db.close();}
});
it('keeps uncertain sends without retry and enforces policy, permission and daily limits',async()=>{
 const f=await fixture();try{
 const org=new Organization(f.service),ceo=await f.db.transaction(tx=>org.ensureCEO(tx));await f.db.query('INSERT INTO email_permissions(employee_id,can_read,can_send) VALUES($1,true,false)',[ceo.id]);await expect(f.db.transaction(tx=>proposeBusinessEmail(tx,draft,ceo.id))).rejects.toThrow('permission');
 const id=randomUUID();await f.db.transaction(tx=>proposeBusinessEmail(tx,draft,'owner',undefined,id));await f.db.transaction(tx=>proposeBusinessEmail(tx,draft,'owner',undefined,id));await expect(f.db.transaction(tx=>proposeBusinessEmail(tx,{...draft,subject:'Changed'},'owner',undefined,id))).rejects.toThrow('different');
 await f.service.setStatus('RUNNING');await f.db.query("UPDATE company SET approval_policy=approval_policy || '{\"communications\":false}'");let attempts=0;f.provider.send=async()=>{attempts++;throw new EmailProviderError('CONNECTION_FAILED',undefined,true);};await f.email.sendNext();await f.email.recover();await f.email.sendNext();expect(attempts).toBe(1);expect((await one(f.db,'SELECT status FROM email_messages WHERE id=$1',[id])).status).toBe('UNCERTAIN');
 await f.db.query('UPDATE email_mailboxes SET daily_send_limit=1');await f.db.transaction(tx=>proposeBusinessEmail(tx,{...draft,subject:'Next'},'owner'));await f.email.sendNext();expect(attempts).toBe(1);
 }finally{await f.db.close();}
});
it('advances sync cursors only after ingestion, survives repeats and resets stale Gmail history',async()=>{
 const f=await fixture();try{
 f.provider.list=async()=>({messageIds:['one']});f.provider.get=async id=>incoming(id);await f.email.sync();expect((await one(f.db,'SELECT sync_state FROM email_mailboxes')).sync_state).toEqual({historyId:'100'});
 f.provider.changes=async()=>({messageIds:['one','two'],historyId:'102'});await f.email.sync();expect((await f.db.query('SELECT id FROM email_messages')).rows).toHaveLength(2);
 f.provider.get=async()=>{throw new Error('fixture connection');};await expect(f.email.sync()).rejects.toThrow();expect((await one(f.db,'SELECT sync_state FROM email_mailboxes')).sync_state.historyId).toBe('102');
 f.provider.changes=async()=>{throw new EmailProviderError('NOT_FOUND',404);};await f.email.sync();expect((await one(f.db,'SELECT sync_state FROM email_mailboxes')).sync_state).toEqual({});
 }finally{await f.db.close();}
});

it('recovers an original uncertain send from inbound sync without a replacement',async()=>{
 const f=await fixture();try{
 const message=await f.db.transaction(tx=>proposeBusinessEmail(tx,draft,'owner'));await f.db.query("UPDATE email_messages SET status='UNCERTAIN' WHERE id=$1",[message.id]);await f.db.query("UPDATE actions SET status='UNCERTAIN' WHERE id=$1",[message.id]);
 const received={...incoming('sent-original'),direction:'OUTBOUND' as const,from:[businessMailbox],to:draft.to,cc:draft.cc,bcc:draft.bcc,subject:draft.subject,headers:{'message-id':message.rfc_message_id}};
 expect(await f.email.ingest(received)).toBe(message.id);expect((await one(f.db,'SELECT * FROM email_messages WHERE id=$1',[message.id])).status).toBe('SENT');expect(f.sent()).toBe(0);expect((await f.db.query('SELECT id FROM email_messages')).rows).toHaveLength(1);
 }finally{await f.db.close();}
});
it('requires owner authentication for email controls and protects frozen outbound MIME',async()=>{
 const f=await fixture();const {buildApp}=await import('../apps/api/src/app.js');const app=buildApp({service:f.service,email:f.email,ownerToken:'email-fixture-owner',logger:false});try{
 const request={requestId:randomUUID(),email:draft};expect((await app.inject({method:'POST',url:'/v1/email/proposals',payload:request})).statusCode).toBe(401);
 const response=await app.inject({method:'POST',url:'/v1/email/proposals',payload:request,headers:{authorization:'Bearer email-fixture-owner'}});expect(response.statusCode).toBe(200);
 expect((await app.inject({url:'/v1/email/messages/'+request.requestId})).statusCode).toBe(401);await expect(f.db.query("UPDATE email_messages SET raw_mime='changed' WHERE id=$1",[request.requestId])).rejects.toThrow('immutable');
 }finally{await app.close();await f.db.close();}
});

it('applies reviewed email tools and prevents permission escalation or later revoked dispatch',async()=>{
 const f=await fixture();try{
 const org=new Organization(f.service),ceo=await f.db.transaction(tx=>org.ensureCEO(tx));const provider=new MockProvider(),generate=provider.generate.bind(provider);
 provider.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK')(result.output as any).operations=[{type:'BUSINESS_EMAIL_SEND',target:businessMailbox,title:'Buyer email',instructions:'Propose exact email for approval.',email:draft,budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];return result;};f.service.models.find(m=>m.id==='mock-worker')!.adapter=provider;
 const task=await f.service.createTask({objective:'Prepare buyer email',employeeId:ceo.id,modelId:'mock-worker',tokenBudget:150000});await f.service.setStatus('RUNNING');const worker=new Worker(f.service);for(let i=0;i<3;i++)await worker.runNext();await org.applyOperations(task.id);await org.applyOperations(task.id);
 const mail=await one(f.db,"SELECT * FROM email_messages WHERE direction='OUTBOUND'");expect(mail.author_id).toBe(ceo.id);expect((await f.db.query('SELECT * FROM email_messages')).rows).toHaveLength(1);
 const action=await one(f.db,'SELECT * FROM actions WHERE id=$1',[mail.id]);await f.service.approveAction(action.id,action.action_hash,'APPROVE','Fixture');await f.db.transaction(tx=>setEmailPermission(tx,'owner',ceo.id,{canRead:false,canSend:false}));await f.email.sendNext();expect(f.sent()).toBe(0);
 await expect(f.db.transaction(tx=>setEmailPermission(tx,ceo.id,ceo.id,{canRead:true,canSend:true}))).rejects.toThrow('do not hold');await f.email.ingest(incoming());expect((await f.db.query("SELECT * FROM messages WHERE sender_id='business-email' AND recipient_id=$1",[ceo.id])).rows).toHaveLength(0);
 }finally{await f.db.close();}
});

it('explains queue blockers from current policy without changing or dispatching messages',async()=>{
 const f=await fixture();try{
  const {emailQueueStatus}=await import('../packages/runtime/src/email-status.js');
  const m=await f.db.transaction(tx=>proposeBusinessEmail(tx,draft,'owner'));
  let status=(await emailQueueStatus(f.db,f.service.now()))[m.id];
  expect(status.reasons.map(x=>x.code)).toEqual(expect.arrayContaining(['AWAITING_APPROVAL','CONNECTION_REQUIRED','COMPANY_STOPPED']));
  await f.service.setStatus('RUNNING');
  await f.db.query("UPDATE company SET approval_policy=approval_policy || '{\"communications\":false}'");
  await f.db.query("UPDATE email_mailboxes SET credential_ciphertext='fixture-only'");
  status=(await emailQueueStatus(f.db,f.service.now()))[m.id];expect(status.reasons).toEqual([]);
  await f.db.query("UPDATE email_mailboxes SET enabled=false");
  expect((await emailQueueStatus(f.db,f.service.now()))[m.id].reasons.map(x=>x.code)).toContain('MAILBOX_DISABLED');
  expect((await emailQueueStatus(f.db,new Date(Date.now()+2*86400000)))[m.id].reasons.map(x=>x.code)).toContain('EXPIRED');
  const snapshot=await f.service.snapshot();expect(snapshot.emailQueueStatus[m.id]).toBeDefined();
  expect(f.sent()).toBe(0);expect((await one(f.db,'SELECT status FROM email_messages WHERE id=$1',[m.id])).status).toBe('QUEUED');
 }finally{await f.db.close();}
});

it('sends approved mail behind more than one batch of waiting proposals without probing idle queues',async()=>{
 const f=await fixture();try{
  let profiles=0;f.provider.profile=async()=>{profiles++;return {emailAddress:businessMailbox,historyId:'1'};};
  await f.service.setStatus('RUNNING');
  for(let i=0;i<101;i++)await f.db.transaction(tx=>proposeBusinessEmail(tx,{...draft,subject:'Waiting '+i},'owner'));
  await f.email.sendNext();expect(profiles).toBe(0);expect(f.sent()).toBe(0);
  const m=await f.db.transaction(tx=>proposeBusinessEmail(tx,{...draft,subject:'Approved later'},'owner'));
  const action=await one(f.db,'SELECT * FROM actions WHERE id=$1',[m.id]);await f.service.approveAction(m.id,action.action_hash,'APPROVE','Fixture');
  await f.email.sendNext();expect(f.sent()).toBe(1);expect(profiles).toBe(1);
  expect((await one(f.db,'SELECT status FROM email_messages WHERE id=$1',[m.id])).status).toBe('SENT');
  expect((await f.db.query("SELECT id FROM email_messages WHERE status='QUEUED'")).rows).toHaveLength(101);
 }finally{await f.db.close();}
});

it('withdraws an email for revision and keeps the new draft approval-gated when communications are automatic',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE company SET ceo_model_id='mock-worker',approval_policy=approval_policy || '{\"communications\":false}'::jsonb WHERE id=1");
  const message=await f.db.transaction(tx=>proposeBusinessEmail(tx,draft,'owner'));
  const original=await one(f.db,'SELECT * FROM actions WHERE id=$1',[message.id]);
  const revision=await new Organization(f.service).requestProposalChanges(message.id,original.action_hash,'Shorten the text.');
  const task=await one(f.db,'SELECT * FROM tasks WHERE id=$1',[revision.taskId]);
  const revised=await f.db.transaction(tx=>proposeBusinessEmail(tx,{...draft,text:'Shorter body'},task.employee_id,task.id));
  await f.service.setStatus('RUNNING');await f.email.sendNext();expect(f.sent()).toBe(0);
  expect((await emailQueueStatus(f.db,f.service.now()))[revised.id].reasons.some((r:any)=>r.code==='AWAITING_APPROVAL')).toBe(true);
  const action=await one(f.db,'SELECT * FROM actions WHERE id=$1',[revised.id]);expect(action.revises_action_id).toBe(original.id);
  await f.service.approveAction(action.id,action.action_hash,'APPROVE','Accept revision');await f.email.sendNext();expect(f.sent()).toBe(1);
  expect((await one(f.db,'SELECT * FROM email_messages WHERE id=$1',[message.id])).raw_mime).toBe(message.raw_mime);
  expect(f.raw[0]).toBe(revised.raw_mime);
 }finally{await f.db.close();}
});
it('freezes exact document attachment versions into the approved MIME',async()=>{
 const f=await fixture();try{
  const {writeDocument}=await import('../packages/runtime/src/documents.js');
  await f.db.transaction(tx=>writeDocument(tx,{path:'delivery/checklist.md',title:'Checklist',content:'Original checked deliverable',expectedVersion:0},'owner'));
  const attachmentDraft={...draft,documentAttachments:[{path:'delivery/checklist.md',version:1,filename:'checklist.md'}]};
  const message=await f.db.transaction(tx=>proposeBusinessEmail(tx,attachmentDraft,'owner'));
  await f.db.transaction(tx=>writeDocument(tx,{path:'delivery/checklist.md',title:'Checklist',content:'Changed after proposal',expectedVersion:1},'owner'));
  const repeated=await f.db.transaction(tx=>proposeBusinessEmail(tx,attachmentDraft,'owner',undefined,message.id));expect(repeated.raw_mime).toBe(message.raw_mime);
  const parsed=await simpleParser(Buffer.from(message.raw_mime,'base64url'));expect(parsed.attachments).toHaveLength(1);expect(parsed.attachments[0].content.toString()).toBe('Original checked deliverable');
  const action=await one(f.db,'SELECT * FROM actions WHERE id=$1',[message.id]);expect(action.payload.attachments[0]).toMatchObject({filename:'checklist.md',version:1,path:'delivery/checklist.md'});
  await f.service.setStatus('RUNNING');await f.email.sendNext();expect(f.sent()).toBe(0);await f.service.approveAction(action.id,action.action_hash,'APPROVE','Approve frozen attachment');await f.email.sendNext();expect(f.sent()).toBe(1);expect(f.raw[0]).toBe(message.raw_mime);
  await expect(f.db.transaction(tx=>proposeBusinessEmail(tx,{...draft,documentAttachments:[{path:'delivery/checklist.md',version:99,filename:'missing.md'}]},'owner'))).rejects.toThrow();
  await expect(f.db.transaction(tx=>proposeBusinessEmail(tx,{...draft,documentAttachments:[{path:'../../.env',version:1,filename:'secret.txt'}]},'owner'))).rejects.toThrow();
 }finally{await f.db.close();}
});
