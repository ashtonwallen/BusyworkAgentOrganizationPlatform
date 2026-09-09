import {it,expect} from 'vitest';
import {mkdtemp,rm,mkdir,symlink,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Workspaces,openDatabase,HiveService,createModels,Organization,Worker,one} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
import {buildApp} from '../apps/api/src/app.js';
async function fixture(){const root=await mkdtemp(join(tmpdir(),'hive-workspace-test-'));return {root,workspace:new Workspaces(join(root,'workspaces')),async close(){if(!resolve(root).startsWith(resolve(tmpdir())+requireSeparator())||!root.includes('hive-workspace-test-'))throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});}};}
function requireSeparator(){return process.platform==='win32'?'\\':'/';}
it('persists actual files, isolates agents and preserves prior work across retries',async()=>{
 const f=await fixture();try{
  const first=await f.workspace.write('alice','notes/idea.md','Small test');expect(first.bytes).toBe(10);
  expect(await f.workspace.write('alice','notes/idea.md','Small test')).toEqual(first);
  await expect(f.workspace.write('alice','notes/idea.md','Different')).rejects.toThrow('already exists');
  expect(await readFile(join(f.root,'workspaces/agents/alice/notes/idea.md'),'utf8')).toBe('Small test');
  expect((await new Workspaces(f.workspace.root).read('alice','notes/idea.md')).content).toBe('Small test');
  expect(await f.workspace.list('bob')).toEqual([]);
  await f.workspace.write('alice','handoff.txt','For Bob','shared');expect((await f.workspace.read('bob','handoff.txt','shared')).content).toBe('For Bob');
  for(const path of ['../secret','.env','C:/secret','a/../../b','x\\..\\b','file:stream','CON.txt','a./b'])await expect(f.workspace.write('alice',path,'x')).rejects.toThrow();
  await expect(f.workspace.write('alice','big.txt','x'.repeat(48001))).rejects.toThrow('48 KB');
  await mkdir(join(f.root,'outside'));await symlink(join(f.root,'outside'),join(f.root,'workspaces/agents/alice/linked'),'junction');
  await expect(f.workspace.write('alice','linked/file.txt','escape')).rejects.toThrow('links');
 }finally{await f.close();}
});
it('executes reviewed workspace operations once and exposes files only through owner API',async()=>{
 const f=await fixture(),db=await openDatabase();const service=new HiveService(db,createModels({}));service.workspaces=f.workspace;const org=new Organization(service);
 try{
  const ceo=await db.transaction(tx=>org.ensureCEO(tx));const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);
  adapter.generate=async r=>{const result=await generate(r);if((r.input as any).phase==='WORK')(result.output as any).operations=[{type:'WORKSPACE_WRITE',target:'private/notes.txt',title:'Notes',instructions:'A small internal note.',budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];return result;};service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
  const task=await service.createTask({objective:'Write a note',employeeId:ceo.id,modelId:'mock-worker',tokenBudget:150000});await service.setStatus('RUNNING');const worker=new Worker(service);for(let i=0;i<3;i++)await worker.runNext();await org.applyOperations(task.id);await org.applyOperations(task.id);
  expect((await f.workspace.read(ceo.id,'notes.txt')).content).toBe('A small internal note.');expect((await db.query("SELECT id FROM messages WHERE sender_id='workspace'")).rows).toHaveLength(1);
  const app=buildApp({service,ownerToken:'fixture-token',logger:false});try{
   expect((await app.inject({url:'/v1/workspaces?employeeId='+ceo.id})).statusCode).toBe(401);
   const response=await app.inject({url:'/v1/workspaces?employeeId='+ceo.id,headers:{authorization:'Bearer fixture-token'}});expect(response.statusCode).toBe(200);expect(response.json()).toEqual([{path:'notes.txt',bytes:22}]);
  }finally{await app.close();}
 }finally{await db.close();await f.close();}
});

it('copies full files by exact hash across internal scopes without model rewriting or overwrites',async()=>{
 const f=await fixture(),db=await openDatabase();const service=new HiveService(db,createModels({}));service.workspaces=f.workspace;const org=new Organization(service);let app;
 try{
 const ceo=await db.transaction(tx=>org.ensureCEO(tx)),content='\uFEFFname,value\r\n'+('caf\u00e9,1\r\n'.repeat(2000));
 const saved=await f.workspace.write(ceo.id,'customer.csv',content);const read=await f.workspace.read(ceo.id,'customer.csv');expect(read.content).toBe(content);expect(read.sha256).toBe(saved.sha256);
 await expect(f.workspace.copy(ceo.id,'private/customer.csv','shared/handoff.csv','0'.repeat(64))).rejects.toThrow('changed');
 const source=await service.createTask({objective:'Share customer handoff',employeeId:ceo.id});const artifact=(await new MockProvider().generate({input:{phase:'WORK'}} as any)).output as any;
 artifact.operations=[{type:'WORKSPACE_COPY',target:'shared/handoff.csv',workspaceSource:{path:'private/customer.csv',sha256:saved.sha256},title:'Share handoff',instructions:'Copy inspected data.',budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];
 await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[source.id,JSON.stringify(artifact)]);await service.setStatus('RUNNING');await org.applyOperations(source.id);await org.applyOperations(source.id);
 expect((await f.workspace.read('another-agent','handoff.csv','shared')).content).toBe(content);expect((await db.query("SELECT * FROM events WHERE type='workspace.copied'")).rows).toHaveLength(1);
 await expect(f.workspace.copy('another-agent','private/customer.csv','shared/stolen.csv',saved.sha256)).rejects.toThrow();
 const different=await f.workspace.write(ceo.id,'different.csv','other');await expect(f.workspace.copy(ceo.id,'private/different.csv','shared/handoff.csv',different.sha256)).rejects.toThrow('already exists');
 app=buildApp({service,ownerToken:'copy-fixture',logger:false});const payload={employeeId:ceo.id,source:'shared/handoff.csv',destination:'private/received.csv',sha256:saved.sha256};expect((await app.inject({method:'POST',url:'/v1/workspaces/copy',payload})).statusCode).toBe(401);
 const response=await app.inject({method:'POST',url:'/v1/workspaces/copy',payload,headers:{authorization:'Bearer copy-fixture'}});expect(response.statusCode).toBe(200);expect(response.json().sha256).toBe(saved.sha256);expect(response.json()).not.toHaveProperty('content');expect((await f.workspace.read(ceo.id,'received.csv')).content).toBe(content);
 }finally{await app?.close();await db.close();await f.close();}
});

it('pages workspace text and directories without losing Unicode or silently hiding remaining content',async()=>{
 const f=await fixture();try{
 const content='x'.repeat(3999)+'\u{1F680}'+'z'.repeat(7000);const saved=await f.workspace.write('alice','large.txt',content);let offset=0,joined='';
 do{const page=await f.workspace.readPage('alice','large.txt','private',offset);expect(page.content.length).toBeLessThanOrEqual(4000);expect(page.sha256).toBe(saved.sha256);expect(page.complete).toBe(false);if(!offset)expect(page.content).toHaveLength(3999);joined+=page.content;if(page.nextOffset===null)break;offset=page.nextOffset;}while(true);expect(joined).toBe(content);
 await expect(f.workspace.readPage('alice','large.txt','private',content.length+1)).rejects.toThrow('out of range');
 for(let i=0;i<22;i++)await f.workspace.write('alice','file-'+i+'.txt','x');
 const a=await f.workspace.listPage('alice'),b=await f.workspace.listPage('alice','private',a.nextOffset!);expect(a.files).toHaveLength(20);expect(b.files).toHaveLength(3);expect(b.nextOffset).toBeNull();expect(a.listHash).toBe(b.listHash);expect(new Set([...a.files,...b.files].map(x=>x.path)).size).toBe(23);
 await f.workspace.write('alice','new.txt','New');expect((await f.workspace.listPage('alice')).listHash).not.toBe(a.listHash);expect((await f.workspace.listPage('bob')).totalFiles).toBe(0);
 }finally{await f.close();}
});
