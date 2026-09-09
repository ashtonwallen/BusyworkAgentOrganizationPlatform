import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {openDatabase,HiveService,createModels,Organization,proposeBusinessEmail} from '../packages/runtime/src/index.js';
import {withdrawOwnEmail} from '../packages/runtime/src/email-withdraw.js';
import {MockProvider} from '../packages/providers/src/index.js';
it('withdraws an agents own unsent proposal once without granting recall or modifying MIME',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));const email={to:['buyer@example.com'],subject:'Draft',text:'Review draft.'};
 const own=await db.transaction(tx=>proposeBusinessEmail(tx,email,ceo.id,undefined,randomUUID()));const owner=await db.transaction(tx=>proposeBusinessEmail(tx,email,'owner',undefined,randomUUID()));
 await expect(db.transaction(tx=>withdrawOwnEmail(tx,ceo.id,owner.id,'Wrong draft'))).rejects.toThrow('you authored');
 const task=await service.createTask({objective:'Withdraw outdated email',employeeId:ceo.id}),artifact=(await new MockProvider().generate({input:{phase:'WORK'}} as any)).output as any;
 artifact.operations=[{type:'BUSINESS_EMAIL_WITHDRAW',target:own.id,title:'Withdraw draft',instructions:'Scope changed.',budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null}];await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[task.id,JSON.stringify(artifact)]);await db.query('INSERT INTO email_permissions(employee_id,can_read,can_send) VALUES($1,false,false)',[ceo.id]);await service.setStatus('RUNNING');await org.applyOperations(task.id);await org.applyOperations(task.id);
 expect((await db.query('SELECT status FROM actions WHERE id=$1',[own.action_id])).rows[0]!.status).toBe('CANCELLED');expect((await db.query('SELECT raw_mime FROM email_messages WHERE id=$1',[own.id])).rows[0]!.raw_mime).toBe(own.raw_mime);expect((await db.query("SELECT * FROM events WHERE type='email.withdrawn'")).rows).toHaveLength(1);
 expect((await db.transaction(tx=>withdrawOwnEmail(tx,ceo.id,own.id,'Repeat'))).alreadyWithdrawn).toBe(true);
 await db.query("UPDATE email_messages SET status='UNCERTAIN' WHERE id=$1",[own.id]);await expect(db.transaction(tx=>withdrawOwnEmail(tx,ceo.id,own.id,'Recall'))).rejects.toThrow('dispatched');expect((await db.query('SELECT * FROM email_messages')).rows).toHaveLength(2);
 }finally{await db.close();}
});
