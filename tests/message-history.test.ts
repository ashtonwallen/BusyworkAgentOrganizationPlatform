import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,Worker} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
import {findMessages,readMessage} from '../packages/runtime/src/message-history.js';
it('recovers older messages with stable pagination, full content and private-channel boundaries',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service);const ceo=await db.transaction(tx=>org.ensureCEO(tx));
 await db.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,created_at) SELECT 'history-'||lpad(n::text,3,'0'),'owner',$1,'MESSAGE','Decision '||n,'handoff '||repeat('x',5000),'2026-09-09T00:00:00.123456Z' FROM generate_series(1,25) n",[ceo.id]);
 await db.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body) VALUES('private-other','other-agent','other-recipient','MESSAGE','Private','hidden')");
 const first=await findMessages(db,ceo.id,'handoff');expect(first.messages).toHaveLength(20);expect(first.nextBefore).toBeTruthy();
 const second=await findMessages(db,ceo.id,'handoff',first.nextBefore);expect(second.messages).toHaveLength(5);expect(new Set([...first.messages,...second.messages].map(m=>m.id)).size).toBe(25);
 const start=await readMessage(db,ceo.id,first.messages[0]!.id);const end=await readMessage(db,ceo.id,first.messages[0]!.id,start.nextOffset!);expect(start.content.length).toBe(4000);expect(end.contentHash).toBe(start.contentHash);expect(end.nextOffset).toBeNull();
 await expect(readMessage(db,ceo.id,'private-other')).rejects.toThrow('unavailable');await expect(findMessages(db,ceo.id,'*','private-other')).rejects.toThrow('unavailable');
 const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);adapter.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK')(result.output as any).operations=[{type:'FIND_MESSAGES',target:'handoff',title:'Recall handoff',instructions:'Read older correspondence.',budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];return result;};service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
 const task=await service.createTask({objective:'Recover prior handoff',employeeId:ceo.id,modelId:'mock-worker',tokenBudget:150000});await service.setStatus('RUNNING');const worker=new Worker(service);for(let i=0;i<3;i++)await worker.runNext();await org.applyOperations(task.id);await org.applyOperations(task.id);
 const result=(await db.query("SELECT body FROM messages WHERE task_id=$1 AND subject='Message search results'",[task.id])).rows;expect(result).toHaveLength(1);expect(JSON.parse((result[0] as any).body).messages).toHaveLength(20);
 }finally{await db.close();}
});
