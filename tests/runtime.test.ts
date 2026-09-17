import { afterEach,beforeEach,describe,expect,it } from "vitest";
import { openDatabase,HiveService,Worker,Organization,createModels,one,shortlist } from "../packages/runtime/src/index.js";
import { MockProvider, ProviderFailure } from "../packages/providers/src/index.js";
import type { RuntimeModel } from "../packages/runtime/src/models.js";
import { buildApp } from "../apps/api/src/app.js";

let db:Awaited<ReturnType<typeof openDatabase>>,service:HiveService,worker:Worker;
beforeEach(async()=>{db=await openDatabase();service=new HiveService(db,createModels({}));worker=new Worker(service);});
afterEach(async()=>{await worker.stop();await db.close();});
const create=(extra={})=>service.createTask({objective:"Draft a focused data cleanup offer hypothesis.",modelId:"mock-worker",reviewModelId:"mock-reviewer",...extra});

describe("Working temperament",()=>{
  it("puts the agent's own temperament in the system prompt, not the shared context",async()=>{
    let captured:any;
    const spy={providerId:'lmstudio',async listModels(){return[];},async generate(request:any){
      captured=request;
      return {output:{understanding:'x',steps:['a'],estimatedCostUsd:'0',toolsNeeded:[],successCheck:'ok'},
        usage:{inputTokens:10,outputTokens:10,actualCostUsd:'0'},rawModelId:request.model,providerRequestId:'spy',latencyMs:1};
    }};
    const model:RuntimeModel={id:'spy',name:'Spy',provider:'lmstudio',model:'spy',family:'local',ready:true,live:false,
      inputPerMillionUsd:'0',outputPerMillionUsd:'0',maxInputTokens:20000,maxOutputTokens:3000,adapter:spy as any};
    service=new HiveService(db,[...createModels({}),model]);
    service.candidates=[{id:'c-1',name:'Bly Okonkwo',archetype:'Analyst',bio:'Careful with numbers.',
      traits:{caution:4,rigor:5,dissent:3,initiative:2,thrift:4}}] as any;
    worker=new Worker(service);
    const org=new Organization(service);
    await db.query("UPDATE company SET ceo_model_id='spy',ceo_review_model_id='spy' WHERE id=1");
    await service.setStatus('RUNNING');
    await org.tick();
    await worker.runNext();
    expect(captured.system).toContain('You are Bly Okonkwo');
    expect(captured.system).toContain('Careful with numbers');
    expect(captured.system).toContain('You state nothing as fact without a source'); // rigor 5
    expect(captured.system).toContain('You do what you were asked'); // initiative 2
    expect(captured.system).not.toContain('rigor: 5'); // behaviour, not a stat block
    expect(JSON.stringify(captured.input)).not.toContain('You are Bly Okonkwo');
  });

  it.each([true,false])("hands agents company assets and current model-call approval policy (%s)",async(modelCalls)=>{
    let captured:any;
    const spy={providerId:'lmstudio',async listModels(){return[];},async generate(request:any){
      captured=request;
      return {output:{understanding:'x',steps:['a'],estimatedCostUsd:'0',toolsNeeded:[],successCheck:'ok'},
        usage:{inputTokens:10,outputTokens:10,actualCostUsd:'0'},rawModelId:request.model,providerRequestId:'spy',latencyMs:1};
    }};
    const model:RuntimeModel={id:'spy',name:'Spy',provider:'lmstudio',model:'spy',family:'local',ready:true,live:false,
      inputPerMillionUsd:'0',outputPerMillionUsd:'0',maxInputTokens:20000,maxOutputTokens:3000,adapter:spy as any};
    service=new HiveService(db,[...createModels({}),model]);worker=new Worker(service);
    await service.createRecord({kind:'ASSET',title:'example.com on Squarespace',
      body:'The owner controls this domain. You cannot deploy to it yourself.'});
    await service.setApprovalPolicy({modelCalls,expenses:true});
    await db.query("UPDATE company SET ceo_model_id='spy',ceo_review_model_id='spy' WHERE id=1");
    await service.setStatus('RUNNING');
    await new Organization(service).tick();
    await worker.runNext();
    expect(JSON.stringify(captured.input.companyRecords)).toContain('example.com');
    expect(captured.system).toContain('do not assume you can use an asset yourself');
    expect(captured.system).toContain('REQUEST_OWNER');
    expect(captured.input.runtimeAuthority.approvalPolicy.modelCalls).toBe(modelCalls);
    expect(captured.input.runtimeAuthority.approvalPolicy.expenses).toBe(true);
    // PLAN intentionally receives the compact planning guide; full operation
    // syntax (including historical document versions) is supplied in WORK/REVIEW.
    expect(captured.input.phase).toBe('PLAN');
    expect(captured.system).toContain('independently of the general expenses switch');
  });

  it("offers a stable shortlist of unhired people when an agent can hire",async()=>{
    const pool=Array.from({length:9},(_,i)=>({id:`c-${i}`,name:`Person ${i}`,archetype:'Generalist',bio:'Bio.',
      traits:{caution:3,rigor:3,dissent:3,initiative:3,thrift:3}}));
    const first=shortlist(pool as any,'task-abc');
    expect(first).toHaveLength(4);
    expect(shortlist(pool as any,'task-abc').map(c=>c.id)).toEqual(first.map(c=>c.id)); // a retry sees the same people
    expect(shortlist(pool as any,'task-xyz').map(c=>c.id)).not.toEqual(first.map(c=>c.id)); // a different hire does not
  });
});

describe("Malformed structured output",()=>{
  /** Emits one unusable plan, then a valid one — the failure mode small local models actually show. */
  class Flaky extends MockProvider {
    calls=0;
    async generate<T=unknown>(request:any):Promise<any>{
      const phase=(request.input as {phase?:string}).phase;
      if(phase==="PLAN"&&this.calls++<1){
        return {output:{understanding:"Something useful",steps:["State the buyer",""],estimatedCostUsd:"0",toolsNeeded:[],successCheck:"ok"} as T,
          usage:{inputTokens:100,outputTokens:120,actualCostUsd:"0"},rawModelId:request.model,providerRequestId:"flaky",latencyMs:1};
      }
      return super.generate<T>(request);
    }
  }
  const flakyModel=(adapter:any):RuntimeModel=>({id:"flaky",name:"Flaky local fixture",provider:"lmstudio",model:"flaky",family:"local",ready:true,live:false,
    inputPerMillionUsd:"0",outputPerMillionUsd:"0",maxInputTokens:20000,maxOutputTokens:3000,adapter});

  it("retries a malformed plan with the exact complaint instead of failing the task",async()=>{
    const adapter=new Flaky();
    service=new HiveService(db,[...createModels({}),flakyModel(adapter)]);worker=new Worker(service);
    const{id}=await service.createTask({objective:"Draft a focused data cleanup offer hypothesis.",modelId:"flaky",reviewModelId:"flaky"});
    await service.setStatus("RUNNING");
    await worker.runNext();
    let t=await one(db,"SELECT * FROM tasks WHERE id=$1",[id]);
    expect(t.status).toBe("PLAN_PENDING");
    expect(t.error).toContain("steps.1");
    expect((await one(db,"SELECT payload FROM events WHERE type='task.invalid_output'")).payload.retrying).toBe(true);
    await worker.runNext();
    t=await one(db,"SELECT * FROM tasks WHERE id=$1",[id]);
    expect(t.status).toBe("READY");expect(t.error).toBeNull();expect(t.plan.steps).toHaveLength(3);
    await worker.runNext();await worker.runNext();
    expect((await one(db,"SELECT status FROM tasks WHERE id=$1",[id])).status).toBe("COMPLETED");
  });

  it('repairs late malformed output and resets its streak after valid work',async()=>{
    const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);let workCalls=0;let reviews=0;
    adapter.generate=async request=>{
      const result=await generate(request);const phase=(request.input as any).phase;
      if(phase==='WORK' && [4,6].includes(++workCalls)) result.output='malformed output';
      if(phase==='REVIEW' && ++reviews<=4) result.output={decision:'REVISE',findings:['Fix the current evidence summary.'],nextAction:'Revise the assignment.'};
      return result;
    };
    service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
    const {id}=await create({tokenBudget:200000});await service.setStatus('RUNNING');
    for(let i=0;i<13;i++)await worker.runNext();
    const failures=(await db.query<any>("SELECT payload FROM events WHERE entity_id=$1 AND type='task.invalid_output' ORDER BY sequence",[id])).rows;
    expect(failures).toHaveLength(2);
    expect(failures.every(e=>e.payload.retrying && e.payload.consecutiveFailures===1)).toBe(true);
    expect(failures[0].payload.attempt).toBeGreaterThan(3);
    expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[id])).status).toBe('COMPLETED');
  });

  it('adapts repeated cut-off replies without failing or enlarging the context window',async()=>{
    const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);const limits:number[]=[];
    adapter.generate=async request=>{
      limits.push(request.maxOutputTokens!);
      const result=await generate(request);
      if(limits.length<=3){result.output='{"partial":';result.truncated=true;}
      return result;
    };
    service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
    const {id}=await create({tokenBudget:200000});await service.setStatus('RUNNING');
    for(let i=0;i<4;i++)await worker.runNext();
    expect(limits).toEqual([3000,3000,6000,12000]);
    expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[id])).status).toBe('READY');
    const calls=(await db.query<any>('SELECT token_reserved FROM calls WHERE task_id=$1',[id])).rows;
    expect(calls.every(c=>Number(c.token_reserved)===33000)).toBe(true);
    expect((await db.query('SELECT id FROM ledger WHERE task_id=$1',[id])).rows).toHaveLength(4);
  });

  it('requires a newly priced approval before dispatching an expanded answer',async()=>{
    const adapter=new MockProvider();adapter.generate=async request=>({output:'partial' as any,truncated:true,usage:{inputTokens:10,outputTokens:100},rawModelId:request.model,latencyMs:1});
    service=new HiveService(db,[...createModels({}),{...flakyModel(adapter),inputPerMillionUsd:'1',outputPerMillionUsd:'2'}]);worker=new Worker(service);
    const{id}=await service.createTask({objective:'Produce a concise analysis.',modelId:'flaky',tokenBudget:200000});await service.setStatus('RUNNING');
    for(let i=0;i<2;i++){
      await worker.runNext();const action=await one(db,"SELECT * FROM actions WHERE task_id=$1 AND status='PENDING'",[id]);
      await service.approveAction(action.id,action.action_hash,'APPROVE','Exact fixture call');await worker.runNext();
    }
    await worker.runNext();
    const proposal=await one(db,"SELECT * FROM actions WHERE task_id=$1 AND status='PENDING'",[id]);
    expect(proposal.payload.request.maxOutputTokens).toBe(6000);expect(BigInt(proposal.max_cost)).toBe(29000n);
    expect((await db.query('SELECT id FROM calls WHERE task_id=$1',[id])).rows).toHaveLength(2);
    expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[id])).status).toBe('BLOCKED_APPROVAL');
  });

  it("fails the task once bounded correction attempts are exhausted",async()=>{
    const always={providerId:"mock",async listModels(){return[];},async generate(request:any){
      return {output:{understanding:"x",steps:[""],estimatedCostUsd:"0",toolsNeeded:[],successCheck:"ok"},
        usage:{inputTokens:10,outputTokens:10,actualCostUsd:"0"},rawModelId:request.model,providerRequestId:"bad",latencyMs:1};
    }};
    service=new HiveService(db,[...createModels({}),flakyModel(always)]);worker=new Worker(service);
    const{id}=await service.createTask({objective:"Draft a focused data cleanup offer hypothesis.",modelId:"flaky",reviewModelId:"flaky"});
    await service.setStatus("RUNNING");
    for(let i=0;i<6;i++)await worker.runNext();
    const t=await one(db,"SELECT * FROM tasks WHERE id=$1",[id]);
    expect(t.status).toBe("FAILED");
    expect(t.error).toContain("bounded retries");
    expect(t.attempts).toBeLessThanOrEqual(4);
  });
});

describe("Durable control plane",()=>{
  it('automatically requeues only live token-estimate blockers and retains other spending blocks',async()=>{
    const eligible=await create({tokenBudget:1000}),money=await create(),cancelled=await create(),expired=await create();
    const error='Task has 2,000 tokens remaining, which cannot fit its required context and an answer. Increase the task token allocation or narrow the objective.';
    await db.query("UPDATE tasks SET status='BLOCKED_BUDGET',error=$1",[error]);
    await db.query("UPDATE tasks SET error='Daily operating cap cannot cover the next maximum call cost.' WHERE id=$1",[money.id]);
    await db.query("UPDATE tasks SET status='CANCELLED' WHERE id=$1",[cancelled.id]);await db.query("UPDATE tasks SET expires_at=now()-interval '1 minute' WHERE id=$1",[expired.id]);
    await service.resumeTokenEstimateBlocks();await service.resumeTokenEstimateBlocks();
    expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[eligible.id])).status).toBe('PLAN_PENDING');
    expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[money.id])).status).toBe('BLOCKED_BUDGET');
    expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[cancelled.id])).status).toBe('CANCELLED');
    expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[expired.id])).status).toBe('BLOCKED_BUDGET');
    expect((await db.query("SELECT sequence FROM events WHERE type='task.token_estimate_unblocked'")).rows).toHaveLength(1);
  });

  it("starts paused with no fabricated cash and mandatory approvals",async()=>{
    const s=await service.snapshot();expect(s.company.status).toBe("PAUSED");expect(s.metrics.availableCapitalUsd).toBe("0.000000");expect(s.company.approval_policy.expenses).toBe(true);expect(s.company.approval_policy.communications).toBe(true);expect(await worker.runNext()).toBe(false);
  });
  it('finishes work with an estimated allocation while reserving bounded calls',async()=>{
    const{id}=await create({tokenBudget:16000});await service.setStatus('RUNNING');
    for(let i=0;i<3;i++)await worker.runNext();
    expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[id])).status).toBe('COMPLETED');
    const calls=(await db.query<any>('SELECT token_reserved FROM calls WHERE task_id=$1',[id])).rows;
    expect(calls).toHaveLength(3);expect(calls.every(c=>Number(c.token_reserved)<=33000)).toBe(true);
    expect(service.models.find(m=>m.id==='mock-worker')!.maxInputTokens).toBe(30000);
  });
  it('continues beyond a small task token estimate without discarding required context',async()=>{
    const{id}=await create({tokenBudget:1000});await service.setStatus('RUNNING');await worker.runNext();
    expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[id])).status).toBe('READY');
    expect((await db.query('SELECT id FROM calls WHERE task_id=$1',[id])).rows).toHaveLength(1);
  });
  it("requires a plan and review before completion and records all usage",async()=>{
    const{id}=await create();await service.setStatus("RUNNING");
    await worker.runNext();let t=await one(db,"SELECT * FROM tasks WHERE id=$1",[id]);expect(t.status).toBe("READY");expect(t.plan.steps.length).toBeGreaterThan(0);expect(t.artifact).toBeNull();
    await worker.runNext();t=await one(db,"SELECT * FROM tasks WHERE id=$1",[id]);expect(t.status).toBe("REVIEW");
    await worker.runNext();t=await one(db,"SELECT * FROM tasks WHERE id=$1",[id]);expect(t.status).toBe("COMPLETED");
    expect((await db.query("SELECT * FROM ledger")).rows).toHaveLength(3);expect(await worker.runNext()).toBe(false);
    expect((await service.snapshot()).metrics.revenueUsd).toBe("0.000000");
  });
  it("cannot create work while killed through a worker call",async()=>{
    await create();await service.setStatus("KILLED");expect(await worker.runNext()).toBe(false);expect((await db.query("SELECT * FROM calls")).rows).toHaveLength(0);
  });
  it("rejects delegated allocations beyond the parent remaining money or tokens",async()=>{
    const{id}=await create({budgetUsd:"1",tokenBudget:100000,ttlMinutes:120});
    await create({parentId:id,budgetUsd:"0.75",tokenBudget:50000,ttlMinutes:60});
    await expect(create({parentId:id,budgetUsd:"2.00",tokenBudget:30000,ttlMinutes:60})).rejects.toThrow("parent remaining");
    await expect(create({parentId:id,budgetUsd:"0.10",tokenBudget:60000,ttlMinutes:60})).rejects.toThrow("parent remaining");
    await expect(create({parentId:id,budgetUsd:"0.25",tokenBudget:50000,ttlMinutes:60})).resolves.toHaveProperty("id");
  });
  it("cancels descendants but preserves existing audit history",async()=>{
    const parent=await create({tokenBudget:100000});const child=await create({parentId:parent.id,budgetUsd:"0.25",ttlMinutes:30,tokenBudget:30000});
    await service.cancelTask(parent.id);expect((await one(db,"SELECT status FROM tasks WHERE id=$1",[child.id])).status).toBe("CANCELLED");
    await expect(db.query("DELETE FROM events")).rejects.toThrow("append-only");await expect(db.query("TRUNCATE ledger")).rejects.toThrow("append-only");
  });
  it("funding is not revenue and duplicate imports are idempotent",async()=>{
    const entry={kind:"FUNDING" as const,amountUsd:"200",description:"Confirmed owner deposit",externalReference:"receipt-1",idempotencyKey:"funding-1"};
    const [a,b]=await Promise.all([service.recordMoney(entry),service.recordMoney(entry)]);expect(a.id).toBe(b.id);
    const s=await service.snapshot();expect(s.metrics.availableCapitalUsd).toBe("200.000000");expect(s.metrics.revenueUsd).toBe("0.000000");
    await expect(service.recordMoney({...entry,amountUsd:"201"})).rejects.toThrow("Idempotency");
  });
});

function paidModel(adapter=new MockProvider()):RuntimeModel {return{id:"paid-test",name:"Paid test fixture",provider:"openai",model:"fixture",family:"fixture",ready:true,live:true,inputPerMillionUsd:"1",outputPerMillionUsd:"1",maxInputTokens:20000,maxOutputTokens:3000,adapter};}
async function paidSetup(model=paidModel()){
  service.models.push(model);await service.configure({dailyCapUsd:"1",liveCapUsd:"1",capitalAllocationUsd:"200"});await service.setStatus("RUNNING");return create({modelId:model.id,reviewModelId:model.id});
}
describe("Charge authorization and reconciliation",()=>{
  it('lets the model-call switch override general expense approval and removes obsolete requests',async()=>{
    const {id}=await paidSetup();await worker.runNext();
    const pending=await one(db,"SELECT * FROM actions WHERE task_id=$1 AND action_type='MODEL_CALL'",[id]);
    expect(pending.status).toBe('PENDING');
    await service.setApprovalPolicy({modelCalls:false});
    expect((await service.snapshot()).company.approval_policy.expenses).toBe(true);
    expect((await one(db,'SELECT status FROM actions WHERE id=$1',[pending.id])).status).toBe('CANCELLED');
    expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[id])).status).toBe('PLAN_PENDING');
    await worker.runNext();
    expect((await one(db,'SELECT status FROM calls WHERE task_id=$1',[id])).status).toBe('SUCCEEDED');
    expect((await db.query("SELECT id FROM actions WHERE action_type='MODEL_CALL' AND status='PENDING'")).rows).toHaveLength(0);
    await service.setApprovalPolicy({modelCalls:true});await worker.runNext();
    expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[id])).status).toBe('BLOCKED_APPROVAL');
  });

  it('dispatches the frozen approved prompt when company context changes during review',async()=>{
    const adapter=new MockProvider();const generate=adapter.generate.bind(adapter);let sent:any;
    adapter.generate=async request=>{sent=request;return generate(request);};
    const {id}=await paidSetup(paidModel(adapter));await worker.runNext();
    const action=await one(db,'SELECT * FROM actions WHERE task_id=$1',[id]);
    await service.createRecord({kind:'NOTE',title:'New context while approval was pending',body:'This must only appear in subsequent prompts.'});
    await service.retryTask(id);await worker.runNext();
    expect((await db.query('SELECT id FROM actions WHERE task_id=$1',[id])).rows).toHaveLength(1);
    await service.approveAction(action.id,action.action_hash,'APPROVE','Approve the displayed prompt');
    await worker.runNext();
    expect(sent).toEqual(action.payload.request);
    expect((await db.query('SELECT id FROM actions WHERE task_id=$1',[id])).rows).toHaveLength(1);
    expect((await one(db,'SELECT status FROM actions WHERE id=$1',[action.id])).status).toBe('EXECUTED');
  });
  it('requires fresh approval when model pricing changes after proposal',async()=>{
    const model=paidModel();const {id}=await paidSetup(model);await worker.runNext();
    const action=await one(db,'SELECT * FROM actions WHERE task_id=$1',[id]);
    await service.approveAction(action.id,action.action_hash,'APPROVE','Original prices');
    model.outputPerMillionUsd='2';await worker.runNext();
    expect((await db.query('SELECT id FROM calls')).rows).toHaveLength(0);
    const pending=await one(db,"SELECT * FROM actions WHERE task_id=$1 AND status='PENDING'",[id]);
    expect(pending.payload.pricing.outputPerMillionUsd).toBe('2');
    expect(pending.id).not.toBe(action.id);
  });
  it('rechecks current budget caps before dispatching a frozen approved request',async()=>{
    const {id}=await paidSetup();await worker.runNext();
    const action=await one(db,'SELECT * FROM actions WHERE task_id=$1',[id]);
    await service.approveAction(action.id,action.action_hash,'APPROVE','Reviewed');
    await service.configure({dailyCapUsd:'0.001',liveCapUsd:'1',capitalAllocationUsd:'200'});
    await worker.runNext();
    expect((await db.query('SELECT id FROM calls')).rows).toHaveLength(0);
    expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[id])).status).toBe('BLOCKED_BUDGET');
  });
  it("a paid call cannot reserve or dispatch until the exact proposal is approved",async()=>{
    const{id}=await paidSetup();await worker.runNext();expect((await one(db,"SELECT status FROM tasks WHERE id=$1",[id])).status).toBe("BLOCKED_APPROVAL");expect((await db.query("SELECT * FROM calls")).rows).toHaveLength(0);
    const a=await one(db,"SELECT * FROM actions WHERE task_id=$1",[id]);
    await expect(service.approveAction(a.id,"wrong","APPROVE","Reviewed")).rejects.toThrow("changed");
    await service.approveAction(a.id,a.action_hash,"APPROVE","Approved fixture call");await worker.runNext();
    expect((await one(db,"SELECT status FROM tasks WHERE id=$1",[id])).status).toBe("READY");
    expect((await one(db,"SELECT status FROM actions WHERE id=$1",[a.id])).status).toBe("EXECUTED");
    await worker.runNext();expect((await db.query("SELECT * FROM calls")).rows).toHaveLength(1);expect((await db.query("SELECT * FROM actions WHERE status='PENDING'")).rows).toHaveLength(1);
  });
  it("parallel reservations cannot both consume the same remaining cap",async()=>{
    await paidSetup();await create({modelId:"paid-test",reviewModelId:"paid-test"});await service.setApprovalPolicy({expenses:false,modelCalls:false});
    await service.configure({dailyCapUsd:"0.023",liveCapUsd:"1",capitalAllocationUsd:"200"});
    await db.query("UPDATE company SET max_concurrency=2 WHERE id=1");
    await Promise.all([new Worker(service).runNext(),new Worker(service).runNext()]);
    // One call can reserve $0.023; the other must block until that reservation settles.
    expect((await db.query("SELECT * FROM calls")).rows).toHaveLength(1);
    expect((await db.query("SELECT * FROM tasks WHERE status='BLOCKED_BUDGET'")).rows).toHaveLength(1);
  });
  it("timeouts keep financial exposure and prevent retry until reconciled",async()=>{
    const adapter=new MockProvider();adapter.generate=async()=>{throw new ProviderFailure("Timed out");};
    const{id}=await paidSetup(paidModel(adapter));await service.setApprovalPolicy({expenses:false,modelCalls:false});await worker.runNext();
    const call=await one(db,"SELECT * FROM calls WHERE task_id=$1",[id]);expect(call.status).toBe("UNCERTAIN");expect(BigInt(call.reserved)).toBeGreaterThan(0n);
    await expect(service.retryTask(id)).rejects.toThrow("Reconcile");await worker.reconcile(call.id,"0.005","Provider receipt confirms cost");await service.retryTask(id);
    expect((await one(db,"SELECT status FROM tasks WHERE id=$1",[id])).status).toBe("PLAN_PENDING");
  });
  it("recovery never repeats a possibly dispatched call",async()=>{
    const{id}=await create();await db.query("INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,token_reserved,budget_day) VALUES('interrupted',$1,'PLAN',1,'mock-worker','mock',false,'DISPATCHED',10000,3000,CURRENT_DATE)",[id]);
    await worker.recover();expect((await one(db,"SELECT status FROM calls WHERE id='interrupted'")).status).toBe("UNCERTAIN");expect((await one(db,"SELECT status FROM tasks WHERE id=$1",[id])).status).toBe("BLOCKED_APPROVAL");
  });
});

describe("Owner gateway",()=>{
  it("strict expense approval overrides scoped grants until disabled",async()=>{
    await service.setStatus("RUNNING");const expiry=new Date(Date.now()+3600000).toISOString();
    await service.createGrant({actionType:"SANDBOX_PURCHASE",target:"fixture",maxTransactionUsd:"1",totalCapUsd:"1",expiresAt:expiry,rationale:"Test grant"});
    const a=await service.createAction({actionType:"SANDBOX_PURCHASE",target:"fixture",payload:{item:"test"},rationale:"Fixture",maxCostUsd:"1",expiresAt:expiry});
    await expect(service.executeSandbox(a.id)).rejects.toThrow("approval is required");await service.setApprovalPolicy({expenses:false});await service.executeSandbox(a.id);await service.executeSandbox(a.id);
    expect((await db.query("SELECT * FROM ledger WHERE action_id=$1",[a.id])).rows).toHaveLength(1);expect((await service.snapshot()).metrics.businessCostsUsd).toBe("0.000000");
  });
  it("rejects unauthenticated controls and cross-origin requests",async()=>{
    const app=buildApp({service,worker,ownerToken:"a-test-owner-token-long-enough",logger:false});await app.ready();
    try{
      expect((await app.inject({method:"POST",url:"/v1/company/status",payload:{status:"RUNNING"}})).statusCode).toBe(401);
      expect((await app.inject({method:"POST",url:"/v1/company/status",headers:{authorization:"Bearer a-test-owner-token-long-enough",origin:"https://evil.example"},payload:{status:"RUNNING"}})).statusCode).toBe(403);
      const login=await app.inject({method:"POST",url:"/v1/auth/login",payload:{token:"a-test-owner-token-long-enough"}});expect(login.statusCode).toBe(200);
      const snapshot=await app.inject({url:"/v1/snapshot",headers:{cookie:login.headers["set-cookie"]!.toString().split(";")[0]}});expect(snapshot.statusCode).toBe(200);expect(snapshot.json().company.status).toBe("PAUSED");
    }finally{await app.close();}
  });
  it("CEO is bootstrapped autonomously exactly once",async()=>{
    await db.query("UPDATE company SET ceo_model_id='mock-worker',ceo_review_model_id='mock-reviewer' WHERE id=1");await service.setStatus("RUNNING");const org=new Organization(service);
    await Promise.all([org.tick(),org.tick()]);expect((await db.query("SELECT * FROM employees WHERE role='CEO'")).rows).toHaveLength(1);expect((await db.query("SELECT * FROM tasks")).rows).toHaveLength(1);
  });
  it("cross-department escalation needs no manager permission",async()=>{
    const org=new Organization(service);const result=await org.message({senderId:"research",recipientId:"executive",subject:"Evidence conflicts with strategy",body:"Review the observed customer response before proceeding.",kind:"ESCALATION"});
    expect((await one(db,"SELECT kind FROM messages WHERE id=$1",[result.id])).kind).toBe("ESCALATION");
  });
});
