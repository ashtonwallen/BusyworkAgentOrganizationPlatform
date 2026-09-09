import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,one} from '../packages/runtime/src/index.js';
import {scheduleFollowUp,runFollowUps,pendingFollowUps,cancelFollowUp} from '../packages/runtime/src/follow-ups.js';
import {MockProvider} from '../packages/providers/src/index.js';

it('persists follow-ups without blocking independent work, starts once on current model, and respects pause, completion processing and deadlines',async()=>{
 const db=await openDatabase();let now=new Date('2026-09-09T00:00:00Z');try{
  const service=new HiveService(db,createModels({}),()=>now),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
  const source=await service.createTask({objective:'Manage delegated work',employeeId:ceo.id,ttlMinutes:60});
  const dependency=await service.createTask({objective:'Prepare deliverable',employeeId:ceo.id,ttlMinutes:60});
  await db.query("UPDATE tasks SET status='COMPLETED',operations_applied=true WHERE id=$1",[source.id]);
  const sourceRow=await one(db,'SELECT * FROM tasks WHERE id=$1',[source.id]);
  const schedule=()=>db.transaction(tx=>scheduleFollowUp(tx,sourceRow,dependency.id,'Inspect the delivered result.','Review deliverable','0',60000));
  const id=await schedule();expect(await schedule()).toBe(id);expect(await pendingFollowUps(db)).toHaveLength(1);expect((await service.snapshot()).followUps).toHaveLength(1);
  await runFollowUps(service);expect((await db.query("SELECT sequence FROM events WHERE type='followup.started'")).rows).toHaveLength(0);
  await service.setStatus('RUNNING');await db.query("UPDATE tasks SET status='COMPLETED',operations_applied=false WHERE id=$1",[dependency.id]);await runFollowUps(service);expect(await pendingFollowUps(db)).toHaveLength(1);
  await db.query("UPDATE tasks SET operations_applied=true WHERE id=$1",[dependency.id]);await db.query("UPDATE company SET ceo_model_id='mock-reviewer'");
  const restarted=new HiveService(db,createModels({}),()=>now);await runFollowUps(restarted);await runFollowUps(restarted);
  const started=(await db.query("SELECT payload FROM events WHERE type='followup.started'")).rows;expect(started).toHaveLength(1);
  const task=await one(db,'SELECT * FROM tasks WHERE id=$1',[started[0]!.payload.taskId]);expect(task).toMatchObject({model_id:'mock-reviewer',parent_id:source.id,root_id:sourceRow.root_id,review_model_id:null,employee_id:ceo.id,status:'PLAN_PENDING'});expect(task.objective).toContain('does not authorize external');expect(await pendingFollowUps(db)).toHaveLength(0);
  const second=await schedule();await runFollowUps(restarted);expect(await pendingFollowUps(db)).toHaveLength(1);
  await expect(db.transaction(tx=>cancelFollowUp(tx,second,'another-employee','No'))).rejects.toThrow('responsible');
  await db.transaction(tx=>cancelFollowUp(tx,second,'owner','No further review needed.'));expect(await pendingFollowUps(db)).toHaveLength(0);
  await schedule();now=new Date('2026-09-09T02:00:00Z');await runFollowUps(restarted);expect(await pendingFollowUps(db)).toHaveLength(0);expect((await db.query("SELECT id FROM messages WHERE subject='Follow-up cancelled'")).rows).toHaveLength(1);
 }finally{await db.close();}
});

it('applies reviewed follow-up operations once and schedules inspection of a failed prerequisite',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
  const source=await service.createTask({objective:'Arrange follow-up',employeeId:ceo.id});const dependency=await service.createTask({objective:'Delegated analysis',employeeId:ceo.id});
  const result=await new MockProvider().generate({input:{phase:'WORK'}} as any);
  (result.output as any).operations=[{type:'FOLLOW_UP',target:dependency.id,title:'Assess results',instructions:'Inspect results and decide next steps.',budgetUsd:'0',tokenBudget:60000,modelId:'mock-worker',participants:[],scheduledAt:null}];
  await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[source.id,JSON.stringify(result.output)]);
  await db.query("UPDATE tasks SET status='FAILED',error='Fixture failure' WHERE id=$1",[dependency.id]);
  await service.setStatus('RUNNING');await org.applyOperations(source.id);await org.applyOperations(source.id);expect(await pendingFollowUps(db)).toHaveLength(1);
  await org.tick();await org.tick();
  const events=(await db.query("SELECT payload FROM events WHERE type='followup.started'")).rows;expect(events).toHaveLength(1);expect(events[0]!.payload.dependencyStatus).toBe('FAILED');
  const task=await one(db,'SELECT * FROM tasks WHERE id=$1',[events[0]!.payload.taskId]);expect(task.objective).toContain('No completed result is guaranteed');expect(task.employee_id).toBe(ceo.id);
 }finally{await db.close();}
});

