import {MockProvider} from '../packages/providers/src/index.js';
import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,writeDocument,createStaticRelease,one,ToolRegistry,ToolGateway,Organization,Worker} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';
const siteId='22222222-2222-4222-8222-222222222222';
it('freezes exact document versions and replays a release request without publication',async()=>{
 const db=await openDatabase();try{
 const create=()=>db.transaction(async tx=>{await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');return createStaticRelease(tx,input,'owner');});
 await db.transaction(tx=>writeDocument(tx,{path:'website/index.html',title:'Landing page',content:'<h1>First version</h1>',expectedVersion:0},'owner'));
 const input={requestId:randomUUID(),title:'Pilot website',siteId,files:[{path:'index.html',documentPath:'website/index.html',version:1}]};
 const first=await create();await db.transaction(tx=>writeDocument(tx,{path:'website/index.html',title:'Landing page',content:'<h1>Changed working copy</h1>',expectedVersion:1},'owner'));
 const replay=await create();expect(replay.content_hash).toBe(first.content_hash);expect(replay.manifest.files[0].content).toBe('<h1>First version</h1>');expect(replay.source_versions[0].version).toBe(1);
 await expect(db.transaction(tx=>createStaticRelease(tx,{...input,title:'Different'},'owner'))).rejects.toThrow('different content');
 await expect(db.query("UPDATE static_releases SET title='Changed' WHERE id=$1",[first.id])).rejects.toThrow('immutable');
 await expect(db.query('DELETE FROM static_releases WHERE id=$1',[first.id])).rejects.toThrow('immutable');
 expect((await db.query('SELECT id FROM static_releases')).rows).toHaveLength(1);expect((await db.query('SELECT id FROM actions')).rows).toHaveLength(0);expect((await db.query('SELECT id FROM ledger')).rows).toHaveLength(0);
 }finally{await db.close();}
});
it('rejects missing versions, traversal and inactive authors without persisting releases',async()=>{
 const db=await openDatabase();try{
 await db.transaction(tx=>writeDocument(tx,{path:'index.html',title:'Page',content:'hello',expectedVersion:0},'owner'));
 const input={requestId:randomUUID(),title:'Fixture',siteId,files:[{path:'index.html',documentPath:'index.html',version:1}]};
 await expect(db.transaction(tx=>createStaticRelease(tx,input,'missing-agent'))).rejects.toThrow('active employee');
 await expect(db.transaction(tx=>createStaticRelease(tx,{...input,files:[{...input.files[0],version:2}]},'owner'))).rejects.toThrow('not found');
 await expect(db.transaction(tx=>createStaticRelease(tx,{...input,files:[{...input.files[0],path:'../index.html'}]},'owner'))).rejects.toThrow();
 expect((await db.query('SELECT id FROM static_releases')).rows).toHaveLength(0);
 }finally{await db.close();}
});
it('requires owner authentication for release content and preparation',async()=>{
 const db=await openDatabase();const service=new HiveService(db,createModels({}));const app=buildApp({service,ownerToken:'fixture-token',logger:false});try{
 const input={requestId:randomUUID(),title:'Fixture',siteId,files:[{path:'index.html',documentPath:'index.html',version:1}]};
 await db.transaction(tx=>writeDocument(tx,{path:'index.html',title:'Page',content:'hello',expectedVersion:0},'owner'));
 for(const request of [{method:'GET',url:'/v1/releases'},{method:'GET',url:'/v1/releases/'+input.requestId},{method:'POST',url:'/v1/releases',payload:input}] as const)expect((await app.inject(request)).statusCode).toBe(401);
 const response=await app.inject({method:'POST',url:'/v1/releases',headers:{authorization:'Bearer fixture-token'},payload:input});expect(response.statusCode).toBe(200);
 const stored=await app.inject({url:'/v1/releases/'+input.requestId,headers:{authorization:'Bearer fixture-token'}});expect(stored.json().manifest.files[0].content).toBe('hello');
 }finally{await app.close();await db.close();}
});

it('binds publishing approval to frozen content and refuses silent automatic execution',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({}));
 await db.transaction(tx=>writeDocument(tx,{path:'index.html',title:'Page',content:'approved version',expectedVersion:0},'owner'));
 const release=await db.transaction(tx=>createStaticRelease(tx,{requestId:randomUUID(),title:'Release',siteId,files:[{path:'index.html',documentPath:'index.html',version:1}]},'owner'));
 const input={actionType:'PUBLISH',target:siteId,payload:{releaseId:release.id},rationale:'Publish exact landing page',maxCostUsd:'0',expiresAt:new Date(Date.now()+3600000).toISOString()};
 for(const changed of [{target:randomUUID()},{payload:{releaseId:release.id,releaseHash:'forged'}},{payload:{releaseId:release.id,executionMode:'AUTOMATIC'}},{actionType:'OTHER_EXTERNAL'},{payload:{releaseId:randomUUID()}}])await expect(service.createAction({...input,...changed})).rejects.toThrow();
 const proposal=await service.createAction(input);const action=await one(db,'SELECT * FROM actions WHERE id=$1',[proposal.id]);
 expect(action.payload).toMatchObject({releaseHash:release.content_hash,siteId,environment:'production',executionMode:'OWNER_ASSISTED',executorVersion:1});
 await expect(service.approveAction(action.id,'wrong-hash','APPROVE','test')).rejects.toThrow();
 await service.approveAction(action.id,action.action_hash,'APPROVE','Reviewed files and cost');
 await db.transaction(tx=>writeDocument(tx,{path:'index.html',title:'Page',content:'new working version',expectedVersion:1},'owner'));
 expect((await one(db,'SELECT * FROM static_releases WHERE id=$1',[release.id])).manifest.files[0].content).toBe('approved version');
 let dispatches=0;const registry=new ToolRegistry().register({name:'PUBLISH',version:1,description:'Future publisher fixture',approvalCategory:'publishing',maximumCostUsd:'0',execute:async()=>{dispatches++;return{result:{},actualCostUsd:'0'};}});
 await service.setStatus('RUNNING');await expect(new ToolGateway(service,registry).execute(action.id)).rejects.toThrow('owner-assisted');expect(dispatches).toBe(0);
 expect((await one(db,'SELECT status FROM actions WHERE id=$1',[action.id])).status).toBe('APPROVED');expect((await db.query('SELECT id FROM ledger')).rows).toHaveLength(0);
 }finally{await db.close();}
});
it('lets a reviewed agent propose an exact prepared release once',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({}));const org=new Organization(service);const person=await db.transaction(tx=>org.ensureCEO(tx));
 await db.transaction(tx=>writeDocument(tx,{path:'index.html',title:'Page',content:'fixture',expectedVersion:0},'owner'));
 const release=await db.transaction(tx=>createStaticRelease(tx,{requestId:randomUUID(),title:'Release',siteId,files:[{path:'index.html',documentPath:'index.html',version:1}]},'owner'));
 const provider=new MockProvider(),generate=provider.generate.bind(provider);provider.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK')(result.output as any).operations=[{type:'PROPOSE_EXTERNAL',externalActionType:'PUBLISH',releaseId:release.id,target:siteId,title:'Publish release',instructions:'Publish reviewed site files',budgetUsd:'2.00',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];return result;};
 service.models.find(m=>m.id==='mock-worker')!.adapter=provider;
 const task=await service.createTask({objective:'Propose frozen publication',employeeId:person.id,modelId:'mock-worker',tokenBudget:150000});await service.setStatus('RUNNING');const worker=new Worker(service);for(let i=0;i<3;i++)await worker.runNext();
 await org.applyOperations(task.id);await org.applyOperations(task.id);
 const actions=(await db.query('SELECT * FROM actions')).rows;expect(actions).toHaveLength(1);expect(actions[0].payload).toMatchObject({releaseId:release.id,releaseHash:release.content_hash,executionMode:'OWNER_ASSISTED'});expect(actions[0].status).toBe('PENDING');expect(actions[0].max_cost).toBe('2000000');
 }finally{await db.close();}
});
