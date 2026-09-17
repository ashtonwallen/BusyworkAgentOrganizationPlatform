import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,one} from '../packages/runtime/src/index.js';
import {BraveSearchProvider,configuredSearch,searchTool} from '../packages/runtime/src/web-search.js';
import {ToolGateway,ToolRegistry} from '../packages/runtime/src/tools.js';

it('keeps unconfigured search unavailable and credentials only in the HTTP transport',async()=>{
 expect(configuredSearch({}).setup.available).toBe(false);
 const key='fixture-key-not-a-credential';let requested=false;
 const provider=new BraveSearchProvider(key,async(url,init)=>{
  requested=true;expect(new URL(String(url)).hostname).toBe('api.search.brave.com');
  expect((init?.headers as any)['X-Subscription-Token']).toBe(key);expect(init?.redirect).toBe('error');
  return new Response(JSON.stringify({web:{results:[{url:'https://example.com/source',title:'<b>Source</b>',description:'A discovery snippet'},{url:'javascript:alert(1)',title:'Invalid'}]}}));
 });
 const result=await provider.search({query:'fixture topic',count:5});expect(requested).toBe(true);
 expect(result).toEqual([{url:'https://example.com/source',title:' Source ',snippet:'A discovery snippet'}]);expect(JSON.stringify(result)).not.toContain(key);
});
it('binds a paid search to approval, reserves before dispatch, and settles exactly once',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));await service.setStatus('RUNNING');await db.query('UPDATE company SET live_cap=10000000');
  let executions=0,actionId='';
  const tool=searchTool({id:'fixture',async search(){executions++;const a=await one(db,'SELECT status,reservation FROM actions WHERE id=$1',[actionId]);expect(a).toEqual({status:'EXECUTING',reservation:'5000'});return [{url:'https://example.com',title:'Source',snippet:'Untrusted snippet'}];}},'0.005');
  const gateway=new ToolGateway(service,new ToolRegistry().register(tool));
  const {id}=await service.createAction({actionType:'SEARCH_WEB',target:'fixture:web-search',payload:{provider:'fixture',version:1,costUsd:'0.005',query:'Fixture query',count:5},rationale:'Fixture research',maxCostUsd:'0.005',expiresAt:new Date(Date.now()+3600000).toISOString()});actionId=id;
  await expect(gateway.execute(id)).rejects.toThrow('requires owner approval');expect(executions).toBe(0);
  await service.approveAction(id,(await one(db,'SELECT action_hash FROM actions WHERE id=$1',[id])).action_hash,'APPROVE','Fixture');
  const result:any=await gateway.execute(id);expect(result.trust).toBe('UNTRUSTED_EXTERNAL_SOURCE');expect(result.discoveryOnly).toBe(true);
  await gateway.execute(id);expect(executions).toBe(1);
  expect((await one(db,'SELECT amount FROM ledger WHERE action_id=$1',[id])).amount).toBe('5000');
  expect((await one(db,'SELECT reservation FROM actions WHERE id=$1',[id])).reservation).toBe('0');
 }finally{await db.close();}
});
it('rejects changed pricing and retains an uncertain query hold without retry',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));await service.setStatus('RUNNING');await db.query('UPDATE company SET live_cap=10000000');
  let executions=0;const provider={id:'fixture',async search(){executions++;throw new Error('Unconfirmed transport');}};
  const {id}=await service.createAction({actionType:'SEARCH_WEB',target:'fixture:web-search',payload:{provider:'fixture',version:1,costUsd:'0.005',query:'Fixture query',count:5},rationale:'Fixture',maxCostUsd:'0.005',expiresAt:new Date(Date.now()+3600000).toISOString()});
  await service.approveAction(id,(await one(db,'SELECT action_hash FROM actions WHERE id=$1',[id])).action_hash,'APPROVE','Fixture');
  await expect(new ToolGateway(service,new ToolRegistry().register(searchTool(provider,'0.006'))).execute(id)).rejects.toThrow('pricing changed');expect(executions).toBe(0);
  const gateway=new ToolGateway(service,new ToolRegistry().register(searchTool(provider,'0.005')));
  await db.query('UPDATE company SET live_cap=0');await expect(gateway.execute(id)).rejects.toThrow('Lifetime paid cap');expect(executions).toBe(0);
  await db.query('UPDATE company SET live_cap=10000000,daily_cap=0');await expect(gateway.execute(id)).rejects.toThrow('Daily cap');expect(executions).toBe(0);
  await db.query('UPDATE company SET daily_cap=10000000');
  await expect(gateway.execute(id)).rejects.toThrow('uncertain');await expect(gateway.execute(id)).rejects.toThrow('not currently executable');expect(executions).toBe(1);
  expect(await one(db,'SELECT status,reservation FROM actions WHERE id=$1',[id])).toEqual({status:'UNCERTAIN',reservation:'5000'});
  expect((await db.query('SELECT id FROM ledger')).rows).toHaveLength(0);
 }finally{await db.close();}
});
