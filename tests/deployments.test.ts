import {it,expect} from 'vitest';
import {StaticPublisher} from '../packages/runtime/src/publisher.js';
import {NetlifyDeploymentClient} from '../packages/runtime/src/netlify.js';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase,HiveService,createModels,writeDocument,createStaticRelease,one,actionHash,claimDeploymentCreation,recordDeploymentReceipt,recoverDeploymentCreations,reconcileDeploymentCost,hostingSetup,admitPublishing,ToolGateway,ToolRegistry} from '../packages/runtime/src/index.js';
const siteId='22222222-2222-4222-8222-222222222222';
async function fixture(db:Awaited<ReturnType<typeof openDatabase>>,mode='NETLIFY_AUTOMATIC'){
 const service=new HiveService(db,createModels({}));
 const release=await db.transaction(async tx=>{await writeDocument(tx,{path:'index.html',title:'Page',content:'Frozen content',expectedVersion:0},'owner');return createStaticRelease(tx,{requestId:randomUUID(),title:'Release',siteId,files:[{path:'index.html',documentPath:'index.html',version:1}]},'owner');});
 const id=randomUUID(),payload={releaseId:release.id,releaseHash:release.content_hash,siteId,provider:'netlify',environment:'production',executorVersion:1,executionMode:mode};
 // Simulate future configured publisher admission. No public API creates this mode yet.
 const hash=actionHash({id,payload,target:siteId,maxCost:'2000000'});
 await db.query("INSERT INTO actions(id,action_type,target,payload,rationale,max_cost,expires_at,action_hash,status) VALUES($1,'PUBLISH',$2,$3,'Fixture',2000000,$4,$5,'PENDING')",[id,siteId,JSON.stringify(payload),new Date(Date.now()+3600000),hash]);
 await service.approveAction(id,hash,'APPROVE','Fixture authorization');await service.setStatus('RUNNING');
 await db.query("UPDATE actions SET status='EXECUTING',reservation=max_cost WHERE id=$1",[id]);
 return {id,release,service};
}
const receipt=(state='prepared',id='deploy-1')=>({id,siteId,state,required:[],url:'https://fixture.netlify.app'});
it('claims creation once under concurrent callers and never treats ready as paid settlement',async()=>{
 const db=await openDatabase();try{
 const {id}=await fixture(db);
 const claims=await Promise.all([db.transaction(tx=>claimDeploymentCreation(tx,id)),db.transaction(tx=>claimDeploymentCreation(tx,id))]);expect(claims.filter(c=>c.claimed)).toHaveLength(1);
 await db.transaction(tx=>recordDeploymentReceipt(tx,id,receipt()));await db.transaction(tx=>recordDeploymentReceipt(tx,id,receipt('ready')));
 expect((await one(db,'SELECT * FROM deployments')).status).toBe('READY');
 const action=await one(db,'SELECT * FROM actions WHERE id=$1',[id]);expect(action.reservation).toBe('2000000');expect(action.settled).toBeNull();expect(action.status).toBe('AWAITING_COST');expect((await db.query('SELECT * FROM ledger')).rows).toHaveLength(0);
 await expect(db.transaction(tx=>recordDeploymentReceipt(tx,id,receipt()))).rejects.toThrow('terminal');
 await expect(db.query("UPDATE deployments SET provider_id='different'")).rejects.toThrow('immutable');await expect(db.query('DELETE FROM deployments')).rejects.toThrow('cannot be deleted');
 }finally{await db.close();}
});
it('rejects stale authority, missing reserves, owner-assisted mode and unrelated receipts',async()=>{
 const db=await openDatabase();try{
 const {id,service}=await fixture(db);
 await service.setStatus('PAUSED');await expect(db.transaction(tx=>claimDeploymentCreation(tx,id))).rejects.toThrow('running');await service.setStatus('RUNNING');
 await db.query('UPDATE actions SET reservation=0 WHERE id=$1',[id]);await expect(db.transaction(tx=>claimDeploymentCreation(tx,id))).rejects.toThrow('reservation');await db.query('UPDATE actions SET reservation=max_cost WHERE id=$1',[id]);
 await expect(db.transaction(tx=>claimDeploymentCreation(tx,id,new Date(Date.now()+7200000)))).rejects.toThrow('unexpired');
 await db.transaction(tx=>claimDeploymentCreation(tx,id));
 await expect(db.transaction(tx=>recordDeploymentReceipt(tx,id,{...receipt(),siteId:randomUUID()}))).rejects.toThrow('identity');
 await expect(db.transaction(tx=>recordDeploymentReceipt(tx,id,{...receipt(),required:['a'.repeat(40)]}))).rejects.toThrow('outside');
 await db.transaction(tx=>recordDeploymentReceipt(tx,id,receipt()));await expect(db.transaction(tx=>recordDeploymentReceipt(tx,id,receipt('ready','wrong-id')))).rejects.toThrow('identity');
 }finally{await db.close();}
 const other=await openDatabase();try{const {id}=await fixture(other,'OWNER_ASSISTED');await expect(other.transaction(tx=>claimDeploymentCreation(tx,id))).rejects.toThrow('explicitly automatic');expect((await other.query('SELECT * FROM deployments')).rows).toHaveLength(0);}finally{await other.close();}
});
it('preserves uncertain creation across reopen and accepts a late original receipt without re-creation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'busywork-deployment-'));let db:Awaited<ReturnType<typeof openDatabase>>|undefined;
 try{
 db=await openDatabase(join(directory,'db'));const {id}=await fixture(db);await db.transaction(tx=>claimDeploymentCreation(tx,id));await db.close();db=undefined;
 db=await openDatabase(join(directory,'db'));expect(await db.transaction(tx=>recoverDeploymentCreations(tx))).toBe(1);
 expect((await db.transaction(tx=>claimDeploymentCreation(tx,id))).claimed).toBe(false);
 expect((await one(db,'SELECT * FROM deployments')).status).toBe('UNCERTAIN');
 await db.transaction(tx=>recordDeploymentReceipt(tx,id,receipt()));await db.close();db=undefined;
 db=await openDatabase(join(directory,'db'));expect(await db.transaction(tx=>recoverDeploymentCreations(tx))).toBe(0);expect((await one(db,'SELECT * FROM deployments')).provider_id).toBe('deploy-1');expect((await db.transaction(tx=>claimDeploymentCreation(tx,id))).claimed).toBe(false);
 }finally{await db?.close();await rm(directory,{recursive:true,force:true});}
});

it('coordinates one creation, resumes known-ID upload and preserves unknown costs',async()=>{
 const db=await openDatabase();try{
 const {id,service,release}=await fixture(db);const calls:string[]=[];let uploaded=false;
 const client=new NetlifyDeploymentClient('fixture-secret',async(url,options)=>{
 const method=options?.method??'GET';calls.push(method);
 if(method==='PUT'){
  expect((await one(db,'SELECT provider_id FROM deployments')).provider_id).toBe('deploy-1');uploaded=true;return new Response('{}');
 }
 return new Response(JSON.stringify({id:'deploy-1',site_id:siteId,state:uploaded?'ready':'prepared',required:uploaded?[]:[release.manifest.files[0].sha1]}));
 });
 const publisher=new StaticPublisher(service,siteId,client);await Promise.all([publisher.advance(id),publisher.advance(id)]);expect(calls).toEqual(['POST']);
 // A new coordinator instance represents restart, with the same durable ID.
 const resumed=new StaticPublisher(service,siteId,client);await resumed.recover();await resumed.advance(id);await resumed.advance(id);await resumed.advance(id);
 expect(calls).toEqual(['POST','GET','PUT','GET']);expect((await one(db,'SELECT status FROM deployments')).status).toBe('READY');
 expect((await one(db,'SELECT reservation,settled FROM actions WHERE id=$1',[id]))).toMatchObject({reservation:'2000000',settled:null});expect((await db.query('SELECT * FROM ledger')).rows).toHaveLength(0);
 }finally{await db.close();}
});
it('retains uncertain creation without another POST and redacts transport errors',async()=>{
 const db=await openDatabase();try{
 const {id,service}=await fixture(db);let calls=0;const client=new NetlifyDeploymentClient('fixture-secret',async()=>{calls++;throw new Error('fixture-secret raw provider body');});
 const publisher=new StaticPublisher(service,siteId,client);await publisher.advance(id);await publisher.recover();await publisher.advance(id);await new StaticPublisher(service,siteId,client).advance(id);
 expect(calls).toBe(1);const row=await one(db,'SELECT * FROM deployments');expect(row.status).toBe('UNCERTAIN');expect(row.error).not.toContain('fixture-secret');
 }finally{await db.close();}
});
it('records late creation receipts during pause and prevents later uploads until resumed',async()=>{
 const db=await openDatabase();try{
 const {id,service,release}=await fixture(db);const calls:string[]=[];
 const client=new NetlifyDeploymentClient('fixture',async(_url,options)=>{
 calls.push(options!.method!);if(options?.method==='POST')await service.setStatus('PAUSED');
 return new Response(JSON.stringify({id:'deploy-1',site_id:siteId,state:'prepared',required:[release.manifest.files[0].sha1]}));
 });
 const publisher=new StaticPublisher(service,siteId,client);await publisher.advance(id);expect((await one(db,'SELECT provider_id FROM deployments')).provider_id).toBe('deploy-1');
 await expect(publisher.advance(id)).rejects.toThrow('paused');expect(calls).toEqual(['POST']);await service.setStatus('RUNNING');await publisher.advance(id);expect(calls).toEqual(['POST','GET','PUT']);
 }finally{await db.close();}
});

it('settles a confirmed final charge once and exposes outstanding action reservations',async()=>{
 const db=await openDatabase();try{
 const {id,service}=await fixture(db);await db.transaction(tx=>claimDeploymentCreation(tx,id));
 expect((await service.snapshot()).metrics.reservedUsd).toBe('2.000000');
 const input={actualCostUsd:'1.234567',externalReference:'provider-invoice-1',resultNote:'Final deployment charge'};
 await expect(db.transaction(tx=>reconcileDeploymentCost(tx,id,input))).rejects.toThrow('outcome');
 await db.transaction(tx=>recordDeploymentReceipt(tx,id,receipt('ready')));
 await Promise.all([db.transaction(tx=>reconcileDeploymentCost(tx,id,input)),db.transaction(tx=>reconcileDeploymentCost(tx,id,input))]);
 const action=await one(db,'SELECT * FROM actions WHERE id=$1',[id]);expect(action.status).toBe('EXECUTED');expect(action.result.published).toBe(true);expect(action.settled).toBe('1234567');expect(action.reservation).toBe('0');
 expect((await db.query('SELECT * FROM ledger WHERE action_id=$1',[id])).rows).toHaveLength(1);expect((await service.snapshot()).metrics.reservedUsd).toBe('0.000000');
 for(const change of [{actualCostUsd:'2'},{externalReference:'other'},{resultNote:'different'}])await expect(db.transaction(tx=>reconcileDeploymentCost(tx,id,{...input,...change}))).rejects.toThrow('different');
 }finally{await db.close();}
});
it('records failed deployment charges without claiming publication or lifting a kill switch',async()=>{
 const db=await openDatabase();try{
 const {id,service}=await fixture(db);await db.transaction(tx=>claimDeploymentCreation(tx,id));await db.transaction(tx=>recordDeploymentReceipt(tx,id,receipt('error')));await service.setStatus('KILLED');
 await db.transaction(tx=>reconcileDeploymentCost(tx,id,{actualCostUsd:'3',externalReference:'failed-deploy-invoice',resultNote:'Billed despite provider error'}));
 const action=await one(db,'SELECT * FROM actions WHERE id=$1',[id]);expect(action.status).toBe('FAILED');expect(action.result.published).toBe(false);expect(action.result.costExceeded).toBe(true);expect((await one(db,'SELECT status FROM company')).status).toBe('KILLED');
 }finally{await db.close();}
});
it('protects deployment receipts with owner authentication and pauses on real overruns',async()=>{
 const db=await openDatabase();const {buildApp}=await import('../apps/api/src/app.js');let app:ReturnType<typeof buildApp>|undefined;try{
 const {id,service}=await fixture(db);await db.transaction(tx=>claimDeploymentCreation(tx,id));await db.transaction(tx=>recordDeploymentReceipt(tx,id,receipt('ready')));
 app=buildApp({service,ownerToken:'deployment-fixture',logger:false});const payload={actualCostUsd:'2.01',externalReference:'invoice-overrun',resultNote:'Actual final bill'};
 for(const url of ['/v1/deployments','/v1/deployments/'+id])expect((await app.inject({url})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/v1/deployments/'+id+'/reconcile-cost',payload})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/v1/deployments/'+id+'/reconcile-cost',payload,headers:{authorization:'Bearer deployment-fixture'}})).statusCode).toBe(200);
 expect((await one(db,'SELECT status FROM company')).status).toBe('PAUSED');
 }finally{await app?.close();await db.close();}
});

it('requires complete explicit hosting setup and never exposes its token',()=>{
 const env={HIVE_NETLIFY_ENABLED:'true',HIVE_NETLIFY_TOKEN:'private-fixture-token',HIVE_NETLIFY_SITE_ID:siteId,HIVE_NETLIFY_MAX_DEPLOY_USD:'2',HIVE_NETLIFY_TOTAL_CAP_USD:'4'};
 const config=hostingSetup(env);expect(config.ready).toBe(true);expect(JSON.stringify(config)).not.toContain('private-fixture-token');
 expect(hostingSetup({...env,HIVE_NETLIFY_ENABLED:'false'}).ready).toBe(false);expect(hostingSetup({...env,HIVE_NETLIFY_TOTAL_CAP_USD:'1'}).ready).toBe(false);
 for(const key of ['HIVE_NETLIFY_TOKEN','HIVE_NETLIFY_SITE_ID','HIVE_NETLIFY_MAX_DEPLOY_USD','HIVE_NETLIFY_TOTAL_CAP_USD'])expect(hostingSetup({...env,[key]:''}).missing).toContain(key);
});
it('admits an exact automatic proposal once and retains uncertain holds against lifetime capacity',async()=>{
 const db=await openDatabase();try{
 const {id,service,release}=await fixture(db);await db.query("UPDATE actions SET status='APPROVED',reservation=0 WHERE id=$1",[id]);await db.query('UPDATE company SET max_concurrency=5');
 const config=hostingSetup({HIVE_NETLIFY_ENABLED:'true',HIVE_NETLIFY_TOKEN:'fixture',HIVE_NETLIFY_SITE_ID:siteId,HIVE_NETLIFY_MAX_DEPLOY_USD:'2',HIVE_NETLIFY_TOTAL_CAP_USD:'2'});service.hosting=config;
 const input={actionType:'PUBLISH',target:siteId,payload:{releaseId:release.id,executionMode:'NETLIFY_AUTOMATIC'},rationale:'Publish exact content automatically',maxCostUsd:'2',expiresAt:new Date(Date.now()+3600000).toISOString()};
 await expect(service.createAction({...input,maxCostUsd:'1'})).rejects.toThrow('maximum');const second=await service.createAction(input);const action=await one(db,'SELECT * FROM actions WHERE id=$1',[second.id]);expect(action.payload.executionMode).toBe('NETLIFY_AUTOMATIC');await service.approveAction(second.id,action.action_hash,'APPROVE','Fixture');
 const attempts=await Promise.allSettled([db.transaction(tx=>admitPublishing(tx,id,config)),db.transaction(tx=>admitPublishing(tx,second.id,config))]);expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
 const active=await one(db,"SELECT * FROM actions WHERE status='EXECUTING'");await db.query("UPDATE actions SET status='UNCERTAIN' WHERE id=$1",[active.id]);const pending=await one(db,"SELECT * FROM actions WHERE status='APPROVED'");
 await expect(db.transaction(tx=>admitPublishing(tx,pending.id,config))).rejects.toThrow('lifetime cap');expect((await one(db,'SELECT reservation FROM actions WHERE id=$1',[pending.id])).reservation).toBe('0');
 await expect(db.transaction(tx=>admitPublishing(tx,pending.id,{...config,maxDeploymentUsd:'1'}))).rejects.toThrow('bound changed');await expect(db.transaction(tx=>admitPublishing(tx,pending.id,{...config,ready:false}))).rejects.toThrow('disabled');
 }finally{await db.close();}
});

it('frees terminal execution slots but retains money and sends one result message',async()=>{
 const db=await openDatabase();try{
 const {id,service,release}=await fixture(db);await db.query('UPDATE company SET max_concurrency=1');await db.transaction(tx=>claimDeploymentCreation(tx,id));
 await db.transaction(tx=>recordDeploymentReceipt(tx,id,receipt('ready')));await db.transaction(tx=>recordDeploymentReceipt(tx,id,receipt('ready')));
 expect((await db.query("SELECT * FROM messages WHERE sender_id='publishing'")).rows).toHaveLength(1);
 const message=await one(db,"SELECT body FROM messages WHERE sender_id='publishing'");expect(message.body).toContain('not evidence of buyer demand');
 expect((await one(db,'SELECT status,reservation FROM actions WHERE id=$1',[id]))).toMatchObject({status:'AWAITING_COST',reservation:'2000000'});
 service.hosting=hostingSetup({HIVE_NETLIFY_ENABLED:'true',HIVE_NETLIFY_TOKEN:'fixture',HIVE_NETLIFY_SITE_ID:siteId,HIVE_NETLIFY_MAX_DEPLOY_USD:'2',HIVE_NETLIFY_TOTAL_CAP_USD:'4'});
 const next=await service.createAction({actionType:'PUBLISH',target:siteId,payload:{releaseId:release.id,executionMode:'NETLIFY_AUTOMATIC'},rationale:'Next fixture deployment',maxCostUsd:'2',expiresAt:new Date(Date.now()+3600000).toISOString()});const action=await one(db,'SELECT * FROM actions WHERE id=$1',[next.id]);await service.approveAction(next.id,action.action_hash,'APPROVE','Fixture');
 await db.transaction(tx=>admitPublishing(tx,next.id,service.hosting));expect((await service.snapshot()).metrics.reservedUsd).toBe('4.000000');
 }finally{await db.close();}
});
it('generic recovery preserves known deployment identity and quarantines lost creations',async()=>{
 const db=await openDatabase();try{
 const {id,service}=await fixture(db);await db.transaction(tx=>claimDeploymentCreation(tx,id));await db.transaction(tx=>recordDeploymentReceipt(tx,id,receipt()));
 await new ToolGateway(service,new ToolRegistry()).recover();expect((await one(db,'SELECT status FROM actions WHERE id=$1',[id])).status).toBe('EXECUTING');expect((await one(db,'SELECT provider_id FROM deployments')).provider_id).toBe('deploy-1');
 }finally{await db.close();}
 const other=await openDatabase();try{
 const {id,service}=await fixture(other);await other.transaction(tx=>claimDeploymentCreation(tx,id));await new ToolGateway(service,new ToolRegistry()).recover();expect((await one(other,'SELECT status,reservation FROM actions WHERE id=$1',[id]))).toMatchObject({status:'UNCERTAIN',reservation:'2000000'});
 }finally{await other.close();}
});

it('runs configured approved releases through scheduler, exact transport and reconciliation',async()=>{
 const db=await openDatabase();try{
 const {id,service}=await fixture(db);await db.query("UPDATE actions SET status='APPROVED',reservation=0 WHERE id=$1",[id]);
 service.hosting=hostingSetup({HIVE_NETLIFY_ENABLED:'true',HIVE_NETLIFY_TOKEN:'fixture',HIVE_NETLIFY_SITE_ID:siteId,HIVE_NETLIFY_MAX_DEPLOY_USD:'2',HIVE_NETLIFY_TOTAL_CAP_USD:'4'});
 let calls=0;const client=new NetlifyDeploymentClient('fixture',async()=>{calls++;return new Response(JSON.stringify({id:'deploy-1',site_id:siteId,state:'ready',required:[]}));});
 const publisher=new StaticPublisher(service,siteId,client);await service.setStatus('PAUSED');await publisher.tick();expect(calls).toBe(0);await service.setStatus('RUNNING');
 await expect(service.recordActionCompletion(id,{actualCostUsd:'0',externalReference:'manual',resultNote:'Cannot substitute manual completion'})).rejects.toThrow('deployment cost reconciliation');
 await publisher.tick();await publisher.tick();expect(calls).toBe(1);const action=await one(db,'SELECT * FROM actions WHERE id=$1',[id]);expect(action.status).toBe('AWAITING_COST');expect(action.reservation).toBe('2000000');expect(action.result.published).toBe(true);
 await db.transaction(tx=>reconcileDeploymentCost(tx,id,{actualCostUsd:'1',externalReference:'final-provider-bill',resultNote:'Observed charge'}));expect((await one(db,'SELECT status FROM actions WHERE id=$1',[id])).status).toBe('EXECUTED');expect((await db.query('SELECT * FROM ledger')).rows).toHaveLength(1);
 }finally{await db.close();}
});
