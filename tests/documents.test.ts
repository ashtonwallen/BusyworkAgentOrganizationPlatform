import {taskDocuments} from '../packages/runtime/src/documents.js';
import {fitPrompt} from '../packages/runtime/src/prompt-capacity.js';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,Worker,writeDocument,readDocument,documentIndex,one} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
import {buildApp} from '../apps/api/src/app.js';
let db:Awaited<ReturnType<typeof openDatabase>>,service:HiveService;
beforeEach(async()=>{db=await openDatabase();service=new HiveService(db,createModels({}));});
afterEach(async()=>{await db.close();});
const save=(x:any,author='owner')=>db.transaction(async tx=>{await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');return writeDocument(tx,x,author);});
const draft={path:'operations/process.md',title:'Process',content:'First version',expectedVersion:0};
it('preserves versions and rejects stale or concurrent edits',async()=>{
 await save(draft);
 const results=await Promise.allSettled([save({...draft,content:'Second version',expectedVersion:1}),save({...draft,content:'Conflicting version',expectedVersion:1})]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect((await readDocument(db,draft.path,1)).content).toBe('First version');
 expect((await readDocument(db,draft.path)).version).toBe(2);
 await expect(save(draft)).rejects.toThrow('changed');
 await expect(db.query("DELETE FROM document_versions")).rejects.toThrow('immutable');
 expect(await documentIndex(db,'operations/')).toHaveLength(1);
});
it('rejects invalid paths and nonemployee writers without creating files',async()=>{
 for(const path of ['../secret','/absolute','folder/../secret','C:\\secret','folder//file']) await expect(save({...draft,path})).rejects.toThrow();
 await expect(save(draft,'unknown-agent')).rejects.toThrow('active employee');
 expect(await documentIndex(db)).toHaveLength(0);
});
it('protects document API access and returns version conflicts',async()=>{
 const app=buildApp({service,ownerToken:'document-fixture-owner-token',logger:false});
 try{
  expect((await app.inject({method:'PUT',url:'/v1/documents',payload:draft})).statusCode).toBe(401);
  const headers={authorization:'Bearer document-fixture-owner-token'};
  expect((await app.inject({method:'PUT',url:'/v1/documents',headers,payload:draft})).statusCode).toBe(200);
  expect((await app.inject({method:'PUT',url:'/v1/documents',headers,payload:draft})).statusCode).toBe(409);
  const read=await app.inject({method:'GET',url:'/v1/documents/read?path=operations%2Fprocess.md',headers});expect(read.json().content).toBe('First version');
 }finally{await app.close();}
});
it('lets an employed agent write and read shared work with replay-safe operations',async()=>{
 const org=new Organization(service);const person=await db.transaction(tx=>org.ensureCEO(tx));
 const provider=new MockProvider(),generate=provider.generate.bind(provider);
 provider.generate=async request=>{
  const result=await generate(request);
  if((request.input as any).phase==='WORK') {
   for(const key of ['customer','problem','offer','channel','priceHypothesis','validationTest','successCriteria','killCriteria','estimatedTestCostUsd']) delete (result.output as any)[key];
   (result.output as any).operations=['WRITE_DOCUMENT','READ_DOCUMENT','FIND_DOCUMENTS'].map(type=>({type,target:draft.path,title:draft.title,instructions:draft.content,expectedVersion:type==='WRITE_DOCUMENT'?0:null,budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}));
  }
  return result;
 };
 service.models.find(m=>m.id==='mock-worker')!.adapter=provider;
 const task=await service.createTask({objective:'Document our workflow',employeeId:person.id,modelId:'mock-worker',tokenBudget:150000});
 await service.setStatus('RUNNING');const worker=new Worker(service);
 for(let i=0;i<3;i++)await worker.runNext();
 await org.applyOperations(task.id);await org.applyOperations(task.id);
 const doc=await readDocument(db,draft.path);expect(doc.author_id).toBe(person.id);expect(doc.version).toBe(1);expect(doc.task_id).toBe(task.id);
 const messages=await db.query('SELECT body FROM messages WHERE recipient_id=$1',[person.id]);expect(messages.rows.some((m:any)=>m.body.includes('First version'))).toBe(true);expect(messages.rows.some((m:any)=>m.body.includes('documents'))).toBe(true);
 expect((await db.query('SELECT * FROM document_versions')).rows).toHaveLength(1);
});

it('lets an agent freeze its reviewed site documents without owner assembly or publication',async()=>{
 const org=new Organization(service);const person=await db.transaction(tx=>org.ensureCEO(tx));const provider=new MockProvider(),generate=provider.generate.bind(provider);
 provider.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK'){
 const common={title:'Site release',instructions:'Prepare the exact internal source for later publishing review.',budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null};
 (result.output as any).operations=[{...common,type:'WRITE_DOCUMENT',target:'site/index.html',instructions:'<h1>A hypothesis, not a recorded sale</h1>',expectedVersion:0},{...common,type:'PREPARE_RELEASE',target:'22222222-2222-4222-8222-222222222222',releaseFiles:[{path:'index.html',documentPath:'site/index.html',version:1}]}];}return result;};
 service.models.find(m=>m.id==='mock-worker')!.adapter=provider;
 const task=await service.createTask({objective:'Prepare a reviewed static release.',employeeId:person.id,modelId:'mock-worker',tokenBudget:150000});await service.setStatus('RUNNING');const worker=new Worker(service);for(let i=0;i<3;i++)await worker.runNext();
 await org.applyOperations(task.id);await org.applyOperations(task.id);
 expect(await one(db,'SELECT status,error FROM tasks WHERE id=$1',[task.id])).toEqual({status:'COMPLETED',error:null});
 expect((await db.query('SELECT status,result FROM operations WHERE task_id=$1',[task.id])).rows).toEqual(expect.arrayContaining([expect.objectContaining({status:'APPLIED'})]));
 const release=await one(db,'SELECT * FROM static_releases');expect(release.author_id).toBe(person.id);expect(release.task_id).toBe(task.id);expect(release.manifest.files[0].content).toContain('not a recorded sale');
 expect((await db.query('SELECT id FROM static_releases')).rows).toHaveLength(1);expect((await db.query('SELECT id FROM actions')).rows).toHaveLength(0);
 expect((await db.query("SELECT id FROM ledger WHERE account<>'TEST'")).rows).toHaveLength(0);
});

it('supplies exact referenced versions and marks missing or omitted content explicitly',async()=>{
 await save(draft);await save({...draft,content:'Changed terms',expectedVersion:1});
 const task={objective:'Review '+draft.path,plan:null,artifact:{operations:[{type:'READ_DOCUMENT',target:draft.path,expectedVersion:1}]}};
 const result=await taskDocuments(db,task);expect(result.documents[0]).toMatchObject({path:draft.path,version:1,currentVersion:2,content:'First version',complete:true});
 const missing=await taskDocuments(db,{...task,artifact:{operations:[{type:'READ_DOCUMENT',target:draft.path,expectedVersion:99}]}});expect(missing.documents[0]).toMatchObject({version:99,complete:false});
 const fitted=fitPrompt({model:'fixture',correlationId:'fixture',input:{referencedDocuments:result},maxOutputTokens:100},1);
 expect((fitted.input as any).referencedDocuments.documents[0]).toMatchObject({version:1,currentVersion:2,complete:false});expect((fitted.input as any).referencedDocuments.documents[0].content).toBeUndefined();expect(result.documents[0].complete).toBe(true);
});
it('lets an assigned worker use a named shared document without a read-only cycle',async()=>{
 await save(draft);const org=new Organization(service),employee=await db.transaction(tx=>org.ensureCEO(tx));
 const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);let sawDocument=false;
 adapter.generate=async request=>{const input=request.input as any;const result=await generate(request);if(input.phase==='WORK'){
  const document=input.referencedDocuments.documents.find((d:any)=>d.path===draft.path);
  sawDocument=document?.complete&&document?.content==='First version';
  (result.output as any).summary=sawDocument?'Inspected the supplied first version.':'Missing reference';(result.output as any).operations=[];
 }return result;};service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
 const task=await service.createTask({objective:'Inspect '+draft.path+' and report what is present.',employeeId:employee.id,modelId:'mock-worker',tokenBudget:150000});await service.setStatus('RUNNING');const worker=new Worker(service);for(let n=0;n<3;n++)await worker.runNext();
 expect(sawDocument).toBe(true);expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[task.id])).status).toBe('COMPLETED');
 expect((await db.query('SELECT id FROM operations WHERE task_id=$1',[task.id])).rows).toHaveLength(0);
});

it('retains the rejected artifact for source-grounded revision before accepting corrected work',async()=>{
 await save({...draft,content:'Price: $29 prepaid. Preserve the September 15 cutoff.'});
 const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);let workCalls=0;
 adapter.generate=async request=>{
  const input=request.input as any,result=await generate(request);
  if(input.phase==='WORK'){
   if(++workCalls===1){
    expect(input.artifact).toBeUndefined();
    (result.output as any).summary='Price: $50. Keep the original scope.';
    (result.output as any).deliverables=[{filename:'audit.md',mediaType:'text/markdown',content:'Price: $50. Keep the original scope.'}];
   }else{
    expect(input.previousReview.decision).toBe('REVISE');
    expect(input.artifact.summary).toBe('Price: $50. Keep the original scope.');
    expect(input.artifact.deliverables[0].content).toContain('$50');
    expect(input.referencedDocuments.documents[0].content).toContain('$29 prepaid');
    expect(input.reviewInstructions).toContain('complete corrected artifact');
    result.output={...input.artifact,summary:'Price: $29 prepaid. Keep the original scope.',deliverables:[{...input.artifact.deliverables[0],content:'Price: $29 prepaid. Keep the original scope.'}]};
   }
   (result.output as any).operations=[];
  }
  if(input.phase==='REVIEW'){
   expect(input.reviewInstructions).toContain('PASS accepts this artifact unchanged');
   result.output=input.artifact.summary.includes('$50')
    ? {decision:'REVISE',findings:['The saved audit incorrectly says $50; the source says $29 prepaid.'],nextAction:'Correct the summary and deliverable, preserving scope.'}
    : {decision:'PASS',findings:['The saved summary and deliverable match the source price.'],nextAction:'Use this audit.'};
  }
  return result;
 };
 service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
 const task=await service.createTask({objective:'Audit '+draft.path,modelId:'mock-worker',tokenBudget:150000});
 await service.setStatus('RUNNING');const worker=new Worker(service);
 for(let n=0;n<5;n++)await worker.runNext();
 const stored=await one(db,'SELECT status,artifact FROM tasks WHERE id=$1',[task.id]);
 expect(stored.status).toBe('COMPLETED');expect(stored.artifact.summary).toBe('Price: $29 prepaid. Keep the original scope.');
 const versions=(await db.query('SELECT content FROM task_artifacts WHERE task_id=$1',[task.id])).rows.map((r:any)=>r.content);
 expect(versions).toEqual(expect.arrayContaining(['Price: $50. Keep the original scope.','Price: $29 prepaid. Keep the original scope.']));
 expect(workCalls).toBe(2);
});
