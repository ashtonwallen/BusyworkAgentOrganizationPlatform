import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,one,event,resetBusiness,resetPreview,Workspaces} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';

it('archives business history atomically, preserves setup and starts a fresh paused run',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));service.workspaces=new Workspaces('test-old-workspace');
  const task=await service.createTask({objective:'Old test work'});
  await service.createRecord({kind:'NOTE',title:'Old idea',body:'Discard from the active business.'});
  await db.query("INSERT INTO email_mailboxes(address,provider,enabled,credential_ciphertext,sync_state) VALUES('busywork@example.com','gmail',true,'encrypted-fixture','{\"historyId\":\"cursor\"}')");
  await db.transaction(tx=>event(tx,'model.spending_caps_updated','openai',{enabled:false},'owner'));
  expect((await service.snapshot()).businessGeneration).toBe('initial');
  const preview=await resetPreview(service);
  const result=await resetBusiness(service,preview.revision,'test-workspace-generations');
  expect((await one(db,'SELECT status FROM company')).status).toBe('PAUSED');
  expect((await db.query('SELECT * FROM tasks')).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM company_records')).rows).toHaveLength(0);
  expect((await one(db,`SELECT id FROM ${result.archive}.tasks`)).id).toBe(task.id);
  expect((await one(db,'SELECT enabled,credential_ciphertext,sync_state FROM email_mailboxes'))).toEqual({enabled:false,credential_ciphertext:'encrypted-fixture',sync_state:{historyId:'cursor'}});
  expect((await db.query('SELECT * FROM hive_migrations')).rows).toHaveLength(18);
  expect((await one(db,"SELECT payload FROM events WHERE type='model.spending_caps_updated'")).payload).toEqual({enabled:false});
  expect(service.workspaces.root).toContain(result.archive);
  await expect(db.query('DELETE FROM events')).rejects.toThrow();
  await expect(db.query(`DELETE FROM ${result.archive}.events`)).rejects.toThrow();
  const second=await resetBusiness(service,(await resetPreview(service)).revision,'test-workspace-generations');
  expect(second.archive).not.toBe(result.archive);
  expect((await service.snapshot()).businessGeneration).toBe(second.archive);
  expect((await one(db,`SELECT id FROM ${result.archive}.tasks`)).id).toBe(task.id);
 }finally{await db.close();}
});

it('rejects running and stale reset requests without losing state',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));await service.createTask({objective:'Keep me'});
  const before=await resetPreview(service);await service.setStatus('RUNNING');
  await expect(resetBusiness(service,before.revision,'unused')).rejects.toThrow();
  await service.setStatus('PAUSED');await expect(resetBusiness(service,before.revision,'unused')).rejects.toThrow();
  expect((await db.query('SELECT * FROM tasks')).rows).toHaveLength(1);
 }finally{await db.close();}
});

it('rolls back schema archival if rebuilding preserved configuration fails',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));const task=await service.createTask({objective:'Must survive failed reset'});
  await db.exec("ALTER TABLE email_mailboxes ADD COLUMN unsupported_fixture TEXT; INSERT INTO email_mailboxes(address,provider,unsupported_fixture) VALUES('fixture','gmail','preserve')");
  await expect(resetBusiness(service,(await resetPreview(service)).revision,'unused')).rejects.toThrow();
  expect((await one(db,'SELECT id FROM tasks')).id).toBe(task.id);
  expect((await db.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'business_archive_%'")).rows).toHaveLength(0);
 }finally{await db.close();}
});

it('blocks active external dispatch and retains unresolved restrictions across repeated resets',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));
  const action=await service.createAction({actionType:'OTHER_EXTERNAL',target:'Original uncertain read',payload:{},rationale:'Fixture',maxCostUsd:'0',expiresAt:new Date(Date.now()+60000).toISOString()});
  await db.query("UPDATE actions SET status='EXECUTING' WHERE id=$1",[action.id]);
  expect((await resetPreview(service)).active).toBe(1);
  await expect(resetBusiness(service,(await resetPreview(service)).revision,'unused')).rejects.toThrow('active');
  expect((await db.query('SELECT * FROM actions')).rows).toHaveLength(1);
  await db.query("UPDATE actions SET status='UNCERTAIN' WHERE id=$1",[action.id]);
  await resetBusiness(service,(await resetPreview(service)).revision,'unused');
  expect((await one(db,'SELECT body FROM company_records')).body).toContain(action.id);
  await resetBusiness(service,(await resetPreview(service)).revision,'unused');
  expect((await one(db,'SELECT body FROM company_records')).body).toContain(action.id);
 }finally{await db.close();}
});

it('requires authenticated fresh preview, exact phrase and acknowledgement; confirmation is single use',async()=>{
 const db=await openDatabase();const service=new HiveService(db,createModels({}));let resets=0;
 const app=buildApp({service,ownerToken:'reset-fixture-owner-key',logger:false,resetBusiness:async revision=>{resets++;return {revision};}});
 try{
  expect((await app.inject({method:'POST',url:'/v1/company/reset/preview',payload:{}})).statusCode).toBe(401);
  const headers={authorization:'Bearer reset-fixture-owner-key'};
  const preview=await app.inject({method:'POST',url:'/v1/company/reset/preview',headers,payload:{}});
  const payload={token:preview.json().token,phrase:'RESET BUSYWORK',acknowledge:true};
  expect((await app.inject({method:'POST',url:'/v1/company/reset',headers,payload:{...payload,phrase:'reset'}})).statusCode).toBe(400);
  expect(resets).toBe(0);
  expect((await app.inject({method:'POST',url:'/v1/company/reset',headers,payload})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/v1/company/reset',headers,payload})).statusCode).toBe(409);
  expect(resets).toBe(1);
 }finally{await app.close();await db.close();}
});
