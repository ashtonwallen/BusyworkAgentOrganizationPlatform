import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,Worker,saveBusinessEntity} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';

it('lets a reviewed employee maintain a record and link prior email without sending or duplicating it',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({})),org=new Organization(service),employee=await db.transaction(tx=>org.ensureCEO(tx));
  await db.query("INSERT INTO email_mailboxes(address,provider) VALUES('busywork@example.com','gmail')");
  await db.query("INSERT INTO email_messages(id,mailbox,direction,status,content) VALUES('prior','busywork@example.com','INBOUND','RECEIVED',$1)",[JSON.stringify({from:['Buyer@Example.com'],to:['busywork@example.com'],subject:'Question'})]);
  const entity={kind:'PROSPECT',id:'buyer-fixture',label:'Reachable buyer hypothesis',addresses:['Buyer@Example.com','buyer@example.com']};
  const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);
  adapter.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK'){
   (result.output as any).operations=[{type:'BUSINESS_ENTITY_SET',businessEntity:entity,target:'buyer-fixture',title:'Record prospect',instructions:'Record supplied address.',budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null},{type:'BUSINESS_ENTITY_FIND',target:'buyer@example.com',title:'Find prospect',instructions:'Find matching record.',budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];
  }return result;};service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
  const task=await service.createTask({objective:'Organize supplied buyer contact',employeeId:employee.id,modelId:'mock-worker'});
  await service.setStatus('RUNNING');const worker=new Worker(service);for(let n=0;n<3;n++)await worker.runNext();
  await org.applyOperations(task.id);await org.applyOperations(task.id);
  expect((await db.query<any>('SELECT addresses FROM email_entities')).rows[0].addresses).toEqual(['buyer@example.com']);
  expect((await db.query('SELECT source FROM email_links')).rows).toEqual([{source:'ADDRESS'}]);
  await db.transaction(tx=>saveBusinessEntity(tx,{...entity,label:'Updated label',expected:{label:entity.label,addresses:entity.addresses}},employee.id));
  await expect(db.transaction(tx=>saveBusinessEntity(tx,{...entity,label:'Stale overwrite',expected:{label:entity.label,addresses:entity.addresses}},employee.id))).rejects.toThrow('changed');
  await expect(db.transaction(tx=>saveBusinessEntity(tx,{...entity,label:'Blind overwrite'},'owner'))).rejects.toThrow('prior values');
  await db.transaction(tx=>saveBusinessEntity(tx,{...entity,label:'Updated label'},employee.id));
  expect((await db.query<any>('SELECT label FROM email_entities')).rows[0].label).toBe('Updated label');
  const edits=await Promise.allSettled(['First edit','Second edit'].map(label=>db.transaction(tx=>saveBusinessEntity(tx,{...entity,label,expected:{label:'Updated label',addresses:entity.addresses}},employee.id))));
  expect(edits.filter(edit=>edit.status==='fulfilled')).toHaveLength(1);
  expect(edits.filter(edit=>edit.status==='rejected')).toHaveLength(1);
  expect((await db.query('SELECT * FROM email_entities')).rows).toHaveLength(1);
  expect((await db.query('SELECT * FROM email_links')).rows).toHaveLength(1);
  expect((await db.query('SELECT * FROM actions')).rows).toHaveLength(0);
  const messages=(await db.query<any>('SELECT body FROM messages WHERE task_id=$1',[task.id])).rows;
  expect(messages).toHaveLength(1);expect(JSON.parse(messages[0].body).records[0].id).toBe(entity.id);
  await expect(db.transaction(tx=>saveBusinessEntity(tx,entity,'unknown'))).rejects.toThrow('active employee');
  await expect(db.transaction(tx=>saveBusinessEntity(tx,{...entity,addresses:['not-an-email']},'owner'))).rejects.toThrow();
 }finally{await db.close();}
});
