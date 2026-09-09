import {it,expect} from 'vitest';
import {openDatabase,HiveService,Worker,Organization,createModels,one,ToolGateway,ToolRegistry} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';

it('connects reviewed CEO work, shared documents, approved research and actual receipts',async()=>{
 const db=await openDatabase();const models=createModels({});const service=new HiveService(db,models);const worker=new Worker(service);const org=new Organization(service);
 const base=new MockProvider();let stage='draft';let experimentId='';
 const op=(type:string,target:string,title:string,instructions:string,extra={})=>({type,target,title,instructions,budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null,...extra});
 models.find(m=>m.id==='mock-worker')!.adapter={providerId:'mock',listModels:()=>base.listModels(),async generate(request){
   const result=await base.generate(request);
   if((request.input as any).phase==='WORK')result.output={...result.output as object,operations:stage==='draft' ? [
     op('SET_DIRECTION','company','Offline data cleanup pilot','Validate a small fixed-scope offer; this is a test fixture.'),
     op('WRITE_DOCUMENT','experiments/pilot.md','Pilot working brief','Fixture hypothesis only. No outside action has occurred.',{expectedVersion:0}),
     op('CREATE_EXPERIMENT','company','Offline pilot','Open a draft, not a claimed sale.')
   ]:[op('READ_PUBLIC_PAGE','https://example.com','Qualify a source','Read the exact approved source.',{experimentId}),op('PROPOSE_EXTERNAL','fixture-vendor','Pilot supplies','A fixture purchase proposal.',{experimentId,externalActionType:'PURCHASE',budgetUsd:'1'})]};
   return result as any;
 }};
 try{
   await db.query("UPDATE company SET ceo_model_id='mock-worker',cycle_tokens=100000 WHERE id=1");await service.setStatus('RUNNING');await org.tick();
   const ceoTask=await one(db,"SELECT * FROM tasks WHERE role='CEO'");
   for(let i=0;i<3;i++)await worker.runNext();await org.applyOperations(ceoTask.id);await org.applyOperations(ceoTask.id);
   expect((await one(db,'SELECT status,review FROM tasks WHERE id=$1',[ceoTask.id]))).toMatchObject({status:'COMPLETED',review:{kind:'SELF',decision:'PASS'}});
   const experiment=await one(db,'SELECT * FROM experiments');experimentId=experiment.id;expect(experiment.status).toBe('DRAFT');
   expect((await db.query('SELECT id FROM documents')).rows).toHaveLength(1);expect((await db.query('SELECT id FROM directions')).rows).toHaveLength(1);
   stage='research';const task=await service.createTask({objective:'Request bounded pilot research and supplies.',role:'CEO',employeeId:ceoTask.employee_id,modelId:'mock-worker',tokenBudget:100000});
   for(let i=0;i<3;i++)await worker.runNext();await org.applyOperations(task.id);
   const actions=(await db.query<any>('SELECT * FROM actions ORDER BY action_type')).rows;expect(actions).toHaveLength(2);expect(actions.every(a=>a.status==='PENDING'&&a.experiment_id===experimentId)).toBe(true);
   let reads=0;const gateway=new ToolGateway(service,new ToolRegistry().register({name:'READ_PUBLIC_PAGE',version:1,description:'Offline source',approvalCategory:'research',maximumCostUsd:'0',async execute(){reads++;return {result:{text:'Fixture source, not proof of demand.',source:'https://example.com',trust:'UNTRUSTED_EXTERNAL_SOURCE'},actualCostUsd:'0'};}}));
   const research=actions.find(a=>a.action_type==='READ_PUBLIC_PAGE'),purchase=actions.find(a=>a.action_type==='PURCHASE');
   await gateway.tick();expect(reads).toBe(0);
   for(const a of actions)await service.approveAction(a.id,a.action_hash,'APPROVE','Offline authorization');
   await gateway.tick();await gateway.execute(research.id);expect(reads).toBe(1);
   expect((await one(db,'SELECT evidence FROM experiments WHERE id=$1',[experimentId])).evidence).toHaveLength(1);
   expect((await one(db,'SELECT status FROM actions WHERE id=$1',[purchase.id])).status).toBe('APPROVED');
   const receipt={actualCostUsd:'1',externalReference:'offline-receipt',resultNote:'Fixture completed purchase.'};
   await service.recordActionCompletion(purchase.id,receipt);await service.recordActionCompletion(purchase.id,receipt);
   const ledger=(await db.query<any>("SELECT * FROM ledger WHERE account='BUSINESS'",[])).rows;expect(ledger).toHaveLength(1);expect(ledger[0]).toMatchObject({experiment_id:experimentId,kind:'COST',amount:'1000000'});
   expect((await one(db,'SELECT status FROM experiments WHERE id=$1',[experimentId])).status).toBe('DRAFT');
 }finally{await worker.stop();await db.close();}
});
