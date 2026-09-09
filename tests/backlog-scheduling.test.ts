import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {openDatabase,HiveService,createModels,Organization,saveBacklog,startBacklog,one} from '../packages/runtime/src/index.js';
import {scheduleBacklog,backlogScheduleStatus,pendingBacklogStarts,runBacklogSchedules} from '../packages/runtime/src/backlog-scheduling.js';
it('starts versioned work once after due time and prerequisites, preserving source bounds and pause',async()=>{
 const db=await openDatabase();try{
 let now=new Date();const service=new HiveService(db,createModels({}),()=>now),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
 const sourceId=(await service.createTask({objective:'Plan a workflow',employeeId:ceo.id,ttlMinutes:120})).id;
 const source=await one(db,'SELECT * FROM tasks WHERE id=$1',[sourceId]);
 const a=randomUUID(),b=randomUUID(),input={title:'Prepare',instructions:'Create intake.',successCriteria:'Checked intake.',employeeId:ceo.id,expectedVersion:0};
 await db.transaction(tx=>saveBacklog(tx,a,input,'owner'));await db.transaction(tx=>saveBacklog(tx,b,{...input,title:'Package',dependsOn:[a]},'owner'));
 const due=new Date(now.getTime()+600000).toISOString();const id=await db.transaction(tx=>scheduleBacklog(tx,source,b,1,due,now));expect(await db.transaction(tx=>scheduleBacklog(tx,source,b,1,due,now))).toBe(id);
 await db.query("UPDATE tasks SET status='COMPLETED',operations_applied=true WHERE id=$1",[sourceId]);
 expect((await service.snapshot()).backlogSchedules[0].state).toBe('PAUSED');
 await runBacklogSchedules(service);expect(await pendingBacklogStarts(db)).toHaveLength(1);
 await service.setStatus('RUNNING');expect((await db.transaction(tx=>backlogScheduleStatus(tx,service)))[0].state).toBe('PREREQUISITES');now=new Date(now.getTime()+120000);await runBacklogSchedules(service);expect(await pendingBacklogStarts(db)).toHaveLength(1);
 const prerequisite=await db.transaction(tx=>startBacklog(tx,service,a,'owner'));await db.query("UPDATE tasks SET status='COMPLETED',operations_applied=false WHERE id=$1",[prerequisite.id]);await runBacklogSchedules(service);expect(await pendingBacklogStarts(db)).toHaveLength(1);
 await db.query('UPDATE tasks SET operations_applied=true WHERE id=$1',[prerequisite.id]);expect((await db.transaction(tx=>backlogScheduleStatus(tx,service)))[0].state).toBe('SCHEDULED_TIME');await runBacklogSchedules(service);expect(await pendingBacklogStarts(db)).toHaveLength(1);now=new Date(now.getTime()+600000);await Promise.all([runBacklogSchedules(service),runBacklogSchedules(service)]);
 expect(await pendingBacklogStarts(db)).toHaveLength(0);expect((await db.query("SELECT id FROM messages WHERE subject='Scheduled work assigned'")).rows).toHaveLength(1);const started=await one(db,"SELECT payload FROM events WHERE entity_id=$1 AND type='backlog.schedule_started'",[id]);const task=await one(db,'SELECT * FROM tasks WHERE id=$1',[started.payload.taskId]);expect(task.parent_id).toBe(sourceId);expect(task.expires_at).toEqual(source.expires_at);expect(task.depth).toBe(source.depth+1);expect((await db.query('SELECT * FROM calls')).rows).toHaveLength(0);
 await db.query("UPDATE tasks SET status='FAILED' WHERE id=$1",[task.id]);await runBacklogSchedules(service);expect((await db.query("SELECT * FROM events WHERE entity_id=$1 AND type='backlog.schedule_started'",[id])).rows).toHaveLength(1);
 }finally{await db.close();}
});
it('cancels stale plans and expired sources with one internal notice and rejects unrelated assignments',async()=>{
 const db=await openDatabase();try{
 let now=new Date();const service=new HiveService(db,createModels({}),()=>now),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
 const sourceId=(await service.createTask({objective:'Schedule useful work',employeeId:ceo.id,ttlMinutes:120})).id,source=await one(db,'SELECT * FROM tasks WHERE id=$1',[sourceId]);
 const a=randomUUID(),input={title:'Prepare',instructions:'Create intake.',successCriteria:'Checked intake.',employeeId:ceo.id,expectedVersion:0};await db.transaction(tx=>saveBacklog(tx,a,input,'owner'));
 await db.query("INSERT INTO employees(id,name,role,department_id,depth,charter,model_id) VALUES('unrelated','Other','Analyst','executive',0,'Fixture','mock-worker')");
 const unrelated=randomUUID();await db.transaction(tx=>saveBacklog(tx,unrelated,{...input,employeeId:'unrelated'},'owner'));await expect(db.transaction(tx=>scheduleBacklog(tx,source,unrelated,1,null,now))).rejects.toThrow('reporting chain');
 await expect(db.transaction(tx=>scheduleBacklog(tx,source,a,0,null,now))).rejects.toThrow('latest backlog');
 await db.transaction(tx=>scheduleBacklog(tx,source,a,1,null,now));await db.transaction(tx=>saveBacklog(tx,a,{...input,title:'Changed work',expectedVersion:1},'owner'));await service.setStatus('RUNNING');await runBacklogSchedules(service);await runBacklogSchedules(service);expect(await pendingBacklogStarts(db)).toHaveLength(0);
 expect((await db.query("SELECT * FROM messages WHERE subject='Scheduled work cancelled'")).rows).toHaveLength(1);
 await db.transaction(tx=>scheduleBacklog(tx,source,a,2,null,now));now=new Date(now.getTime()+3*3600000);await runBacklogSchedules(service);expect(await pendingBacklogStarts(db)).toHaveLength(0);expect((await db.query("SELECT * FROM messages WHERE subject='Scheduled work cancelled'")).rows).toHaveLength(2);
 }finally{await db.close();}
});
