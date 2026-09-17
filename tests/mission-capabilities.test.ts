import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,Worker,one} from '../packages/runtime/src/index.js';
import {createMission,activateMission} from '../packages/runtime/src/missions.js';
import {artifactSchema,jsonSchema} from '../packages/runtime/src/contracts.js';
import {missionArtifactSchema} from '../packages/runtime/src/mission-prompt.js';
import {allFamilies,enabledOperations,requiredFamilies} from '../packages/runtime/src/operation-families.js';
import {internalRead} from '../packages/runtime/src/internal-reads.js';
import {ToolGateway,ToolRegistry} from '../packages/runtime/src/tools.js';
it('maps every operation and removes disabled schema families while naming violations',()=>{
 expect(new Set(enabledOperations(allFamilies))).toEqual(new Set(artifactSchema.shape.operations.element.shape.type.options));
 const schema=missionArtifactSchema(['core','documents','research']),json:any=jsonSchema(schema);
 expect(JSON.stringify(json)).not.toContain('BUSINESS_EMAIL_SEND');expect(JSON.stringify(json)).not.toContain('priceHypothesis');expect(JSON.stringify(json)).not.toContain('releaseFiles');
 const result=schema.safeParse({operations:[{type:'BUSINESS_EMAIL_SEND'}]});expect(result.success).toBe(false);if(!result.success)expect(result.error.message).toContain('disabled mission capability: outreach');
 expect(requiredFamilies({type:'PROPOSE_EXTERNAL',externalActionType:'PUBLISH'})).toEqual(['deployment']);
});
it('blocks disabled operations, in-task reads and previously queued external execution',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service);
 await db.query("UPDATE company SET ceo_model_id='mock-worker'");await service.setStatus('RUNNING');await org.tick();
 const task=await one(db,'SELECT * FROM tasks'),worker=new Worker(service);for(let i=0;i<3;i++)await worker.runNext();
 const action=await service.createAction({taskId:task.id,actionType:'READ_PUBLIC_PAGE',target:'https://example.com',payload:{},rationale:'Synthetic read',maxCostUsd:'0',expiresAt:new Date(Date.now()+60000).toISOString()});
 const row=await one(db,'SELECT * FROM actions WHERE id=$1',[action.id]);await service.approveAction(action.id,row.action_hash,'APPROVE','Fixture');
 await db.query(`UPDATE missions SET capabilities='["core","documents"]' WHERE id=$1`,[task.mission_id]);
 await expect(db.transaction(tx=>internalRead(tx,service,task.employee_id,{type:'EMAIL_INBOX',target:'inbox'}))).rejects.toThrow('outreach');
 const gateway=new ToolGateway(service,new ToolRegistry().register({name:'READ_PUBLIC_PAGE',version:1,description:'Fixture',approvalCategory:'research',maximumCostUsd:'0',execute:async()=>{throw new Error('Must not dispatch');}}));
 await expect(gateway.execute(action.id)).rejects.toThrow('disabled mission capability: research');
 const done=await one(db,'SELECT artifact FROM tasks WHERE id=$1',[task.id]);done.artifact.operations=[{type:'CREATE_EXPERIMENT',target:'new',title:'Not enabled',instructions:'Not allowed',budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];
 await db.query("UPDATE tasks SET artifact=$2,operations_applied=false,status='COMPLETED' WHERE id=$1",[task.id,JSON.stringify(done.artifact)]);await org.applyOperations(task.id);
 expect((await db.query('SELECT id FROM experiments')).rows).toHaveLength(0);expect(JSON.stringify((await db.query('SELECT result FROM operations')).rows)).toContain('commerce');
 }finally{await db.close();}
});
it('filters noncommercial model context and guides in PLAN and WORK',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({}));const {id}=await createMission(service,{template:'research',title:'Research',objective:'Research a question',definitionOfDone:['Write report'],kind:'FINITE',budgetUsd:null,capabilities:['core','documents','research'],deliverable:'report.md'});await activateMission(service,id);
 const model=service.models.find(m=>m.id==='mock-worker')!,generate=model.adapter.generate.bind(model.adapter),requests:any[]=[];
 model.adapter.generate=async request=>{requests.push(request);const result=await generate(request);if((request.input as any).phase==='WORK')for(const key of Object.keys(result.output as any))if(!Object.hasOwn((request.outputSchema as any).properties,key))delete (result.output as any)[key];return result;};
 await service.createTask({objective:'Research an internal question.'});await service.setStatus('RUNNING');const worker=new Worker(service);await worker.runNext();await worker.runNext();
 expect(requests.map(r=>r.input.phase)).toEqual(['PLAN','WORK']);
 for(const request of requests){const disabled=artifactSchema.shape.operations.element.shape.type.options.filter(name=>!enabledOperations(['core','documents','research']).includes(name));expect(disabled.filter(name=>new RegExp('\\b'+name+'\\b').test(request.system))).toEqual([]);expect(request.input).not.toHaveProperty('businessEmail');expect(request.input).not.toHaveProperty('customerOrders');expect(request.system).toContain('SEARCH_WEB');}
 }finally{await db.close();}
});
