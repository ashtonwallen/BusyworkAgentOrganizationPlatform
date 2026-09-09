import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,resetBusiness,resetPreview,Organization,Worker} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
import {buildApp} from '../apps/api/src/app.js';

it('creates independent models on an existing connection and preserves configuration across restart and reset',async()=>{
 const db=await openDatabase();const env={OPENAI_API_KEY:'fixture-not-a-real-key'};const service=new HiveService(db,createModels(env));
 const app=buildApp({service,ownerToken:'profile-fixture-owner',logger:false});try{
  const input={connectionId:'openai',name:'Writing model',model:'fixture-writing',inputPerMillionUsd:'1',outputPerMillionUsd:'2'};
  expect((await app.inject({method:'POST',url:'/v1/models',payload:input})).statusCode).toBe(401);
  const response=await app.inject({method:'POST',url:'/v1/models',payload:input,headers:{authorization:'Bearer profile-fixture-owner'}});expect(response.statusCode).toBe(200);const first=response.json();expect(first.ready).toBe(true);
  const second=await service.createModelProfile({...input,name:'Planning model',model:'fixture-planning',inputPerMillionUsd:'3'});
  expect(first.id).not.toBe(second.id);expect(service.model(first.id).adapter).toBe(service.models.find(m=>m.id==='openai')!.adapter);expect(service.model(first.id).spendingCapsEnabled).toBe(true);
  await service.configureModel(first.id,{model:'fixture-updated',inputPerMillionUsd:'4',outputPerMillionUsd:'5'});
  expect(service.model(second.id).model).toBe('fixture-planning');expect(service.models.find(m=>m.id==='openai')!.model).toBe('');
  const restart=new HiveService(db,createModels(env));await restart.loadModelSettings();expect(restart.model(first.id).model).toBe('fixture-updated');expect(restart.model(second.id).inputPerMillionUsd).toBe('3');
  await restart.loadModelSettings();expect(restart.models.filter(m=>m.connectionId)).toHaveLength(2);
  await resetBusiness(restart,(await resetPreview(restart)).revision,'test-profile-generations');
  const fresh=new HiveService(db,createModels(env));await fresh.loadModelSettings();expect(fresh.model(first.id).name).toBe('Writing model');expect(fresh.model(second.id).model).toBe('fixture-planning');
  expect((await db.query('SELECT * FROM calls')).rows).toHaveLength(0);
  await expect(fresh.createModelProfile({...input,connectionId:first.id})).rejects.toThrow('connection');
  await expect(fresh.createModelProfile({...input,apiKey:'forbidden'})).rejects.toThrow();
  const pending=await fresh.createModelProfile({connectionId:'openai',name:'Unpriced model',model:'fixture-unpriced'});expect(pending.ready).toBe(false);
 }finally{await app.close();await db.close();}
});

it('lets a reviewed employee operation register a local model once without inference or paid authority changes',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
  const local=new MockProvider();service.models.find(m=>m.id==='local-qwen')!.adapter=local;
  const provider=new MockProvider(),generate=provider.generate.bind(provider);
  provider.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK')(result.output as any).operations=[{type:'REGISTER_MODEL',target:'local-qwen',title:'Configure specialist model',instructions:'Register a loaded local model.',modelProfile:{name:'Local specialist',model:'mock-worker'},budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];return result;};
  service.models.find(m=>m.id==='mock-worker')!.adapter=provider;
  const task=await service.createTask({objective:'Configure a model for future delegation',employeeId:ceo.id,modelId:'mock-worker',tokenBudget:150000});await service.setStatus('RUNNING');const worker=new Worker(service);for(let i=0;i<3;i++)await worker.runNext();await org.applyOperations(task.id);await org.applyOperations(task.id);
  const profiles=service.models.filter(m=>m.connectionId);expect(profiles).toHaveLength(1);expect(profiles[0]).toMatchObject({name:'Local specialist',ready:true,inputPerMillionUsd:'0',outputPerMillionUsd:'0',spendingCapsEnabled:true});
  expect((await db.query("SELECT actor FROM events WHERE type='model.profile_created'")).rows).toEqual([{actor:ceo.id}]);
  expect((await db.query("SELECT id FROM calls WHERE model_id=$1",[profiles[0]!.id])).rows).toHaveLength(0);
  const profile=profiles[0]!,settings={model:'mock-worker',maxInputTokens:20000,maxOutputTokens:5000};
  provider.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK')(result.output as any).operations=[{type:'CONFIGURE_MODEL',target:profile.id,title:'Increase output allowance',instructions:'Allow longer local deliverables.',modelSettings:settings,budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];return result;};
  const edit=await service.createTask({objective:'Adjust local output capacity',employeeId:ceo.id,modelId:'mock-worker',tokenBudget:150000});for(let i=0;i<3;i++)await worker.runNext();await org.applyOperations(edit.id);await org.applyOperations(edit.id);
  expect(service.model(profile.id)).toMatchObject({maxInputTokens:20000,maxOutputTokens:5000,spendingCapsEnabled:true});
  expect((await db.query("SELECT id FROM operations WHERE task_id=$1 AND status='APPLIED'",[edit.id])).rows).toHaveLength(1);
  await expect(db.transaction(tx=>service.configureAgentModel(tx,profile.id,settings,'inactive'))).rejects.toThrow('active employee');
  await db.query('UPDATE company SET ceo_model_id=$1',[profile.id]);
  await expect(db.transaction(tx=>service.configureAgentModel(tx,profile.id,settings,ceo.id))).rejects.toThrow('CEO');
  await db.query("UPDATE company SET ceo_model_id='mock-worker'");
  await db.query("INSERT INTO employees(id,name,role,department_id,depth,charter,model_id) VALUES('outside','Outside employee','Specialist','executive',0,'Independent work',$1)",[profile.id]);
  await expect(db.transaction(tx=>service.configureAgentModel(tx,profile.id,settings,ceo.id))).rejects.toThrow('reporting chain');
  await db.query('UPDATE employees SET manager_id=$1 WHERE id=\'outside\'',[ceo.id]);
  await db.query("INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,token_reserved,budget_day) VALUES('uncertain-profile',$1,'PLAN',99,$2,'lmstudio',false,'UNCERTAIN',0,100,CURRENT_DATE)",[edit.id,profile.id]);
  await expect(db.transaction(tx=>service.configureAgentModel(tx,profile.id,settings,ceo.id))).rejects.toThrow('uncertain');
 }finally{await db.close();}
});
