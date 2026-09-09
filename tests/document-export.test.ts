import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {documentHtml} from '../packages/runtime/src/document-export.js';
import {openDatabase,HiveService,createModels,writeDocument,proposeBusinessEmail} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';
const {simpleParser}=createRequire(new URL('../packages/runtime/package.json',import.meta.url))('mailparser');

it('renders escaped text-only PDF and freezes an exact document version in email MIME',async()=>{
 const html=documentHtml('Customer checklist','## Intake\n- [ ] Collect requirements\n<script>fetch("https://example.com")</script>\n![image](https://example.com/image)');
 expect(html).toContain('<h2>Intake</h2>');expect(html).toContain('&#9744;');expect(html).not.toContain('<script>');expect(html).not.toContain('<img');
 const db=await openDatabase(),service=new HiveService(db,createModels({})),app=buildApp({service,ownerToken:'pdf-fixture-owner',logger:false});try{
  const doc=await db.transaction(tx=>writeDocument(tx,{path:'deliverables/checklist.md',title:'Customer checklist',content:'# Checklist\n- [ ] Confirm scope\n- [ ] Deliver results',expectedVersion:0},'owner'));
  const url='/v1/documents/export.pdf?path=deliverables%2Fchecklist.md&version=1';expect((await app.inject({url})).statusCode).toBe(401);
  const response=await app.inject({url,headers:{authorization:'Bearer pdf-fixture-owner'}});expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toContain('application/pdf');expect(response.rawPayload.subarray(0,5).toString()).toBe('%PDF-');expect(response.rawPayload.length).toBeGreaterThan(1000);
  const draft={to:['buyer@example.com'],subject:'Your checklist',text:'Attached checklist.',documentAttachments:[{path:doc.path,version:1,filename:'checklist.PDF'}]};
  const message=await db.transaction(tx=>proposeBusinessEmail(tx,draft,'owner'));
  const parsed=await simpleParser(Buffer.from(message.raw_mime,'base64url'));expect(parsed.attachments).toHaveLength(1);expect(parsed.attachments[0].contentType).toBe('application/pdf');expect(parsed.attachments[0].content.subarray(0,5).toString()).toBe('%PDF-');
  await db.transaction(tx=>writeDocument(tx,{path:doc.path,title:'Revised checklist',content:'Changed scope',expectedVersion:1},'owner'));
  const repeated=await db.transaction(tx=>proposeBusinessEmail(tx,draft,'owner',undefined,message.id));expect(repeated.raw_mime).toBe(message.raw_mime);expect(repeated.content.attachments[0].version).toBe(1);
  expect((await db.query('SELECT status FROM actions WHERE id=$1',[message.id])).rows[0]!.status).toBe('PENDING');expect((await db.query('SELECT * FROM calls')).rows).toHaveLength(0);
 }finally{await app.close();await db.close();}
});
