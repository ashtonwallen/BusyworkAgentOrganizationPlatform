import {MockProvider} from '../packages/providers/src/index.js';
import {readAccounting,readLedgerEntry} from '../packages/runtime/src/accounting-history.js';
import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {openDatabase,HiveService,createModels,Organization,linkTaskExperiment,experimentEconomics} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';
it('attributes delegated costs exactly without rewriting cash, honors overrides, and separates holds and owner time',async()=>{
 const db=await openDatabase(),service=new HiveService(db,createModels({})),org=new Organization(service);const app=buildApp({service,ownerToken:'economics-fixture',logger:false});try{
 const ceo=await db.transaction(tx=>org.ensureCEO(tx));
 const create=()=>service.createExperiment({title:'Small test',hypothesis:'Untested',customer:'Buyer',offer:'Checklist',channel:'Email',price:'20',maxLossUsd:'0',successCriteria:'Paid sale',killCriteria:'Deadline',deadline:new Date(Date.now()+86400000).toISOString()});
 const a=await create(),b=await create();
 const parent=await service.createTask({objective:'Fulfill test',employeeId:ceo.id,experimentId:a.id,ttlMinutes:120});
 const child=await service.createTask({objective:'Prepare output',parentId:parent.id,employeeId:ceo.id,ttlMinutes:60});
 const untagged=await service.createTask({objective:'General administration'});
 async function call(taskId:string,status:string){const id=randomUUID();await db.query("INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,token_reserved,budget_day) VALUES($1,$2,'WORK',1,'fixture','openai',true,$3,300000,100,CURRENT_DATE)",[id,taskId,status]);return id;}
 const settled=await call(child.id,'SUCCEEDED'),unknown=await call(untagged.id,'UNCERTAIN');
 async function money(kind:string,amount:string,taskId:string|null,experimentId:string|null,callId:string|null,account='OPERATING') {const id=randomUUID();await db.query('INSERT INTO ledger(id,idempotency_key,account,kind,amount,task_id,experiment_id,call_id,description) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8)',[id,account,kind,amount,taskId,experimentId,callId,'Fixture']);}
 await money('COST','123456',child.id,null,settled);await money('COST','700',child.id,b.id,settled);await money('COST','5',untagged.id,null,unknown);await money('COST','999',child.id,a.id,settled,'TEST');
 await money('REVENUE','20000000',null,a.id,null,'BUSINESS');await money('REFUND','1000000',null,a.id,null,'BUSINESS');await money('COST','2000000',null,a.id,null,'BUSINESS');
 await db.query("UPDATE calls SET status='UNCERTAIN' WHERE id=$1",[settled]);
 await db.query("INSERT INTO owner_requests(id,title,details,status,minutes,experiment_id) VALUES('effort','Intake','Fixture','DONE',12,$1),('open','Pending','Fixture','OPEN',99,$1)",[a.id]);
 const before=(await db.query('SELECT * FROM ledger ORDER BY id')).rows;
 let report=await experimentEconomics(db);expect(report.experiments.find(x=>x.experimentId===a.id)).toMatchObject({modelCostsMicroUsd:'123456',otherCostsMicroUsd:'2000000',netMicroUsd:'16876544',reservedModelCostsMicroUsd:'300000',unresolvedCalls:1,ownerMinutes:12});expect(report.experiments.find(x=>x.experimentId===b.id)?.modelCostsMicroUsd).toBe('700');expect(report.unattributedModelCostsMicroUsd).toBe('5');
 expect((await app.inject({method:'PUT',url:'/v1/tasks/'+child.id+'/experiment',payload:{experimentId:null}})).statusCode).toBe(401);
 await expect(db.transaction(tx=>linkTaskExperiment(tx,child.id,b.id,'unrelated'))).rejects.toThrow('unavailable');
 expect((await app.inject({method:'PUT',url:'/v1/tasks/'+child.id+'/experiment',headers:{authorization:'Bearer economics-fixture'},payload:{experimentId:null}})).statusCode).toBe(200);
 await db.transaction(tx=>linkTaskExperiment(tx,child.id,null,ceo.id));
 report=(await service.snapshot()).experimentEconomics;expect(report.unattributedModelCostsMicroUsd).toBe('123461');expect(report.experiments.find(x=>x.experimentId===a.id)?.modelCostsMicroUsd).toBe('0');expect(report.experiments.find(x=>x.experimentId===b.id)?.modelCostsMicroUsd).toBe('700');
 expect((await db.query("SELECT * FROM events WHERE type='task.experiment_linked' AND entity_id=$1",[child.id])).rows).toHaveLength(1);
 expect((await db.query('SELECT * FROM ledger ORDER BY id')).rows).toEqual(before);
 }finally{await app.close();await db.close();}
});

it('recalls full accounting with stable timestamp paging and bounded immutable entry details',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
 const e=await service.createExperiment({title:'Test',hypothesis:'Untested',customer:'Buyer',offer:'Checklist',channel:'Email',price:'20',maxLossUsd:'0',successCriteria:'Payment',killCriteria:'Deadline',deadline:new Date(Date.now()+86400000).toISOString()});
 const task=await service.createTask({objective:'Prepare',employeeId:ceo.id,experimentId:e.id});
 const description='Recorded description '.repeat(500);
 await db.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,task_id,description,occurred_at) SELECT 'entry-'||n,'entry-'||n,'BUSINESS','COST',1,$1,$2,'2026-09-09 01:00:00.123456+00' FROM generate_series(1,22)n",[task.id,description]);
 await db.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,description) VALUES('test','test','TEST','COST',1,'Fixture'),('general','general','BUSINESS','FUNDING',1,'Fixture')");
 const first=await readAccounting(db,ceo.id,e.id);expect(first.entries).toHaveLength(15);expect(first.experiment?.otherCostsMicroUsd).toBe('22');expect(first.entries[0].description_truncated).toBe(true);
 const second=await readAccounting(db,ceo.id,e.id,first.nextBefore);expect(second.entries).toHaveLength(7);expect(second.nextBefore).toBeNull();expect(new Set([...first.entries,...second.entries].map(x=>x.id)).size).toBe(22);
 expect((await readAccounting(db,ceo.id,'unattributed')).entries.map(x=>x.id)).toEqual(['general']);
 const artifact=(await new MockProvider().generate({input:{phase:'WORK'}} as any)).output as any;
 artifact.operations=[{type:'READ_ACCOUNTING',target:e.id,title:'Inspect costs',instructions:'Inspect recorded accounting.',budgetUsd:'0',tokenBudget:60000,modelId:'mock-worker',participants:[],scheduledAt:null}];
 await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[task.id,JSON.stringify(artifact)]);await service.setStatus('RUNNING');await org.applyOperations(task.id);await org.applyOperations(task.id);
 const messages=(await db.query("SELECT body FROM messages WHERE task_id=$1 AND subject='Accounting result'",[task.id])).rows;expect(messages).toHaveLength(1);expect(JSON.parse(messages[0].body).entries).toHaveLength(15);

 const id=first.entries[0].id;let offset=0,content='',hash;do{const page=await readLedgerEntry(db,ceo.id,id,offset);expect(page.content.length).toBeLessThanOrEqual(4000);if(hash)expect(page.resultHash).toBe(hash);hash=page.resultHash;content+=page.content;if(page.nextOffset===null)break;offset=page.nextOffset;}while(true);expect(JSON.parse(content).description).toBe(description);
 await expect(readAccounting(db,'stranger','company')).rejects.toThrow('active employee');await expect(readLedgerEntry(db,ceo.id,'test')).rejects.toThrow('unavailable');
 await db.transaction(tx=>linkTaskExperiment(tx,task.id,null,'owner'));expect((await readAccounting(db,ceo.id,e.id)).entries).toHaveLength(0);expect((await readAccounting(db,ceo.id,e.id)).attributionRevision).not.toBe(first.attributionRevision);
 }finally{await db.close();}
});
