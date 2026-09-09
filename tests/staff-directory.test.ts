import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization} from '../packages/runtime/src/index.js';
import {internalRead} from '../packages/runtime/src/internal-reads.js';
it('discovers active collaborators with workload metadata and no private assignment contents',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));await db.query("INSERT INTO employees(id,name,role,department_id,manager_id,depth,charter,model_id) SELECT 'staff-'||lpad(n::text,2,'0'),'Analyst '||n,'Analyst',department_id,id,1,'Fixture charter',model_id FROM employees CROSS JOIN generate_series(1,25) n WHERE id=$1",[ceo.id]);await service.createTask({objective:'Private owner discussion contents',employeeId:'staff-01'});
 const read=(target:string,before:string|null=null)=>db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'STAFF_FIND',target,before}));const first=await read('Analyst') as any,second=await read('Analyst',first.nextBefore) as any;expect(first.employees).toHaveLength(20);expect(second.employees).toHaveLength(5);expect(second.nextBefore).toBeNull();expect(first.employees[0]).toMatchObject({id:'staff-01',active_assignments:1});expect(JSON.stringify(first)).not.toContain('Private owner');expect(first.employees[0]).not.toHaveProperty('charter');expect(new Set([...first.employees,...second.employees].map(e=>e.id)).size).toBe(25);
 const blocked=await service.createTask({objective:'Private blocked task',employeeId:'staff-01'});
 await db.query("UPDATE tasks SET status='BLOCKED_APPROVAL' WHERE id=$1",[blocked.id]);
 const cancelled=await service.createTask({objective:'Old cancelled work',employeeId:'staff-01'});
 await db.query("UPDATE tasks SET status='CANCELLED' WHERE id=$1",[cancelled.id]);
 await db.query("INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,token_reserved,budget_day) VALUES('active-call',$1,'WORK',1,'mock-worker','mock',false,'DISPATCHED',0,100,current_date),('uncertain-call',$2,'WORK',1,'mock-worker','mock',false,'UNCERTAIN',0,100,current_date)",[blocked.id,cancelled.id]);
 const detailed=await read('staff-01') as any;
 expect(detailed.employees[0]).toMatchObject({active_assignments:2,blocked_assignments:1,active_calls:1,uncertain_calls:1,unresolved_calls:2,awaiting_operation_processing:0});
 expect(JSON.stringify(detailed)).not.toContain('Private blocked task');
 expect((await read('staff-02') as any).employees[0]).toMatchObject({active_assignments:0,blocked_assignments:0,active_calls:0,uncertain_calls:0,unresolved_calls:0});
 await expect(db.transaction(tx=>internalRead(tx,service,'outsider',{type:'STAFF_FIND',target:'*'}))).rejects.toThrow('active employee');expect((await read('%') as any).employees).toHaveLength(0);
 }finally{await db.close();}
});
