import {PublicReadFailure} from '../packages/runtime/src/tools.js';
import {buildApp} from '../apps/api/src/app.js';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {openDatabase,HiveService,createModels,ToolGateway,ToolRegistry,isPublicAddress,one} from '../packages/runtime/src/index.js';
let db:Awaited<ReturnType<typeof openDatabase>>,service:HiveService,gateway:ToolGateway;
const execute=vi.fn(async()=>({result:{text:'Fixture evidence',trust:'UNTRUSTED_EXTERNAL_SOURCE'},actualCostUsd:'0'}));
beforeEach(async()=>{execute.mockClear();db=await openDatabase();service=new HiveService(db,createModels({}));gateway=new ToolGateway(service,new ToolRegistry().register({name:'READ_PUBLIC_PAGE',version:1,description:'Offline fixture',approvalCategory:'research',maximumCostUsd:'0',execute}));await service.setStatus('RUNNING');});
afterEach(async()=>{await db.close();});
const proposal=(extra={})=>service.createAction({actionType:'READ_PUBLIC_PAGE',target:'https://example.com',payload:{},rationale:'Verify a customer hypothesis',maxCostUsd:'0',expiresAt:new Date(Date.now()+60000).toISOString(),...extra});
it('does not let an unrelated proposal backlog hide approved executable work',async()=>{
  for(let i=0;i<31;i++)await proposal({actionType:'OTHER_EXTERNAL',target:`Unconfigured workflow ${i}`});
  const {id}=await proposal();await approve(id);await gateway.tick();expect(execute).toHaveBeenCalledTimes(1);expect((await one(db,'SELECT status FROM actions WHERE id=$1',[id])).status).toBe('EXECUTED');
});
async function approve(id:string){const a=await one(db,'SELECT * FROM actions WHERE id=$1',[id]);await service.approveAction(id,a.action_hash,'APPROVE','Fixture authorization');}
it('requires an exact owner approval, then executes once and returns the saved result while paused',async()=>{
  const {id}=await proposal();await expect(gateway.execute(id)).rejects.toThrow('approval');expect(execute).not.toHaveBeenCalled();
  await approve(id);await gateway.execute(id);await service.setStatus('PAUSED');expect(await gateway.execute(id)).toMatchObject({text:'Fixture evidence'});expect(execute).toHaveBeenCalledTimes(1);
  expect((await db.query('SELECT * FROM ledger WHERE action_id=$1',[id])).rows).toHaveLength(1);
});
it('turning off a category still requires a matching unrevoked scoped grant',async()=>{
  await service.setApprovalPolicy({research:false});const {id}=await proposal();await expect(gateway.execute(id)).rejects.toThrow('authority');
  await service.createGrant({actionType:'READ_PUBLIC_PAGE',target:'https://example.com',maxTransactionUsd:'0',totalCapUsd:'0',expiresAt:new Date(Date.now()+60000).toISOString(),rationale:'Allow this exact free research source'});
  await gateway.execute(id);expect(execute).toHaveBeenCalledTimes(1);
  const other=await proposal({target:'https://different.example'});await expect(gateway.execute(other.id)).rejects.toThrow('authority');
});
it('withdrawn approval and cancelled source tasks prevent dispatch',async()=>{
  const a=await proposal();await approve(a.id);await service.cancelAction(a.id);await expect(gateway.execute(a.id)).rejects.toThrow('executable');
  const task=await service.createTask({objective:'Inspect source'});const b=await proposal({taskId:task.id});await approve(b.id);await service.cancelTask(task.id);await expect(gateway.execute(b.id)).rejects.toThrow('cancelled');expect(execute).not.toHaveBeenCalled();
});
it('does not retry an uncertain external result, including after recovery',async()=>{
  execute.mockRejectedValueOnce(new Error('connection lost'));const {id}=await proposal();await approve(id);await expect(gateway.execute(id)).rejects.toThrow('uncertain');await gateway.recover();await gateway.tick();expect(execute).toHaveBeenCalledTimes(1);expect((await one(db,'SELECT status FROM actions WHERE id=$1',[id])).status).toBe('UNCERTAIN');
});
it('blocks private, reserved, malformed and unsupported network destinations',()=>{
  for(const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','198.18.0.1','203.0.113.1','224.0.0.1','::1','::ffff:127.0.0.1','invalid'])expect(isPublicAddress(address),address).toBe(false);
  expect(isPublicAddress('93.184.216.34')).toBe(true);
});

it('retains experiment research provenance once without claiming demand or reopening a closed test',async()=>{
 const experiment=await service.createExperiment({title:'Buyer qualification',hypothesis:'A buyer may need this service',customer:'A proposed buyer',offer:'A bounded report',channel:'Approved research',price:'99',maxLossUsd:'0',successCriteria:'Evidence of buying interest',killCriteria:'No relevant buyers',deadline:new Date(Date.now()+86400000).toISOString()});
 const {id}=await proposal({experimentId:experiment.id});await approve(id);
 await service.updateExperiment(experiment.id,'KILLED','Owner stopped the test after approving this read.');
 await gateway.execute(id);await gateway.execute(id);
 const row=await one(db,'SELECT status,evidence FROM experiments WHERE id=$1',[experiment.id]);
 expect(row.status).toBe('KILLED');
 const sources=row.evidence.filter((e:any)=>e.kind==='SOURCE_RECORD');expect(sources).toHaveLength(1);
 expect(sources[0]).toMatchObject({actionId:id,url:'https://example.com',note:'Fixture evidence',trust:'UNTRUSTED_EXTERNAL_SOURCE'});
 expect((await one(db,'SELECT experiment_id FROM ledger WHERE action_id=$1',[id])).experiment_id).toBe(experiment.id);
 expect((await service.snapshot()).metrics.revenueUsd).toBe('0.000000');
});

it('keeps historical source actions accessible only to the owner',async()=>{
 const {id}=await proposal();
 for(let i=0;i<105;i++)await proposal({target:`https://example.com/${i}`});
 const app=buildApp({service,ownerToken:'source-record-fixture-token',logger:false});
 try{
  expect((await app.inject({method:'GET',url:`/v1/actions/${id}`})).statusCode).toBe(401);
  const response=await app.inject({method:'GET',url:`/v1/actions/${id}`,headers:{authorization:'Bearer source-record-fixture-token'}});
  expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({id,target:'https://example.com'});
 }finally{await app.close();}
});

it('retains a classified HTTP failure without inventing content or retrying',async()=>{
 execute.mockRejectedValueOnce(new PublicReadFailure('HTTP_STATUS',403));const {id}=await proposal();await approve(id);await expect(gateway.execute(id)).rejects.toThrow('uncertain');
 const row=await one(db,'SELECT * FROM actions WHERE id=$1',[id]);expect(row.result).toMatchObject({resultAvailable:false,diagnostic:{code:'HTTP_STATUS',httpStatus:403}});
 expect((await one(db,"SELECT payload FROM events WHERE entity_id=$1 AND type='tool.uncertain'",[id])).payload.diagnostic.httpStatus).toBe(403);
 await gateway.tick();expect(execute).toHaveBeenCalledTimes(1);expect((await db.query('SELECT id FROM ledger WHERE action_id=$1',[id])).rows).toHaveLength(0);
});
