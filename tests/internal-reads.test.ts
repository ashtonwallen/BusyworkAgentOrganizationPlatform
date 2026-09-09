import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,Worker,one,writeDocument} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
import {internalRead,internalReadContext} from '../packages/runtime/src/internal-reads.js';
it('reads a document within the same charged task, survives pause/restart, then reviews the informed result',async()=>{
 const db=await openDatabase();try{
 const models=createModels({}),service=new HiveService(db,models),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
 await db.transaction(tx=>writeDocument(tx,{path:'offers/terms.md',title:'Offer terms',content:'Maximum input: 500 words. One minor revision.',expectedVersion:0},'owner'));
 const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);let work=0,review=0;
 adapter.generate=async request=>{const result=await generate(request),input=request.input as any;
 if(input.phase==='WORK'){work++;const output=result.output as any;if(work===1){output.readRequest={type:'DOCUMENT_FIND',target:'Offer terms',offset:0,version:null};output.operations=[];output.deliverables=[];output.summary='Need to find the recorded terms before deciding.';}else if(work===2){expect(input.internalRead.result.documents[0].path).toBe('offers/terms.md');expect(input.internalRead.result.documents[0]).not.toHaveProperty('content');output.readRequest={type:'DOCUMENT',target:'offers/terms.md',offset:0,version:1};output.operations=[];output.deliverables=[];output.summary='Found offer terms version 1; inspect its contents.';}else{expect(input.internalRead.error).toBeNull();expect(JSON.parse(input.internalRead.result.content).content).toContain('500 words');output.readRequest=null;output.summary='The recorded offer allows 500 input words and one minor revision.';}}
 if(input.phase==='REVIEW'){review++;expect(input.artifact.summary).toContain('500 input words');}
 return result;};models.find(m=>m.id==='mock-worker')!.adapter=adapter;
 const task=await service.createTask({objective:'Summarize the recorded offer scope.',employeeId:ceo.id});await service.setStatus('RUNNING');const worker=new Worker(service);await worker.runNext();await worker.runNext();
 let row=await one(db,'SELECT * FROM tasks WHERE id=$1',[task.id]);expect(row.status).toBe('READY');expect(row.phase).toBe('WORK');expect(row.artifact).toBeNull();expect(review).toBe(0);
 await service.setStatus('PAUSED');expect(await worker.runNext()).toBe(false);const resumedService=new HiveService(db,models),resumedWorker=new Worker(resumedService);await resumedService.setStatus('RUNNING');await resumedWorker.runNext();await resumedWorker.runNext();await resumedWorker.runNext();
 row=await one(db,'SELECT * FROM tasks WHERE id=$1',[task.id]);expect(row.status).toBe('COMPLETED');expect(work).toBe(3);expect(review).toBe(1);expect((await db.query('SELECT * FROM tasks')).rows).toHaveLength(1);expect((await db.query('SELECT * FROM calls')).rows).toHaveLength(5);expect((await db.query('SELECT * FROM ledger')).rows).toHaveLength(5);expect((await db.query('SELECT * FROM actions')).rows).toHaveLength(0);
 }finally{await db.close();}
});
it('returns missing local reads as recoverable context and retains message/mail access boundaries',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
 await expect(db.transaction(tx=>internalRead(tx,service,'unknown',{type:'DOCUMENT',target:'missing'}))).rejects.toThrow('active employee');
 await db.query('INSERT INTO email_permissions(employee_id,can_read,can_send) VALUES($1,false,false)',[ceo.id]);
 const cached={employeeId:ceo.id,request:{type:'EMAIL',target:'old'},result:{content:'private mail'},workingNotes:'private note'};expect((await db.transaction(tx=>internalReadContext(tx,ceo.id,cached)))?.result).toBeNull();expect((await db.transaction(tx=>internalReadContext(tx,'another-worker',{...cached,request:{type:'WORKSPACE'}})))?.workingNotes).toBeNull();
 await expect(db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'EMAIL',target:'missing'}))).rejects.toThrow('permission');
 await db.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body) VALUES('private','someone','else','MESSAGE','Private','Hidden')");await expect(db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'MESSAGE',target:'private'}))).rejects.toThrow('unavailable');
 const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);adapter.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK'){(result.output as any).readRequest={type:'DOCUMENT',target:'missing',offset:0,version:null};(result.output as any).operations=[];(result.output as any).deliverables=[];}return result;};service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
 const task=await service.createTask({objective:'Inspect a missing record.',employeeId:ceo.id});await service.setStatus('RUNNING');const worker=new Worker(service);await worker.runNext();await worker.runNext();const row=await one(db,'SELECT * FROM tasks WHERE id=$1',[task.id]);expect(row.status).toBe('READY');const read=await one(db,"SELECT payload FROM events WHERE type='task.internal_read' AND entity_id=$1",[task.id]);expect(read.payload.error).toContain('not found');expect((await db.query('SELECT * FROM operations')).rows).toHaveLength(0);
 }finally{await db.close();}
});

it('rejects a read step mixed with deliverables without reading or publishing the draft',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx)),adapter=new MockProvider(),generate=adapter.generate.bind(adapter);
 adapter.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK'){const output=result.output as any;output.readRequest={type:'DOCUMENT',target:'missing',offset:0,version:null};output.deliverables=[{filename:'premature.txt',mediaType:'text/plain',content:'Not final'}];}return result;};service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
 const task=await service.createTask({objective:'Read before writing.',employeeId:ceo.id});await service.setStatus('RUNNING');const worker=new Worker(service);await worker.runNext();await worker.runNext();const row=await one(db,'SELECT * FROM tasks WHERE id=$1',[task.id]);expect(row.status).toBe('READY');expect(row.error).toContain('leave operations and deliverables empty');expect((await db.query('SELECT * FROM task_artifacts')).rows).toHaveLength(0);expect((await db.query("SELECT * FROM events WHERE type='task.internal_read'")).rows).toHaveLength(0);
 }finally{await db.close();}
});

it('pages source discovery and removes cached message previews after department access changes',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
 for(let i=0;i<25;i++)await db.transaction(tx=>writeDocument(tx,{path:'reference/'+String(i).padStart(2,'0')+'.md',title:'Source '+i,content:'Evidence '+i,expectedVersion:0},'owner'));
 const a=await db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'DOCUMENT_FIND',target:'reference'})) as any,b=await db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'DOCUMENT_FIND',target:'reference',before:a.nextBefore})) as any;
 expect(a.documents).toHaveLength(20);expect(b.documents).toHaveLength(5);expect(b.nextBefore).toBeNull();expect(new Set([...a.documents,...b.documents].map(d=>d.path)).size).toBe(25);
 await db.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body) VALUES('department','peer','executive','MESSAGE','Handoff','Department-only text'),('unrelated','peer','someone','MESSAGE','Hidden','Do not expose')");
 const found=await db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'MESSAGE_FIND',target:'*'})) as any;expect(found.messages.map(m=>m.id)).toEqual(['department']);
 const cached={employeeId:ceo.id,request:{type:'MESSAGE_FIND',target:'*'},result:found,workingNotes:'Handoff'};expect((await db.transaction(tx=>internalReadContext(tx,ceo.id,cached)))?.result).toEqual(found);
 await db.query("UPDATE employees SET department_id='build' WHERE id=$1",[ceo.id]);expect((await db.transaction(tx=>internalReadContext(tx,ceo.id,cached)))?.result).toBeNull();
 }finally{await db.close();}
});

it('inspects original task/action evidence in-task and detects changing results without external replay',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
 const original=await service.createTask({objective:'Original work',employeeId:ceo.id});await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[original.id,JSON.stringify({title:'Evidence',summary:'No confirmation',operations:[],deliverables:[]})]);
 const taskRead=await db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'TASK_RESULT',target:original.id})) as any;expect(JSON.parse(taskRead.content).summary).toBe('No confirmation');
 const action=await service.createAction({taskId:original.id,actionType:'OTHER_EXTERNAL',target:'Original fixture',payload:{description:'Original'},rationale:'Fixture',maxCostUsd:'0',expiresAt:new Date(Date.now()+3600000).toISOString()});await db.query("UPDATE actions SET status='UNCERTAIN',result=$2 WHERE id=$1",[action.id,JSON.stringify({diagnostic:'No confirmed response'})]);
 const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);let work=0;
 adapter.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK'){const output=result.output as any;if(++work===1){output.readRequest={type:'ACTION_RESULT',target:action.id,offset:0};output.operations=[];output.deliverables=[];}else{expect(JSON.parse((request.input as any).internalRead.result.content)).toMatchObject({status:'UNCERTAIN',executionConfirmed:false});output.readRequest=null;output.summary='The original action remains uncertain; no confirmed result is recorded.';}}return result;};service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
 const investigation=await service.createTask({objective:'Inspect the original action only.',employeeId:ceo.id});await service.setStatus('RUNNING');const worker=new Worker(service);for(let i=0;i<4;i++)await worker.runNext();expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[investigation.id])).status).toBe('COMPLETED');expect((await db.query('SELECT id,status FROM actions')).rows).toEqual([{id:action.id,status:'UNCERTAIN'}]);expect((await db.query('SELECT id FROM ledger WHERE action_id=$1',[action.id])).rows).toHaveLength(0);
 const cached=await one(db,"SELECT payload FROM events WHERE type='task.internal_read' AND entity_id=$1",[investigation.id]);await db.query("UPDATE actions SET result=$2 WHERE id=$1",[action.id,JSON.stringify({diagnostic:'New local reconciliation note, still uncertain'})]);expect((await db.transaction(tx=>internalReadContext(tx,ceo.id,cached.payload)))?.error).toContain('changed');
 await db.query("INSERT INTO employees(id,name,role,department_id,depth,charter,model_id) VALUES('other','Other','Analyst','build',0,'Fixture','mock-worker')");await expect(db.transaction(tx=>internalRead(tx,service,'other',{type:'TASK_RESULT',target:original.id}))).rejects.toThrow('unavailable');await expect(db.transaction(tx=>internalRead(tx,service,'other',{type:'ACTION_RESULT',target:action.id}))).rejects.toThrow('unavailable');
 }finally{await db.close();}
});
