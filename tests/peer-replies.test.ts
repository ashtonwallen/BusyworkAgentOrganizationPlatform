import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization,Worker,one,consultations} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
it('schedules an employee consultation and returns exactly one checked answer using the recipient model',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service);const ceo=await db.transaction(tx=>org.ensureCEO(tx));
 await db.query("INSERT INTO employees(id,name,role,department_id,depth,charter,model_id) VALUES('peer','Peer','Analyst','executive',0,'Consult colleagues','mock-reviewer')");
 const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);adapter.generate=async request=>{const result=await generate(request);if((request.input as any).phase==='WORK')(result.output as any).operations=[{type:'REQUEST_REPLY',target:'peer',title:'Assess evidence gap',instructions:'What evidence is missing?',budgetUsd:'0',tokenBudget:150000,modelId:'nonexistent-ignored',participants:[],scheduledAt:null}];return result;};service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
 const source=await service.createTask({objective:'Consult another employee',employeeId:ceo.id,modelId:'mock-worker',tokenBudget:150000});await service.setStatus('RUNNING');const worker=new Worker(service);for(let i=0;i<3;i++)await worker.runNext();await org.applyOperations(source.id);await org.applyOperations(source.id);
 const child=await one(db,'SELECT * FROM tasks WHERE parent_id=$1',[source.id]);expect(child.employee_id).toBe('peer');expect(child.model_id).toBe('mock-reviewer');expect(child.review_model_id).toBeNull();
 expect((await consultations(db,ceo.id)).items[0]).toMatchObject({task_id:child.id,response_status:'PENDING',employee_id:'peer'});expect((await consultations(db,'peer')).items).toHaveLength(1);expect((await service.snapshot()).consultations.items).toHaveLength(1);
 await expect(consultations(db,'stranger')).rejects.toThrow('active employee');
 await db.query("UPDATE tasks SET status='FAILED',error='Fixture context problem' WHERE id=$1",[child.id]);
 await service.setStatus('PAUSED');await org.notifyConsultationOutcomes();await org.notifyConsultationOutcomes();
 expect((await consultations(db,ceo.id)).items).toHaveLength(0);expect((await consultations(db,ceo.id,'all')).items[0].response_status).toBe('UNANSWERED');
 const notices=(await db.query("SELECT * FROM messages WHERE task_id=$1 AND subject='Consultation failed'",[child.id])).rows;expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({recipient_id:ceo.id,sender_id:'company'});expect((notices[0] as any).body).toContain('No checked answer was delivered');
 await db.query("UPDATE tasks SET status='PLAN_PENDING',error=NULL WHERE id=$1",[child.id]);
 expect(await worker.runNext()).toBe(false);await service.setStatus('RUNNING');for(let i=0;i<3;i++)await worker.runNext();await org.applyOperations(child.id);await org.applyOperations(child.id);
 const completed=await one(db,'SELECT * FROM tasks WHERE id=$1',[child.id]);expect(completed.status).toBe('COMPLETED');expect(completed.artifact).not.toHaveProperty('customer');
 const replies=(await db.query('SELECT * FROM messages WHERE id=$1',[`reply:${child.id}`])).rows;expect(replies).toHaveLength(1);expect((await consultations(db,ceo.id,'all')).items[0]).toMatchObject({response_status:'DELIVERED',reply_message_id:'reply:'+child.id});expect((await consultations(db,'owner')).items).toHaveLength(0);expect(replies[0]).toMatchObject({sender_id:'peer',recipient_id:ceo.id,body:completed.artifact.summary});expect((await db.query("SELECT id FROM messages WHERE recipient_id='owner'")).rows).toHaveLength(0);
 }finally{await db.close();}
});

it('pages owner consultation history while keeping unrelated employee correspondence private',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
 await db.query("INSERT INTO employees(id,name,role,department_id,depth,charter,model_id) VALUES('peer','Peer','Analyst','executive',0,'Consult','mock-worker'),('other','Other','Analyst','executive',0,'Consult','mock-worker')");
 for(let i=0;i<23;i++){const task=await service.createTask({objective:'Consultation '+i,employeeId:'peer'});await db.query("INSERT INTO events(type,entity_id,actor,payload) VALUES('peer.reply_requested',$1,$2,$3)",[task.id,ceo.id,JSON.stringify({requesterId:ceo.id,employeeId:'peer'})]);}
 const first=await consultations(db,'owner','all'),second=await consultations(db,'owner','all',first.nextBefore);expect(first.items).toHaveLength(20);expect(second.items).toHaveLength(3);expect(second.nextBefore).toBeNull();expect(new Set([...first.items,...second.items].map(r=>r.task_id)).size).toBe(23);expect((await consultations(db,'other','all')).items).toHaveLength(0);
 }finally{await db.close();}
});
