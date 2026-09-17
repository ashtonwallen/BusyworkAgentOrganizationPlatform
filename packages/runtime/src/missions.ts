import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {parseUsd} from '@hive/core';
import {event,one,type Tx,type Row} from './db.js';
import {DomainError,type HiveService} from './service.js';

export const capabilityFamily=z.enum(['core','documents','research','outreach','commerce','accounting','code','deployment']);
const department=z.object({id:z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),name:z.string().trim().min(1).max(100),purpose:z.string().trim().min(1).max(1000)}).strict();
const definition=z.array(z.string().trim().min(1).max(1000)).max(20);
export const missionTemplates=z.array(z.object({id:z.string(),name:z.string(),kind:z.enum(['FINITE','ONGOING']),objective:z.string(),definitionOfDone:definition,
 capabilities:z.array(capabilityFamily),departments:z.array(department),deliverable:z.string()}).strict()).parse(
 JSON.parse(readFileSync(new URL('../../../config/mission-templates.example.json',import.meta.url),'utf8')));
export const missionInput=z.object({template:z.string(),title:z.string().trim().min(1).max(250),objective:z.string().trim().min(1).max(12000),
 definitionOfDone:definition,boundaries:z.string().trim().max(12000).default(''),kind:z.enum(['FINITE','ONGOING']),
 budgetUsd:z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable(),deadline:z.iso.datetime().nullable().default(null),
 capabilities:z.array(capabilityFamily).min(1),deliverable:z.string().trim().min(1).max(2000),stallCycles:z.number().int().min(1).max(100).default(5)
}).strict().refine(value=>value.kind==='ONGOING'||value.definitionOfDone.length>0,'Finite missions need observable completion conditions.')
 .refine(value=>value.capabilities.includes('core'),'Core organization and communication must remain enabled.')
 .refine(value=>value.kind!=='FINITE'||value.capabilities.includes('documents'),'Finite missions require documents for their durable completion deliverable.');

export async function currentMission(tx:Pick<Tx,'query'>){
 return (await tx.query<Row>("SELECT * FROM missions WHERE status IN ('ACTIVE','COMPLETING') LIMIT 1")).rows[0]??null;
}
export async function taskMission(tx:Pick<Tx,'query'>,task:Row){
 return task.mission_id?(await tx.query<Row>('SELECT * FROM missions WHERE id=$1',[task.mission_id])).rows[0]:null;
}
export function missionContext(mission:Row|null){return mission?{id:mission.id,objective:mission.objective,definitionOfDone:mission.definition_of_done,
 boundaries:mission.boundaries,kind:mission.kind,budgetMicroUsd:mission.budget,deadline:mission.deadline,capabilities:mission.capabilities,
 deliverable:mission.deliverable,status:mission.status,template:mission.template}:null;}

export async function createMission(service:HiveService,raw:unknown){
 const input=missionInput.parse(raw);const template=missionTemplates.find(t=>t.id===input.template);
 if(!template)throw new DomainError('Select an available mission template.');
 return service.db.transaction(async tx=>{
  await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');const id=randomUUID();
  await tx.query(`INSERT INTO missions(id,template,title,objective,definition_of_done,boundaries,kind,budget,deadline,capabilities,deliverable,status,stall_cycles,onboarding_completed)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DRAFT',$12,true)`,[id,input.template,input.title,input.objective,JSON.stringify(input.definitionOfDone),input.boundaries,input.kind,
    input.budgetUsd===null?null:parseUsd(input.budgetUsd).toString(),input.deadline,JSON.stringify([...new Set(input.capabilities)]),input.deliverable,input.stallCycles]);
  await event(tx,'mission.created',id,{template:input.template},'owner');return {id};
 });
}
export async function activateMission(service:HiveService,id:string){
 return service.db.transaction(async tx=>{
  const company=await one(tx,'SELECT * FROM company WHERE id=1 FOR UPDATE');
  if(company.status!=='PAUSED')throw new DomainError('Pause the team before activating a mission.');
  const mission=await one(tx,'SELECT * FROM missions WHERE id=$1 FOR UPDATE',[id]);
  if(mission.status==='ACTIVE')return;
  if(mission.status!=='DRAFT')throw new DomainError('Only a draft mission can be activated.');
  const active=await currentMission(tx);
  if(active){
   const work=await one(tx,'SELECT count(*)::integer AS count FROM tasks WHERE mission_id=$1',[active.id]);
   if(active.onboarding_completed||work.count)throw new DomainError('Finish or stop the active mission first.');
   await tx.query("UPDATE missions SET status='STOPPED',revision=revision+1 WHERE id=$1",[active.id]);
  }
  const template=missionTemplates.find(t=>t.id===mission.template)!;
  await tx.query("DELETE FROM departments WHERE id<>'executive' AND NOT EXISTS(SELECT 1 FROM employees WHERE department_id=departments.id)");
  for(const d of template.departments)await tx.query('INSERT INTO departments(id,name,purpose) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[d.id,d.name,d.purpose]);
  await tx.query("UPDATE missions SET status='ACTIVE',revision=revision+1 WHERE id=$1",[id]);
  await event(tx,'mission.activated',id,{},'owner');
 });
}
export async function proposeDepartment(tx:Tx,task:Row,input:{title:string;instructions:string}){
 const employee=await one(tx,"SELECT role FROM employees WHERE id=$1 AND status='ACTIVE'",[task.employee_id]);
 if(employee.role!=='CEO')throw new DomainError('Only the CEO can propose a department.');
 const id=randomUUID();await tx.query('INSERT INTO owner_requests(id,title,details,mission_id) VALUES($1,$2,$3,$4)',
  [id,'New department: '+input.title,JSON.stringify({kind:'DEPARTMENT',name:input.title,purpose:input.instructions,taskId:task.id}),task.mission_id]);
 await event(tx,'department.proposed',id,{missionId:task.mission_id,name:input.title},task.employee_id);return {id};
}
export async function approveDepartment(service:HiveService,id:string){
 return service.db.transaction(async tx=>{
  const company=await one(tx,'SELECT * FROM company WHERE id=1 FOR UPDATE');
  const request=await one(tx,"SELECT * FROM owner_requests WHERE id=$1 AND status='OPEN'",[id]);
  let value;try{value=JSON.parse(request.details);}catch{throw new DomainError('Not a department proposal.');}
  if(value.kind!=='DEPARTMENT')throw new DomainError('Not a department proposal.');
  const count=await one(tx,'SELECT count(*)::integer AS count FROM departments');
  if(count.count>=company.max_agents)throw new DomainError('Department count cannot exceed the configured headcount limit.');
  await tx.query('INSERT INTO departments(id,name,purpose) VALUES($1,$2,$3)',[id,value.name,value.purpose]);
  await tx.query("UPDATE owner_requests SET status='DONE',response='Department approved by owner.' WHERE id=$1",[id]);
  await event(tx,'department.created',id,{missionId:request.mission_id},'owner');
 });
}
