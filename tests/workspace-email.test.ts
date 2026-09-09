import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase,HiveService,createModels,Organization,Workspaces,proposeBusinessEmail} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';

it('freezes exact-hash workspace attachments and permits authenticated review without exposing other employee files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'busywork-delivery-test-')),db=await openDatabase();
 const service=new HiveService(db,createModels({}));service.workspaces=new Workspaces(root);const app=buildApp({service,ownerToken:'workspace-email-fixture',logger:false});try{
  const org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
  const saved=await service.workspaces.write(ceo.id,'cleaned.csv','name\nAlice\nBob\n');
  const draft={to:['buyer@example.com'],subject:'Cleaned data',text:'Please find your processed file attached.',workspaceAttachments:[{path:'private/cleaned.csv',sha256:saved.sha256,filename:'result.csv'}]};
  const proposed=await db.transaction(tx=>proposeBusinessEmail(tx,draft,ceo.id,undefined,undefined,service.workspaces));
  expect(proposed.content.attachments[0]).toMatchObject({source:'workspace',employeeId:ceo.id,sha256:saved.sha256,mimeType:'text/csv'});
  await writeFile(join(root,'agents',ceo.id,'cleaned.csv'),'Changed data');
  const repeated=await db.transaction(tx=>proposeBusinessEmail(tx,draft,ceo.id,undefined,proposed.id,service.workspaces));expect(repeated.raw_mime).toBe(proposed.raw_mime);
  await expect(db.transaction(tx=>proposeBusinessEmail(tx,draft,ceo.id,undefined,undefined,service.workspaces))).rejects.toThrow('changed');
  await expect(db.transaction(tx=>proposeBusinessEmail(tx,{...draft,workspaceAttachments:[{...draft.workspaceAttachments[0],employeeId:'another-employee'}]},ceo.id,undefined,undefined,service.workspaces))).rejects.toThrow('own private');
  const url='/v1/email/messages/'+proposed.id+'/attachments/0';expect((await app.inject({url})).statusCode).toBe(401);
  const response=await app.inject({url,headers:{authorization:'Bearer workspace-email-fixture'}});expect(response.statusCode).toBe(200);expect(response.body).toBe('name\nAlice\nBob\n');expect(response.headers['content-type']).toContain('text/csv');
  expect((await db.query('SELECT status FROM actions WHERE id=$1',[proposed.id])).rows[0]!.status).toBe('PENDING');expect((await db.query('SELECT * FROM calls')).rows).toHaveLength(0);
 }finally{await app.close();await db.close();await rm(root,{recursive:true,force:true});}
});
