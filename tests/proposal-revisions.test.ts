import {it,expect} from 'vitest';
import {openDatabase,HiveService,Organization,createModels,one} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
it('assigns idempotent revision work, preserves originals and requires fresh approval for resubmission',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));const org=new Organization(service);
  await db.query("UPDATE company SET ceo_model_id='mock-worker',approval_policy=approval_policy || '{\"research\":false}'::jsonb WHERE id=1");
  await service.setStatus('RUNNING');await org.tick();const source=await one(db,"SELECT * FROM tasks WHERE role='CEO'");
  const original=await service.createAction({taskId:source.id,actionType:'READ_PUBLIC_PAGE',target:'https://example.com/',payload:{description:'Read the wrong page'},rationale:'Research',maxCostUsd:'0',expiresAt:new Date(Date.now()+86400000).toISOString()});
  const before=await one(db,'SELECT * FROM actions WHERE id=$1',[original.id]);
  await expect(org.requestProposalChanges(original.id,'stale','Use the about page')).rejects.toThrow('changed');
  await expect(org.requestProposalChanges(original.id,before.action_hash,'  ')).rejects.toThrow();
  const revision=await org.requestProposalChanges(original.id,before.action_hash,'Use the about page');
  expect(await org.requestProposalChanges(original.id,before.action_hash,'Use the about page')).toEqual(revision);
  await expect(org.requestProposalChanges(original.id,before.action_hash,'Different feedback')).rejects.toThrow('already');
  const retired=await one(db,'SELECT * FROM actions WHERE id=$1',[original.id]);expect(retired.status).toBe('CANCELLED');expect(retired.payload).toEqual(before.payload);expect(retired.action_hash).toBe(before.action_hash);
  const task=await one(db,'SELECT * FROM tasks WHERE id=$1',[revision.taskId]);expect(task.employee_id).toBe(source.employee_id);expect(task.objective).toContain('Use the about page');
  const mock=await new MockProvider().generate({model:'mock-worker',input:{phase:'WORK'},correlationId:'fixture'});
  await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2,review=$3 WHERE id=$1",[task.id,JSON.stringify({...mock.output as object,operations:[{type:'READ_PUBLIC_PAGE',target:'https://example.com/about',title:'Revised research',instructions:'Use requested page',budgetUsd:'0',tokenBudget:1000,modelId:'mock-worker',participants:[],scheduledAt:null}]}),JSON.stringify({decision:'PASS',findings:[],nextAction:'Proceed'})]);
  await org.applyOperations(task.id);await org.applyOperations(task.id);
  const revised=await one(db,'SELECT * FROM actions WHERE task_id=$1',[task.id]);expect(revised.revises_action_id).toBe(original.id);expect(revised.status).toBe('PENDING');
  expect((await db.query('SELECT id FROM actions WHERE task_id=$1',[task.id])).rows).toHaveLength(1);
  await expect(db.query("UPDATE actions SET status='EXECUTING' WHERE id=$1",[revised.id])).rejects.toThrow('fresh owner approval');
  await service.approveAction(revised.id,revised.action_hash,'APPROVE','Revised scope approved');
  await db.query("UPDATE actions SET status='EXECUTING' WHERE id=$1",[revised.id]);
  await expect(org.requestProposalChanges(revised.id,revised.action_hash,'Too late')).rejects.toThrow('already decided');
 }finally{await db.close();}
});
