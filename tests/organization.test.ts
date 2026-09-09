import { beforeEach,afterEach,it,expect } from "vitest";
import { openDatabase,HiveService,Worker,Organization,createModels,one } from "../packages/runtime/src/index.js";
import { MockProvider } from "../packages/providers/src/index.js";
let db:Awaited<ReturnType<typeof openDatabase>>,service:HiveService,org:Organization;
beforeEach(async()=>{db=await openDatabase();service=new HiveService(db,createModels({}));service.candidates=POOL as any;org=new Organization(service);await db.query("UPDATE company SET ceo_model_id='mock-worker',ceo_review_model_id='mock-reviewer',cycle_tokens=300000 WHERE id=1");await service.setStatus('RUNNING');await org.tick();});
afterEach(async()=>{await db.close();});
async function completeCEO(operations:unknown[]){
  const t=await one(db,"SELECT * FROM tasks WHERE role='CEO'");
  const result=await new MockProvider().generate({model:'mock-worker',input:{phase:'WORK'},correlationId:'fixture'});
  await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2,review=$3 WHERE id=$1",[t.id,JSON.stringify({...result.output as object,operations}),JSON.stringify({decision:'PASS',findings:[],nextAction:'Proceed within authority'})]);return t;
}
const hire={type:'HIRE',target:'research',title:'Research lead',instructions:'Evaluate a bounded offer hypothesis; report uncertainty honestly.',budgetUsd:'0.20',tokenBudget:90000,modelId:'mock-worker',participants:[],scheduledAt:null};
async function experimentFixture(){return service.createExperiment({title:'Bounded offer test',hypothesis:'A labelled hypothesis',customer:'Independent contractors',offer:'A bounded service',channel:'Owner-approved outreach',price:'20',maxLossUsd:'1',successCriteria:'A recorded sale',killCriteria:'No demand by deadline',deadline:new Date(Date.now()+86400000).toISOString()});}
it('delivers owner help responses back to the requesting employee',async()=>{
  const t=await completeCEO([{...hire,type:'REQUEST_OWNER',title:'Hosting access',instructions:'Provide the approved hosting choice.',budgetUsd:'0',tokenBudget:100}]);
  await org.applyOperations(t.id);
  const request=await one(db,"SELECT * FROM owner_requests WHERE title='Hosting access'");
  await service.resolveRequest(request.id,'DONE','Use the existing company account; deployment still needs approval.',2);
  const message=await one(db,"SELECT * FROM messages WHERE subject='Answered: Hosting access'");
  expect(message).toMatchObject({sender_id:'owner',recipient_id:t.employee_id,task_id:t.id,kind:'DECISION'});
  expect(message.body).toContain('deployment still needs approval');
  await expect(service.resolveRequest(request.id,'DONE','Duplicate',0)).rejects.toThrow('already resolved');
  expect((await db.query("SELECT id FROM messages WHERE subject='Answered: Hosting access'")).rows).toHaveLength(1);
});
it('applies a reviewed experiment assessment once and preserves its source',async()=>{
  const experiment=await experimentFixture();
  const t=await completeCEO([{...hire,type:'UPDATE_EXPERIMENT',target:experiment.id,title:'VALIDATING',instructions:'Hypothesis still untested; request a bounded validation before committing money.',budgetUsd:'0',tokenBudget:100}]);
  await org.applyOperations(t.id);await org.applyOperations(t.id);
  const row=await one(db,'SELECT * FROM experiments WHERE id=$1',[experiment.id]);
  expect(row.status).toBe('VALIDATING');expect(row.evidence).toHaveLength(1);
  expect(row.evidence[0]).toMatchObject({kind:'AGENT_ASSESSMENT',taskId:t.id,source:t.employee_id});
  expect((await db.query('SELECT id FROM ledger')).rows).toHaveLength(0);
});
it('blocks a claimed delivery when no actual customer revenue is recorded',async()=>{
  const experiment=await experimentFixture();
  await service.recordMoney({kind:'FUNDING',amountUsd:'20',description:'Owner funding is not a sale',externalReference:'funding-fixture',idempotencyKey:'funding-fixture',experimentId:experiment.id});
  const t=await completeCEO([{...hire,type:'UPDATE_EXPERIMENT',target:experiment.id,title:'DELIVERING',budgetUsd:'0',tokenBudget:100}]);
  await org.applyOperations(t.id);
  expect((await one(db,'SELECT status FROM experiments WHERE id=$1',[experiment.id])).status).toBe('DRAFT');
  expect((await one(db,'SELECT status FROM operations WHERE task_id=$1',[t.id])).status).toBe('BLOCKED');
});
it('allows a reviewed delivery decision after a recorded customer receipt',async()=>{
  const experiment=await experimentFixture();
  await service.recordMoney({kind:'REVENUE',amountUsd:'20',description:'Offline customer receipt fixture',externalReference:'sale-fixture',idempotencyKey:'sale-fixture',experimentId:experiment.id});
  const t=await completeCEO([{...hire,type:'UPDATE_EXPERIMENT',target:experiment.id,title:'DELIVERING',budgetUsd:'0',tokenBudget:100}]);
  await org.applyOperations(t.id);
  expect((await one(db,'SELECT status FROM experiments WHERE id=$1',[experiment.id])).status).toBe('DELIVERING');
});
it('does not treat fully refunded revenue as permission to claim delivery',async()=>{
  const experiment=await experimentFixture();
  for(const kind of ['REVENUE','REFUND'] as const)await service.recordMoney({kind,amountUsd:'20',description:'Offline refund fixture',externalReference:kind,idempotencyKey:kind,experimentId:experiment.id});
  const t=await completeCEO([{...hire,type:'UPDATE_EXPERIMENT',target:experiment.id,title:'REPEATING',budgetUsd:'0',tokenBudget:100}]);
  await org.applyOperations(t.id);
  expect((await one(db,'SELECT status FROM experiments WHERE id=$1',[experiment.id])).status).toBe('DRAFT');
});
it('keeps an owner-closed experiment closed when an agent proposes reopening it',async()=>{
  const experiment=await experimentFixture();await service.updateExperiment(experiment.id,'KILLED','Owner stopped the test.');
  const t=await completeCEO([{...hire,type:'UPDATE_EXPERIMENT',target:experiment.id,title:'VALIDATING',budgetUsd:'0',tokenBudget:100}]);
  await org.applyOperations(t.id);
  expect((await one(db,'SELECT status FROM experiments WHERE id=$1',[experiment.id])).status).toBe('KILLED');
});
it.each(['FAILED','EXPIRED'])('automatically replaces a %s cycle at cadence, preserving failure context',async status=>{
 const task=await one(db,"SELECT * FROM tasks WHERE role='CEO'");await db.query('UPDATE tasks SET status=$2,error=$3 WHERE id=$1',[task.id,status,'Reply was cut off.']);
 await org.tick();expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(1);
 service=new HiveService(db,createModels({}),()=>new Date(Date.now()+2*3600000));org=new Organization(service);
 await service.setStatus('PAUSED');await org.tick();expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(1);
 await service.setStatus('RUNNING');await Promise.all([org.tick(),org.tick()]);
 const next=await one(db,'SELECT * FROM tasks WHERE id<>$1',[task.id]);expect(next.objective).toContain('Reply was cut off.');expect(next.objective).toContain('do not repeat');
 expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(2);expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[task.id])).status).toBe(status);
});
it('blocks recovery while a CEO call has unresolved exposure', async () => {
  const task=await one(db,"SELECT * FROM tasks WHERE role='CEO'");
  await db.query("UPDATE tasks SET status='FAILED' WHERE id=$1",[task.id]);
  await db.query("INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,token_reserved,budget_day) VALUES('held',$1,'PLAN',1,'mock-worker','mock',false,'UNCERTAIN',10000,3000,CURRENT_DATE)",[task.id]);
  await expect(org.acknowledgeCycleFailure(task.id,'Try again')).rejects.toThrow('Reconcile unresolved');
  expect((await service.snapshot()).ceoCycle).toMatchObject({unresolved:true,acknowledged:false});
  service=new HiveService(db,createModels({}),()=>new Date(Date.now()+2*3600000));await new Organization(service).tick();expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(1);
});
it('does not carry an acknowledgment across a retry that fails again', async () => {
  const task=await one(db,"SELECT * FROM tasks WHERE role='CEO'");
  await expect(org.acknowledgeCycleFailure(task.id,'Still running')).rejects.toThrow('Only failed');
  await db.query("UPDATE tasks SET status='FAILED' WHERE id=$1",[task.id]);
  await org.acknowledgeCycleFailure(task.id,'Provider repaired');
  await service.retryTask(task.id);
  expect((await one(db,'SELECT finished_at FROM tasks WHERE id=$1',[task.id])).finished_at).toBeNull();
  await db.query("UPDATE tasks SET status='FAILED' WHERE id=$1",[task.id]);
  expect((await service.snapshot()).ceoCycle).toMatchObject({acknowledged:false});
  service=new HiveService(db,createModels({}),()=>new Date(Date.now()+2*3600000));
  await new Organization(service).tick();
  expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(2);
});
it('keeps the owner-selected CEO model when the CEO proposes replacing itself',async()=>{
  const ceo=await one(db,"SELECT * FROM employees WHERE role='CEO'");
  const t=await completeCEO([{...hire,type:'SET_MODEL',target:ceo.id,modelId:'mock-reviewer',instructions:'Evaluate an alternate configured model for the next cycle',budgetUsd:'0',tokenBudget:100}]);await org.applyOperations(t.id);
  expect((await one(db,'SELECT model_id FROM employees WHERE id=$1',[ceo.id])).model_id).toBe('mock-worker');expect((await one(db,'SELECT model_id FROM tasks WHERE id=$1',[t.id])).model_id).toBe('mock-worker');
  const company=await one(db,'SELECT * FROM company WHERE id=1');expect(company.ceo_model_id).toBe('mock-worker');expect(company.approval_policy.expenses).toBe(true);
  expect((await one(db,'SELECT status FROM operations WHERE task_id=$1',[t.id])).status).toBe('BLOCKED');
});
it('does not let a newer completed assignment hide an older unfinished CEO task',async()=>{
  const ceo=await one(db,"SELECT * FROM employees WHERE role='CEO'");
  const extra=await service.createTask({objective:'Separate CEO assignment',employeeId:ceo.id});await db.query("UPDATE tasks SET status='COMPLETED',operations_applied=true WHERE id=$1",[extra.id]);
  service=new HiveService(db,createModels({}),()=>new Date(Date.now()+2*3600000));org=new Organization(service);await org.tick();
  expect((await db.query("SELECT * FROM events WHERE type='company.ceo_cycle_started'")).rows).toHaveLength(1);
});
it('cancels meeting work without deleting its audit trail',async()=>{
  const meeting=await org.meeting({title:'Bounded decision',objective:'Choose a test',participants:['executive'],scheduledAt:new Date(Date.now()+60000).toISOString(),budgetUsd:'0',tokenBudget:120000});
  service=new HiveService(db,createModels({}),()=>new Date(Date.now()+120000));org=new Organization(service);await org.runMeetings();
  await org.cancelMeeting(meeting.id,'Owner reprioritized');await org.cancelMeeting(meeting.id,'Duplicate click');
  expect((await one(db,'SELECT status FROM meetings WHERE id=$1',[meeting.id])).status).toBe('CANCELLED');
  const tasks=await db.query('SELECT status FROM tasks WHERE meeting_id=$1',[meeting.id]);expect(tasks.rows).toHaveLength(2);expect(tasks.rows.every((t:any)=>t.status==='CANCELLED')).toBe(true);
  expect((await db.query("SELECT * FROM events WHERE type='meeting.cancelled' AND entity_id=$1",[meeting.id])).rows).toHaveLength(1);
});
it('CEO hiring creates an employee and bounded child task exactly once',async()=>{
  const t=await completeCEO([hire]);await org.applyOperations(t.id);await org.applyOperations(t.id);
  const staff=(await db.query("SELECT * FROM employees WHERE role='Research lead'")).rows;expect(staff).toHaveLength(1);
  const child=await one(db,'SELECT * FROM tasks WHERE parent_id=$1',[t.id]);expect(child.status).toBe('PLAN_PENDING');expect(BigInt(child.budget)).toBe(200000n);expect(child.employee_id).toBe((staff[0]as any).id);
});
it('headcount limits block hiring without discarding the reviewed artifact',async()=>{
  await db.query('UPDATE company SET max_agents=1 WHERE id=1');const t=await completeCEO([hire]);await org.applyOperations(t.id);
  expect((await db.query('SELECT * FROM employees')).rows).toHaveLength(1);expect((await one(db,'SELECT status FROM operations')).status).toBe('BLOCKED');expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[t.id])).status).toBe('COMPLETED');
});
it('paused company defers operations instead of losing them',async()=>{
  const t=await completeCEO([hire]);await service.setStatus('PAUSED');await org.applyOperations(t.id);expect((await db.query('SELECT * FROM operations')).rows).toHaveLength(0);expect((await one(db,'SELECT operations_applied FROM tasks WHERE id=$1',[t.id])).operations_applied).toBe(false);
  await service.setStatus('RUNNING');await org.applyOperations(t.id);expect((await db.query('SELECT * FROM operations')).rows).toHaveLength(1);
});
it('department meetings gather contributions before a summary and record decisions',async()=>{
  const t=await completeCEO([hire]);await org.applyOperations(t.id);
  const when=new Date(Date.now()+60000).toISOString();const meeting=await org.meeting({title:'Offer decision',objective:'Compare a proposed offer and its cheapest validation',participants:['executive','research'],organizerId:'owner',scheduledAt:when,budgetUsd:'0',tokenBudget:240000});
  service=new HiveService(db,createModels({}),()=>new Date(Date.now()+120000));org=new Organization(service);
  await org.runMeetings();const m=await one(db,'SELECT * FROM meetings WHERE id=$1',[meeting.id]);expect(m.status).toBe('RUNNING');
  const summary=await one(db,'SELECT * FROM tasks WHERE id=$1',[m.task_id]);expect(summary.status).toBe('BLOCKED_APPROVAL');
  const worker=new Worker(service);
  for(let i=0;i<25;i++){await worker.runNext();await org.runMeetings();if((await one(db,'SELECT status FROM meetings WHERE id=$1',[meeting.id])).status==='COMPLETED')break;}
  const completed=await one(db,'SELECT * FROM meetings WHERE id=$1',[meeting.id]);expect(completed.status).toBe('COMPLETED');expect(completed.decisions.title).toBeTruthy();
});
const direction={type:'SET_DIRECTION',target:'company',title:'Sell scheduling relief to independent trades',instructions:'Independent trade contractors lose paid jobs to missed callbacks. Sell a bounded callback service before building any software.',budgetUsd:'0',tokenBudget:100,modelId:'mock-worker',participants:[],scheduledAt:null};
it('lets the CEO set the operating direction and supersedes the previous one',async()=>{
  const first=await completeCEO([direction]);await org.applyOperations(first.id);
  const current=await one(db,'SELECT * FROM directions WHERE superseded_at IS NULL');
  expect(current.headline).toBe(direction.title);
  expect(current.set_by_role).toBe('CEO');
  expect(current.task_id).toBe(first.id);
  await db.query("UPDATE tasks SET operations_applied=false WHERE id=$1",[first.id]);
  await db.query("DELETE FROM operations WHERE task_id=$1",[first.id]);
  const revised={...direction,title:'Sell to property managers instead'};
  await db.query("UPDATE tasks SET artifact=jsonb_set(artifact,'{operations}',$2::jsonb) WHERE id=$1",[first.id,JSON.stringify([revised])]);
  await org.applyOperations(first.id);
  expect((await db.query('SELECT * FROM directions')).rows).toHaveLength(2);
  expect((await one(db,'SELECT headline FROM directions WHERE superseded_at IS NULL')).headline).toBe(revised.title);
  expect((await db.query("SELECT * FROM events WHERE type='company.direction_set'")).rows).toHaveLength(2);
});
it('refuses company direction from anyone but the CEO',async()=>{
  const t=await completeCEO([hire]);await org.applyOperations(t.id);
  const staff=await one(db,"SELECT * FROM employees WHERE role='Research lead'");
  const child=await one(db,'SELECT * FROM tasks WHERE employee_id=$1',[staff.id]);
  const result=await new MockProvider().generate({model:'mock-worker',input:{phase:'WORK'},correlationId:'fixture'});
  await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[child.id,JSON.stringify({...result.output as object,operations:[direction]})]);
  await org.applyOperations(child.id);
  expect((await db.query('SELECT * FROM directions')).rows).toHaveLength(0);
  const blocked=await one(db,"SELECT * FROM operations WHERE task_id=$1",[child.id]);
  expect(blocked.status).toBe('BLOCKED');
  expect(blocked.result.reason).toContain('Only the CEO');
});
it('carries the current direction into the next CEO cycle objective',async()=>{
  const t=await completeCEO([direction]);await org.applyOperations(t.id);
  await db.query("UPDATE tasks SET operations_applied=true WHERE id=$1",[t.id]);
  service=new HiveService(db,createModels({}),()=>new Date(Date.now()+2*3600000));org=new Organization(service);
  await db.query("UPDATE company SET ceo_model_id='mock-worker',ceo_review_model_id='mock-reviewer' WHERE id=1");
  await org.tick();
  const next=await one(db,"SELECT objective FROM tasks WHERE role='CEO' ORDER BY created_at DESC LIMIT 1");
  expect(next.objective).toContain(direction.title);
  expect(next.objective).toContain('SET_DIRECTION');
});
it('lets the owner override the direction the agents chose',async()=>{
  const t=await completeCEO([direction]);await org.applyOperations(t.id);
  await org.ownerSetDirection({headline:'Pause new markets',statement:'Finish the current test before opening another front.'});
  const current=await one(db,'SELECT * FROM directions WHERE superseded_at IS NULL');
  expect(current.set_by).toBe('owner');
  expect(current.set_by_role).toBe('Owner');
  await org.clearDirection();
  expect((await db.query('SELECT * FROM directions WHERE superseded_at IS NULL')).rows).toHaveLength(0);
  expect((await db.query("SELECT * FROM events WHERE type='company.direction_cleared'")).rows).toHaveLength(1);
});
it('measures what a direction produced and puts that record in the next CEO cycle',async()=>{
  const first=await completeCEO([direction]);await org.applyOperations(first.id);
  await db.query("UPDATE tasks SET operations_applied=true WHERE id=$1",[first.id]);
  // Work finished before the direction existed is not evidence for it; only what follows counts.
  expect((await service.snapshot()).direction.scorecard.completedTasks).toBe(0);
  const later=await service.createTask({objective:'Work done under the new direction'});
  await db.query("UPDATE tasks SET status='COMPLETED',operations_applied=true WHERE id=$1",[later.id]);
  await service.recordMoney({kind:'REVENUE',amountUsd:'42.50',description:'Fixture receipt',externalReference:'fixture-scorecard',idempotencyKey:'fixture-scorecard'});
  const snapshot=await service.snapshot();
  expect(snapshot.direction.scorecard.revenueUsd).toBe('42.500000');
  expect(snapshot.direction.scorecard.completedTasks).toBe(1);
  expect(snapshot.direction.headline).toBe(direction.title);
  service=new HiveService(db,createModels({}),()=>new Date(Date.now()+2*3600000));org=new Organization(service);
  await db.query("UPDATE company SET ceo_model_id='mock-worker',ceo_review_model_id='mock-reviewer' WHERE id=1");
  await org.tick();
  const next=await one(db,"SELECT objective FROM tasks WHERE role='CEO' ORDER BY created_at DESC LIMIT 1");
  expect(next.objective).toContain('$42.500000 revenue');
  expect(next.objective).toContain('company-wide period totals');
});
const POOL=[
  {id:'c-rigorous',name:'Bly Okonkwo',archetype:'Analyst',bio:'Careful with numbers.',traits:{caution:4,rigor:5,dissent:3,initiative:2,thrift:4}},
  {id:'c-bold',name:'Ivo Marchetti',archetype:'Outbound seller',bio:'Comfortable being told no.',traits:{caution:2,rigor:3,dissent:3,initiative:5,thrift:3}},
  {id:'c-chief',name:'Arden Whitlock',archetype:'Chief executive',bio:'Picks one bet and funds it small.',traits:{caution:3,rigor:4,dissent:4,initiative:5,thrift:4}},
  {id:'c-thrifty',name:'Thea Lindqvist',archetype:'Finance operator',bio:'Holds the line on burn.',traits:{caution:4,rigor:5,dissent:4,initiative:2,thrift:5}},
  {id:'c-builder',name:'Kes Aldridge',archetype:'Builder',bio:'Ships the smallest useful thing.',traits:{caution:3,rigor:3,dissent:2,initiative:4,thrift:5}},
];
it('hires a named person from the shortlist and writes their temperament into the prompt',async()=>{
  const ceo=await one(db,"SELECT * FROM employees WHERE role='CEO'");
  expect(ceo.name).toBe('Arden Whitlock');
  expect(ceo.candidate_id).toBe('c-chief');
  expect(ceo.traits.initiative).toBe(5);
  const t=await completeCEO([{...hire,candidateId:'c-thrifty'}]);await org.applyOperations(t.id);
  const staff=await one(db,"SELECT * FROM employees WHERE role='Research lead'");
  expect(staff.name).toBe('Thea Lindqvist');
  expect(staff.candidate_id).toBe('c-thrifty');
  expect(staff.bio).toContain('Holds the line');
  expect(staff.traits.thrift).toBe(5);
  const hired=await one(db,"SELECT payload FROM events WHERE type='employee.hired'");
  expect(hired.payload.name).toBe('Thea Lindqvist');
});
it('never hires the same person twice and survives an unknown candidate id',async()=>{
  const ceo=await one(db,"SELECT * FROM employees WHERE role='CEO'");
  const t=await completeCEO([{...hire,candidateId:ceo.candidate_id},{...hire,title:'Second hire',candidateId:'does-not-exist'}]);
  await org.applyOperations(t.id);
  const staff=(await db.query("SELECT * FROM employees WHERE role<>'CEO'")).rows as any[];
  expect(staff).toHaveLength(2);
  const names=new Set([ceo.name,...staff.map(s=>s.name)]);
  expect(names.size).toBe(3); // nobody was cloned
  expect(staff.every(s=>s.candidate_id!==ceo.candidate_id)).toBe(true);
  expect(staff.every(s=>!!s.name&&!!s.traits)).toBe(true);
});
it('hires without a pool rather than blocking the company',async()=>{
  service.candidates=[];
  const t=await completeCEO([hire]);await org.applyOperations(t.id);
  const staff=await one(db,"SELECT * FROM employees WHERE role='Research lead'");
  expect(staff.name).toBeTruthy();
  expect(staff.candidate_id).toMatch(/^generated-/);
  expect(staff.traits).toBeTruthy();
});
it('puts what the company owns in front of every agent and keeps it owner-only',async()=>{
  const {id}=await service.createRecord({kind:'ASSET',title:'example.com on Squarespace',
    body:'The owner controls this domain. You cannot deploy to it; raise REQUEST_OWNER to ask for access.'});
  const snapshot=await service.snapshot();
  expect(snapshot.records).toHaveLength(1);
  expect(snapshot.records[0].kind).toBe('ASSET');
  const ceo=await one(db,"SELECT * FROM employees WHERE role='CEO'");
  const task=await one(db,"SELECT * FROM tasks WHERE employee_id=$1",[ceo.id]);
  const seen=await db.query("SELECT body FROM company_records WHERE NOT archived");
  expect((seen.rows[0] as any).body).toContain('cannot deploy');
  await service.updateRecord(id,{kind:'ASSET',title:'example.com',body:'Now with a landing page the owner published.'});
  expect((await one(db,'SELECT title,body FROM company_records WHERE id=$1',[id])).body).toContain('landing page');
  await service.archiveRecord(id);
  expect((await service.snapshot()).records).toHaveLength(0);
  expect((await db.query("SELECT * FROM events WHERE type LIKE 'company.record%'")).rows).toHaveLength(3);
  expect(task).toBeTruthy();
});

it('requires a full commercial brief to open an experiment while allowing internal work',async()=>{
 const t=await completeCEO([{...hire,type:'CREATE_EXPERIMENT',title:'Incomplete draft'},{...hire,type:'REQUEST_OWNER',title:'Clarify the intended buyer'}]);
 await db.query("UPDATE tasks SET artifact=artifact-'customer'-'offer' WHERE id=$1",[t.id]);
 await org.applyOperations(t.id);
 expect((await db.query('SELECT id FROM experiments')).rows).toHaveLength(0);
 const blocked=await one(db,"SELECT result FROM operations WHERE task_id=$1 AND operation_index=0",[t.id]);
 expect(blocked.result.reason).toContain('complete commercial brief');expect(blocked.result.reason).toContain('customer');
 expect((await db.query("SELECT id FROM owner_requests WHERE title='Clarify the intended buyer'")).rows).toHaveLength(1);
});
it('opens a complete experiment draft without inventing revenue or executing outside actions',async()=>{
 const t=await completeCEO([{...hire,type:'CREATE_EXPERIMENT',title:'Credible fixture test'}]);
 await org.applyOperations(t.id);await org.applyOperations(t.id);
 const rows=(await db.query('SELECT * FROM experiments')).rows;
 expect(rows).toHaveLength(1);expect(rows[0].status).toBe('DRAFT');expect(rows[0].customer).toContain('merchants');
 expect((await db.query('SELECT id FROM actions')).rows).toHaveLength(0);
 expect((await service.snapshot()).metrics.revenueUsd).toBe('0.000000');
});
it('rejects an expired agent-created experiment deadline',async()=>{
 const t=await completeCEO([{...hire,type:'CREATE_EXPERIMENT',scheduledAt:'2020-01-01T00:00:00.000Z'}]);
 await org.applyOperations(t.id);
 expect((await db.query('SELECT id FROM experiments')).rows).toHaveLength(0);
 expect((await one(db,'SELECT result FROM operations WHERE task_id=$1',[t.id])).result.reason).toContain('future');
});

it('binds agent research proposals to an existing experiment',async()=>{
 const experiment=await experimentFixture();
 const task=await completeCEO([{...hire,type:'READ_PUBLIC_PAGE',target:'https://example.com',experimentId:experiment.id,budgetUsd:'0'}]);
 await org.applyOperations(task.id);
 const action=await one(db,'SELECT * FROM actions WHERE task_id=$1',[task.id]);
 expect(action.experiment_id).toBe(experiment.id);expect(action.status).toBe('PENDING');
 await expect(db.query('UPDATE actions SET experiment_id=NULL WHERE id=$1',[action.id])).rejects.toThrow('immutable');
});
it('rejects new agent research for missing or closed experiments',async()=>{
 const experiment=await experimentFixture();await service.updateExperiment(experiment.id,'KILLED','Stop the experiment.');
 const task=await completeCEO(['missing',experiment.id].map(experimentId=>({...hire,type:'READ_PUBLIC_PAGE',target:'https://example.com',experimentId,budgetUsd:'0'})));
 await org.applyOperations(task.id);
 expect((await db.query('SELECT * FROM actions')).rows).toHaveLength(0);
 expect((await db.query("SELECT * FROM operations WHERE task_id=$1 AND status='BLOCKED'",[task.id])).rows).toHaveLength(2);
});

it('preserves the actual category and exact draft of agent external proposals',async()=>{
 const kinds=['PURCHASE','SEND_MESSAGE','PUBLISH','CREATE_ACCOUNT','OTHER_EXTERNAL'];
 const task=await completeCEO(kinds.map(externalActionType=>({...hire,type:'PROPOSE_EXTERNAL',externalActionType,target:'Exact intended destination',instructions:'Exact proposed draft and terms. Nothing has been sent.',budgetUsd:'0'})));
 await org.applyOperations(task.id);
 const actions=(await db.query<any>('SELECT action_type,status,payload FROM actions WHERE task_id=$1',[task.id])).rows;
 expect(actions.map(a=>a.action_type).sort()).toEqual([...kinds].sort());
 expect(actions.every(a=>a.status==='PENDING' && a.payload.description==='Exact proposed draft and terms. Nothing has been sent.')).toBe(true);
 expect((await db.query('SELECT id FROM ledger')).rows).toHaveLength(0);
});

it('continues completed work immediately but honors an explicit WAIT interval',async()=>{
 const t=await completeCEO([]);await org.tick();expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(2);
 const next=await one(db,'SELECT * FROM tasks WHERE id<>$1',[t.id]);
 await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2,operations_applied=true WHERE id=$1",[next.id,JSON.stringify({operations:[{type:'WAIT'}]})]);
 await org.tick();expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(2);
});

it('wakes an explicitly waiting CEO when an owner reply arrives',async()=>{
 const t=await completeCEO([]);await db.query("UPDATE tasks SET artifact=$2,operations_applied=true,finished_at=$3 WHERE id=$1",[t.id,JSON.stringify({operations:[{type:'WAIT'}]}),new Date(Date.now()-1000)]);
 await org.tick();expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(1);
 const request=await service.createRequest({title:'Fixture dependency',details:'A decision is needed for this action only.'});await service.resolveRequest(request.id,'DONE','Approved plan details; continue.',0);
 await org.tick();expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(2);
});

it('wakes a waiting CEO when another assignment completes',async()=>{
 const t=await completeCEO([]);await db.query("UPDATE tasks SET artifact=$2,operations_applied=true,finished_at=$3 WHERE id=$1",[t.id,JSON.stringify({operations:[{type:'WAIT'}]}),new Date(Date.now()-1000)]);
 await org.tick();expect((await db.query('SELECT id FROM tasks')).rows).toHaveLength(1);
 const child=await service.createTask({objective:'Independent evidence summary',role:'Research',modelId:'mock-worker'});await db.query("UPDATE tasks SET status='COMPLETED',operations_applied=true WHERE id=$1",[child.id]);
 await org.tick();expect((await db.query("SELECT id FROM tasks WHERE role='CEO'")).rows).toHaveLength(2);
});

it('binds browser rendering into a new reviewed research proposal without executing it',async()=>{
 service.browserAvailable=true;
 const task=await completeCEO([{...hire,type:'READ_BROWSER_PAGE',target:'https://example.test/offer',title:'Read offer',instructions:'Inspect rendered text and links.',budgetUsd:'0'}]);
 await org.applyOperations(task.id);await org.applyOperations(task.id);
 const actions=(await db.query("SELECT * FROM actions WHERE task_id=$1",[task.id])).rows as any[];
 expect(actions).toHaveLength(1);expect(actions[0]).toMatchObject({action_type:'READ_PUBLIC_PAGE',status:'PENDING',payload:{renderer:'browser',proposedBy:task.employee_id}});
 expect((await db.query("SELECT sequence FROM events WHERE type='tool.dispatched'")).rows).toHaveLength(0);
});
