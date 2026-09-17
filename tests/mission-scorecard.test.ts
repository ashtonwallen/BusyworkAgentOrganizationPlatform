import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,one,writeDocument} from '../packages/runtime/src/index.js';
import {directionScorecard} from '../packages/runtime/src/service.js';
import {createMission,activateMission} from '../packages/runtime/src/missions.js';

it('reports scoped work, cost and condition evidence without commercial metrics for research',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));
  await service.recordMoney({kind:'REVENUE',amountUsd:'100',description:'Old business receipt',externalReference:'old',idempotencyKey:'old'});
  await db.query("UPDATE missions SET status='STOPPED' WHERE id='legacy-business'");
  const {id}=await createMission(service,{template:'research',title:'Research',objective:'Answer the question',definitionOfDone:['Deliver a sourced answer'],kind:'FINITE',budgetUsd:'5',capabilities:['core','documents','research'],deliverable:'report'});
  await activateMission(service,id);const org=new Organization(service);
  await org.ownerSetDirection({headline:'Compare sources',statement:'Evaluate the documented alternatives.'});
  await service.recordMoney({kind:'COST',amountUsd:'1',description:'Recorded fixture expense',externalReference:'new',idempotencyKey:'new'});
  await db.transaction(tx=>writeDocument(tx,{path:'report.md',title:'Report',content:'A partial, unverified answer.',expectedVersion:0},'owner'));
  const card=await directionScorecard(db,new Date(0),id);
  expect(card.spendUsd).toBe('1.000000');expect(card).not.toHaveProperty('revenueUsd');expect(card).not.toHaveProperty('refundsUsd');expect(card).not.toHaveProperty('opportunitiesOpened');
  expect(card.recordedProgress.documentVersions).toBe(1);expect(card.completionConditions[0]).toMatchObject({condition:'Deliver a sourced answer',evidence:[],ownerConfirmed:false});
  await db.query("UPDATE company SET ceo_model_id='mock-worker'");await service.setStatus('RUNNING');await org.tick();
  const task=await one(db,'SELECT objective FROM tasks');expect(task.objective).toContain('mission completion conditions');expect(task.objective).not.toContain('$100');expect(task.objective).not.toContain('opportunity(ies)');
  const business=await directionScorecard(db,new Date(0),'legacy-business');expect(business.revenueUsd).toBe('100.000000');expect(business.spendUsd).toBe('0.000000');
 }finally{await db.close();}
});
