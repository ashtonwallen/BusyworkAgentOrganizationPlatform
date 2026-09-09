import {internalRead,internalReadContext} from '../packages/runtime/src/internal-reads.js';
import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,Worker,businessMailbox} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
import {readBusinessEmail} from '../packages/runtime/src/email-history.js';

it('recovers older mailbox entries and complete stored content through permission-checked email operations',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
  await db.query("INSERT INTO email_mailboxes(address,provider) VALUES($1,'gmail')",[businessMailbox]);
  const text='A quoted "customer requirement"\n'.repeat(3000);
  const content={from:['buyer@example.com'],to:[businessMailbox],subject:'Requirements',text,html:'',bodyTruncated:true,headers:{'in-reply-to':'<original@example.com>'},attachments:[{filename:'brief.pdf',size:400}]};
  await db.query("INSERT INTO email_messages(id,mailbox,direction,status,thread_id,content,received_at) SELECT 'email-history-'||lpad(n::text,3,'0'),$1,'INBOUND','RECEIVED','thread-1',$2,'2026-09-09T00:00:00.123456Z' FROM generate_series(1,35) n",[businessMailbox,JSON.stringify(content)]);
  const first=await readBusinessEmail(db,ceo.id,'inbox');expect(first.messages).toHaveLength(30);
  const second=await readBusinessEmail(db,ceo.id,'inbox',first.nextBefore);expect(second.messages).toHaveLength(5);expect(second.nextBefore).toBeNull();
  expect(new Set([...first.messages!,...second.messages!].map(m=>m.id)).size).toBe(35);
  const {buildApp}=await import('../apps/api/src/app.js');const app=buildApp({service,ownerToken:'email-history-fixture',logger:false});
  try{
   expect((await app.inject({url:'/v1/email/history'})).statusCode).toBe(401);
   const headers={authorization:'Bearer email-history-fixture'};
   const firstPage=await app.inject({url:'/v1/email/history',headers});expect(firstPage.statusCode).toBe(200);expect(firstPage.json().messages).toHaveLength(30);
   const lastPage=await app.inject({url:'/v1/email/history?before='+firstPage.json().nextBefore,headers});expect(lastPage.statusCode).toBe(200);expect(lastPage.json().messages).toHaveLength(5);expect(lastPage.json().nextBefore).toBeNull();
  }finally{await app.close();}
  let offset=0,joined='',hash='';
  while(true){const page=await readBusinessEmail(db,ceo.id,'email-history-035',null,offset);expect(page.content!.length).toBeLessThanOrEqual(4000);expect(page.sourceBodyTruncated).toBe(true);expect(page.complete).toBe(false);if(hash)expect(page.contentHash).toBe(hash);hash=page.contentHash!;joined+=page.content;if(page.nextOffset===null)break;offset=page.nextOffset!;}
  const recovered=JSON.parse(joined);expect(recovered.content.text).toBe(text);expect(recovered.content.headers).toEqual(content.headers);expect(recovered.content.attachments).toEqual(content.attachments);expect(recovered.thread_id).toBe('thread-1');
  await expect(readBusinessEmail(db,ceo.id,'inbox','missing')).rejects.toThrow('cursor');
  await expect(readBusinessEmail(db,ceo.id,'email-history-035',null,9999999)).rejects.toThrow('offset');
  const provider=new MockProvider(),generate=provider.generate.bind(provider);provider.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK')(result.output as any).operations=[{type:'BUSINESS_EMAIL_READ',target:'email-history-035',title:'Read customer requirements',instructions:'Inspect stored email.',budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];return result;};service.models.find(m=>m.id==='mock-worker')!.adapter=provider;
  const task=await service.createTask({objective:'Inspect customer requirements',employeeId:ceo.id,modelId:'mock-worker',tokenBudget:150000});await service.setStatus('RUNNING');const worker=new Worker(service);for(let i=0;i<3;i++)await worker.runNext();await org.applyOperations(task.id);await org.applyOperations(task.id);
  const notices=(await db.query("SELECT body FROM messages WHERE task_id=$1 AND subject='Email tool result'",[task.id])).rows;expect(notices).toHaveLength(1);expect(JSON.parse(notices[0]!.body)).toMatchObject({trust:'UNTRUSTED_EXTERNAL_CONTENT',data:{offset:0,nextOffset:4000,contentHash:hash}});
  const found=await db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'EMAIL_FIND',target:'quoted "customer requirement"'})) as any;expect(found.messages).toHaveLength(30);const older=await db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'EMAIL_FIND',target:'quoted "customer requirement"',before:found.nextBefore})) as any;expect(older.messages).toHaveLength(5);expect(found.messages[0].content).toBeUndefined();
  expect((await db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'EMAIL_FIND',target:'buyer@example.com'})) as any).messages).toHaveLength(30);expect((await db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'EMAIL_FIND',target:'%'})) as any).messages).toHaveLength(0);
  const cached={employeeId:ceo.id,request:{type:'EMAIL_FIND',target:'Requirements'},result:found};
  await db.query('INSERT INTO email_permissions(employee_id,can_read,can_send) VALUES($1,false,false)',[ceo.id]);
  expect((await db.transaction(tx=>internalReadContext(tx,ceo.id,cached)))?.result).toBeNull();
  await expect(db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'EMAIL_FIND',target:'Requirements'}))).rejects.toThrow('permission');
  await expect(readBusinessEmail(db,ceo.id,'inbox')).rejects.toThrow('permission');await expect(readBusinessEmail(db,ceo.id,'email-history-035',null,4000)).rejects.toThrow('permission');
 }finally{await db.close();}
});
