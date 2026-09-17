import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
const {PGlite}=createRequire(new URL('../packages/runtime/package.json',import.meta.url))('@electric-sql/pglite');
import * as schema from '../packages/runtime/src/schema.js';
import {migration17} from '../packages/runtime/src/mission-schema.js';
import {openDatabase,HiveService,createModels,Organization,one} from '../packages/runtime/src/index.js';
import {createMission,activateMission,currentMission,missionTemplates} from '../packages/runtime/src/missions.js';

const research={template:'research',title:'Research',objective:'Compare documented methods.',definitionOfDone:['Deliver a cited comparison.'],boundaries:'Internal work only.',kind:'FINITE',budgetUsd:'10',capabilities:['core','documents','research'],deliverable:'A report'};
it('backfills historical audit rows without changing their content or disabling immutability',async()=>{
 const db=await PGlite.create();
 try{
  for(let version=1;version<=16;version++){
   await db.exec((schema as Record<string,string>)['migration'+version]);
   if(version===1)await db.query('INSERT INTO company(id,daily_cap) VALUES(1,10000000)');
  }
  await db.query("UPDATE company SET mandate='Preserve the existing owner objective.'");
  await db.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,description) VALUES('legacy','legacy','BUSINESS','COST',12345,'Prior expense')");
  await db.query("INSERT INTO events(type,entity_id,actor,payload) VALUES('order.updated','old-order','owner','{}')");
  const before=(await db.query('SELECT * FROM ledger')).rows[0];
  await db.transaction(tx=>tx.exec(migration17));
  const {mission_id,...after}=await one(db,'SELECT * FROM ledger');
  expect(after).toEqual(before);expect(mission_id).toBe('legacy-business');
  expect((await currentMission(db))?.objective).toBe('Preserve the existing owner objective.');
  expect((await one(db,'SELECT * FROM events')).mission_id).toBe('legacy-business');
  await expect(db.query("UPDATE ledger SET amount=0")).rejects.toThrow('append-only');
  await expect(db.query('DELETE FROM events')).rejects.toThrow('append-only');
 }finally{await db.close();}
});
it('activates a finite mission with template departments while preserving paused defaults',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));const first=await createMission(service,research);
  await activateMission(service,first.id);
  expect((await currentMission(db))?.kind).toBe('FINITE');
  expect((await one(db,'SELECT status FROM company')).status).toBe('PAUSED');
  const second=await createMission(service,research);
  await expect(activateMission(service,second.id)).rejects.toThrow('Finish or stop');
  await expect(createMission(service,{...research,definitionOfDone:[]})).rejects.toThrow();
  expect(missionTemplates).toHaveLength(6);
 }finally{await db.close();}
});
it('inherits mission attribution from work and isolates current directions across missions',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({})),org=new Organization(service);
  const task=await service.createTask({objective:'Legacy internal task',modelId:'mock-worker'});
  const oldDirection=await org.ownerSetDirection({headline:'Legacy strategy',statement:'Keep prior evidence.'});
  await db.query("UPDATE missions SET status='STOPPED' WHERE id='legacy-business'");
  const next=await createMission(service,research);await activateMission(service,next.id);
  await org.ownerSetDirection({headline:'Research strategy',statement:'Compare sources.'});
  const message=await db.query<any>("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES('m','owner','company','MESSAGE','Old work','Preserve context',$1) RETURNING mission_id",[task.id]);
  expect(message.rows[0].mission_id).toBe('legacy-business');
  expect((await one(db,'SELECT superseded_at FROM directions WHERE id=$1',[oldDirection])).superseded_at).toBeNull();
  expect((await service.snapshot()).direction?.headline).toBe('Research strategy');
  await expect(db.query("UPDATE tasks SET mission_id=$2 WHERE id=$1",[task.id,next.id])).rejects.toThrow('immutable');
 }finally{await db.close();}
});
