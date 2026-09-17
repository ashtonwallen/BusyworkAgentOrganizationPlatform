import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {openDatabase,HiveService,createModels,one,writeDocument,readDocument} from '../packages/runtime/src/index.js';
import {ToolGateway,ToolRegistry,publicPageTool} from '../packages/runtime/src/tools.js';
import {readSource} from '../packages/runtime/src/source-records.js';

it('retains one immutable source receipt and pins claims to real sources and document versions',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));await service.setStatus('RUNNING');
  const task=await service.createTask({objective:'Read a fixture source',modelId:'mock-worker'});
  const action=await service.createAction({actionType:'READ_PUBLIC_PAGE',taskId:task.id,target:'https://example.com/source',payload:{},rationale:'Fixture',maxCostUsd:'0',expiresAt:new Date(Date.now()+3600000).toISOString()});
  await service.approveAction(action.id,(await one(db,'SELECT action_hash FROM actions WHERE id=$1',[action.id])).action_hash,'APPROVE','Fixture');
  const text='A retained finding. '.repeat(300);
  const gateway=new ToolGateway(service,new ToolRegistry().register({...publicPageTool,execute:async()=>({result:{text,truncated:true,trust:'UNTRUSTED_EXTERNAL_SOURCE'},actualCostUsd:'0'})}));
  const result:any=await gateway.execute(action.id);await gateway.execute(action.id);
  const source=await one(db,'SELECT * FROM source_records');expect(source.id).toBe(result.sourceRecordId);expect(source.task_id).toBe(task.id);expect(source.url).toBe('https://example.com/source');
  expect(source.content_hash).toBe(createHash('sha256').update(text).digest('hex'));expect(source.truncated).toBe(true);
  const first=await readSource(db,source.id),second=await readSource(db,source.id,first.nextOffset!);expect(first.content+second.content).toBe(text);
  const draft={path:'research/report.md',title:'Report',content:'A retained finding. Its applicability is uncertain.',expectedVersion:0,
   claims:[{text:'A retained finding.',kind:'OBSERVATION',sourceIds:[source.id]},{text:'Applicability is uncertain.',kind:'INFERENCE',sourceIds:[]}]};
  await db.transaction(tx=>writeDocument(tx,draft,'owner',task.id));
  const report=await readDocument(db,draft.path,1);expect(report.claims[0].sources[0].id).toBe(source.id);expect(report.claims[1].uncited).toBe(true);
  await expect(db.transaction(tx=>writeDocument(tx,{...draft,expectedVersion:1,claims:[{text:'Invented',kind:'OBSERVATION',sourceIds:[]}]},'owner'))).rejects.toThrow('observation requires');
  await expect(db.transaction(tx=>writeDocument(tx,{...draft,expectedVersion:1,claims:[{text:'Invented',kind:'OBSERVATION',sourceIds:['missing']}]},'owner'))).rejects.toThrow('does not exist');
  expect((await readDocument(db,draft.path)).version).toBe(1);
  await expect(db.query("UPDATE source_records SET content='replacement'")).rejects.toThrow('append-only');
  await expect(db.query('DELETE FROM document_claims')).rejects.toThrow('append-only');
  await expect(db.query('DELETE FROM claim_sources')).rejects.toThrow('append-only');
 }finally{await db.close();}
});
