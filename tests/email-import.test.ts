import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase,HiveService,createModels,Organization,Workspaces,GmailEmailProvider,BusinessEmail,businessMailbox} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
import {cacheTextAttachment,importEmailAttachment} from '../packages/runtime/src/email-attachments.js';

it('caches small customer text attachments and imports exact bytes through a reviewed employee operation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'busywork-inbound-test-')),db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));service.workspaces=new Workspaces(root);const org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
  await db.query("INSERT INTO email_mailboxes(address,provider) VALUES($1,'gmail')",[businessMailbox]);
  let attachmentReads=0;const provider=new GmailEmailProvider(async()=>'fixture',async url=>{
   if(String(url).includes('/attachments/')){attachmentReads++;return new Response(JSON.stringify({data:Buffer.from('name\nAlice\n').toString('base64url')}));}
   return new Response(JSON.stringify({id:'inbound1',threadId:'thread1',internalDate:'1788900000000',labelIds:['INBOX'],payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:'buyer@example.com'},{name:'To',value:businessMailbox}],parts:[{filename:'customer.csv',mimeType:'text/csv',body:{size:11,attachmentId:'csv1'}},{filename:'large.csv',mimeType:'text/csv',body:{size:49000,attachmentId:'large'}},{filename:'drawing.pdf',mimeType:'application/pdf',body:{size:100,attachmentId:'pdf1'}}]}}));
  });
  const message=(await provider.get('inbound1'))!;expect(attachmentReads).toBe(1);expect(message.attachments[0]).toMatchObject({textCacheStatus:'CACHED',textContent:'name\nAlice\n'});expect(message.attachments[1]!.textCacheStatus).toBe('TOO_LARGE');expect(message.attachments[2]!.textCacheStatus).toBe('UNSUPPORTED');
  const email=new BusinessEmail(service,provider),emailId=await email.ingest(message);expect(await email.ingest(message)).toBe(emailId);
  const {buildApp}=await import('../apps/api/src/app.js');const app=buildApp({service,ownerToken:'inbound-fixture-owner',logger:false});try{
   const url='/v1/email/messages/'+emailId+'/attachments/0';expect((await app.inject({url})).statusCode).toBe(401);
   const response=await app.inject({url,headers:{authorization:'Bearer inbound-fixture-owner'}});expect(response.statusCode).toBe(200);expect(response.body).toBe('name\nAlice\n');
  }finally{await app.close();}
  const task=await service.createTask({objective:'Inspect customer input',employeeId:ceo.id});const artifact=(await new MockProvider().generate({input:{phase:'WORK'}} as any)).output as any;
  artifact.operations=[{type:'IMPORT_EMAIL_ATTACHMENT',target:emailId,resultIndex:0,title:'Import customer file',instructions:'Import for inspection before processing.',budgetUsd:'0',tokenBudget:60000,modelId:'mock-worker',participants:[],scheduledAt:null}];
  await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[task.id,JSON.stringify(artifact)]);await service.setStatus('RUNNING');await org.applyOperations(task.id);await org.applyOperations(task.id);
  const notices=(await db.query("SELECT body FROM messages WHERE subject='Email attachment imported'")).rows;expect(notices).toHaveLength(1);const result=JSON.parse(notices[0]!.body);expect((await service.workspaces.read(ceo.id,result.path)).content).toBe('name\nAlice\n');expect(attachmentReads).toBe(1);
  await db.query('INSERT INTO email_permissions(employee_id,can_read,can_send) VALUES($1,false,false)',[ceo.id]);await expect(importEmailAttachment(db,service.workspaces,ceo.id,emailId,0)).rejects.toThrow('permission');
  expect((await cacheTextAttachment({filename:'bad.csv',mimeType:'text/csv',size:1},async()=>Buffer.from([255]).toString('base64url'))).textCacheStatus).toBe('INVALID_CONTENT');
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});
