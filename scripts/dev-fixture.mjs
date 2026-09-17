/**
 * Dev fixture server.
 *
 * Starts an isolated Hive instance on an in-memory database, seeds a realistic
 * operating company, and serves the dashboard so the interface can be reviewed
 * with populated data. It never touches the live data directory, never calls a
 * paid provider, and never starts the background worker.
 *
 *   node scripts/dev-fixture.mjs [--port 3099]
 *
 * Sign in with the access key printed on startup.
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, HiveService, createModels, actionHash } from "../packages/runtime/dist/index.js";
import { buildApp } from "../apps/api/dist/app.js";

const portArg = process.argv.indexOf("--port");
const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 3099;
const token = process.env.HIVE_FIXTURE_TOKEN ?? "dev-fixture-access-key-not-a-secret";

const db = await openDatabase();
const service = new HiveService(db, createModels({}));
const app = buildApp({ service, ownerToken: token, dashboardRoot: resolve("apps/dashboard/public"), paymentInfoPath: resolve("Payment_Info_Venmo_Crypto.example.txt"), logger: false });
app.get('/fixture-info',async()=>({synthetic:true,workersStarted:false,persistentData:false}));

const day = (offset) => new Date(Date.now() + offset * 86400000);
const iso = (offset) => day(offset).toISOString();
const id = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;

async function seed() {
  await db.transaction(async (tx) => {
    const employee = async (row) => {
      await tx.query(
        `INSERT INTO employees(id,name,role,department_id,manager_id,depth,charter,model_id,status,created_at,candidate_id,bio,traits)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [row.id, row.name, row.role, row.department, row.manager ?? null, row.depth, row.charter, row.model, row.status ?? "ACTIVE", iso(row.age ?? -6),
          row.candidate ?? null, row.bio ?? null, row.traits ? JSON.stringify(row.traits) : null],
      );
    };
    await employee({ id: "ceo", name: "Ada", role: "CEO", department: "executive", depth: 0, model: "local-qwen", charter: "Choose the smallest path to a paying customer. Hire only when the work is blocked on capacity.", age: -6 , candidate: "cand-arden", bio: "Picks one bet, funds it small, and kills it on schedule when the evidence disagrees.", traits: { caution: 3, rigor: 4, dissent: 4, initiative: 5, thrift: 4 } });
    await employee({ id: "emp-research", name: "Wren", role: "Head of research", department: "research", manager: "ceo", depth: 1, model: "local-qwen", charter: "Find reachable buyers with a stated, recurring, expensive problem.", age: -5 , candidate: "cand-wren", bio: "Trusts what a buyer wrote down in public over what anyone says they want.", traits: { caution: 4, rigor: 5, dissent: 4, initiative: 3, thrift: 4 } });
    await employee({ id: "emp-build", name: "Kes", role: "Head of build", department: "build", manager: "ceo", depth: 1, model: "mock-worker", charter: "Turn a validated offer into something deliverable this week.", age: -5 , candidate: "cand-kes", bio: "Ships the smallest thing that can be handed to a customer this week.", traits: { caution: 3, rigor: 3, dissent: 2, initiative: 4, thrift: 5 } });
    await employee({ id: "emp-sales", name: "Ives", role: "Growth lead", department: "sales", manager: "ceo", depth: 1, model: "local-qwen", charter: "Reach named buyers through authorized channels only.", age: -4 , candidate: "cand-ivo", bio: "Comfortable being told no. An unsent message is worth nothing.", traits: { caution: 2, rigor: 3, dissent: 3, initiative: 5, thrift: 3 } });
    await employee({ id: "emp-analyst", name: "Bly", role: "Research analyst", department: "research", manager: "emp-research", depth: 2, model: "local-qwen", charter: "Collect evidence with sources. Separate observation from inference.", age: -3 , candidate: "cand-bly", bio: "Careful with numbers and careful about saying more than they support.", traits: { caution: 4, rigor: 5, dissent: 3, initiative: 2, thrift: 4 } });
    await employee({ id: "emp-ops", name: "Cove", role: "Delivery operator", department: "operations", manager: "ceo", depth: 1, model: "mock-worker", charter: "Own turnaround time, quality and cost per delivered unit.", age: -2, status: "PAUSED" , candidate: "cand-cove", bio: "Owns turnaround time and whether the customer got what was promised.", traits: { caution: 3, rigor: 4, dissent: 3, initiative: 3, thrift: 4 } });

    const task = async (row) => {
      await tx.query(
        `INSERT INTO tasks(id,parent_id,root_id,objective,role,depth,status,phase,budget,token_budget,expires_at,model_id,review_model_id,plan,artifact,review,error,attempts,employee_id,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [row.id, row.parent ?? null, row.root ?? row.id, row.objective, row.role, row.depth, row.status, row.phase ?? "PLAN",
        row.budget ?? 1000000, row.tokens ?? 60000, iso(row.ttl ?? 2), row.model ?? "local-qwen", row.review ?? "mock-reviewer",
        row.plan ? JSON.stringify(row.plan) : null, row.artifact ? JSON.stringify(row.artifact) : null,
        row.review_result ? JSON.stringify(row.review_result) : null, row.error ?? null, row.attempts ?? 0,
        row.employee ?? null, iso(row.age ?? -1), iso(row.age ?? -1)],
      );
    };

    const plan = (steps) => ({ understanding: "Narrow the objective to one buyer, one offer, one measurable check.", steps, estimatedCostUsd: "0.180000", toolsNeeded: ["public research"], successCheck: "A named buyer segment with three sourced observations and a priced test." });
    const artifact = {
      title: "Permit-expiry monitoring for small HVAC contractors",
      summary: "Small mechanical contractors lose bid eligibility when municipal permits or trade licenses lapse. Renewal notices arrive by mail to an office nobody staffs. A weekly digest of upcoming expirations across the jurisdictions they actually bid in is worth paying for.",
      customer: "Owner-operators of 4-25 person HVAC and mechanical contracting firms in mid-size US metros.",
      problem: "Lapsed permits and licenses disqualify bids after the work has already been quoted. The cost is a lost job, not a fine.",
      offer: "A weekly emailed expiration digest covering every jurisdiction the firm bids in, with the renewal link and the responsible office.",
      channel: "Direct outreach through two regional trade associations that already publish member directories.",
      priceHypothesis: "$79/month per firm",
      evidence: [
        { source: "State licensing board bulletin, Aug 2026", observation: "Renewal notices are mailed once, 45 days out, with no email fallback.", kind: "OBSERVATION" },
        { source: "Trade association member forum thread", observation: "Nine separate posts in six months describe a bid disqualified by a lapsed credential.", kind: "OBSERVATION" },
        { source: "Analyst inference", observation: "A lost mid-size commercial bid is worth far more than a year of subscription.", kind: "INFERENCE" },
      ],
      validationTest: "Offer a hand-built digest to twelve firms in one metro. Charge before the second issue ships.",
      successCriteria: "Three firms pay within fourteen days.",
      killCriteria: "Fewer than two paid conversions, or a public data source turns out to require a license we cannot obtain.",
      estimatedTestCostUsd: "0.000000",
      ownerActions: ["Confirm the trade association permits vendor outreach to its directory."],
      limitations: ["Jurisdiction coverage is unverified outside the first metro.", "No permit data source has been checked for redistribution terms."],
      deliverables: [],
      operations: [],
    };

    await task({ id: "task-1", objective: "Choose one buyer segment worth a paid test this month and justify it with sourced evidence.", role: "CEO", depth: 0, status: "COMPLETED", phase: "REVIEW", employee: "ceo", age: -5, plan: plan(["Name three candidate segments", "Score by reachability and stated pain", "Commit to one"]), artifact, review_result: { decision: "PASS", findings: ["Evidence is sourced and separated from inference.", "Price hypothesis is not yet tested against a real quote."], nextAction: "Promote to a bounded experiment with a fourteen-day deadline." }, budget: 3000000, tokens: 400000 });
    await task({ id: "task-2", parent: "task-1", root: "task-1", objective: "Verify that permit and license expiration data is publicly available and redistributable for the first metro.", role: "Research analyst", depth: 1, status: "RUNNING", phase: "WORK", employee: "emp-analyst", age: -1, plan: plan(["List the authoritative sources", "Check terms of use", "Record what is unavailable"]), budget: 500000 });
    await task({ id: "task-3", parent: "task-1", root: "task-1", objective: "Draft the outreach message for the trade association directory, ready for owner review before anything is sent.", role: "Growth lead", depth: 1, status: "REVIEW", phase: "REVIEW", employee: "emp-sales", age: -1, plan: plan(["Write the message", "Name the association's stated rules", "Prepare the owner approval"]), budget: 400000 });
    await task({ id: "task-4", parent: "task-1", root: "task-1", objective: "Build the first digest by hand for one firm so the format can be judged before any automation.", role: "Head of build", depth: 1, status: "BLOCKED_APPROVAL", phase: "WORK", employee: "emp-build", age: 0, budget: 600000 });
    await task({ id: "task-5", objective: "Reduce the cost per completed research task without lowering the review standard.", role: "CEO", depth: 0, status: "READY", phase: "PLAN", employee: "ceo", age: 0, budget: 300000 });
    await task({ id: "task-6", parent: "task-1", root: "task-1", objective: "Survey three competing permit-monitoring vendors and their published pricing.", role: "Research analyst", depth: 1, status: "FAILED", phase: "WORK", employee: "emp-analyst", age: -2, error: "The reviewer blocked the result twice: two of three vendor prices were inferred rather than observed.", attempts: 2, budget: 300000 });

    const call = async (row) => {
      await tx.query(
        `INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,settled,token_reserved,input_tokens,output_tokens,request_id,budget_day,created_at,completed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [row.id, row.task, row.phase, row.attempt ?? 1, row.model, row.provider, row.live ?? false, row.status,
        row.reserved ?? 0, row.settled ?? null, row.tokens ?? 20000, row.input ?? null, row.output ?? null,
        row.request ?? null, day(row.age ?? -1).toISOString().slice(0, 10), iso(row.age ?? -1), row.status === "SUCCEEDED" ? iso(row.age ?? -1) : null],
      );
    };
    let n = 0;
    for (const [task, phase, input, output] of [["task-1", "PLAN", 2140, 610], ["task-1", "WORK", 5880, 2310], ["task-1", "REVIEW", 6900, 480],
    ["task-6", "PLAN", 1980, 520], ["task-6", "WORK", 4100, 1870], ["task-3", "PLAN", 2050, 640], ["task-3", "WORK", 5210, 1980]]) {
      await call({ id: `call-${++n}`, task, phase, model: "local-qwen", provider: "lmstudio", status: "SUCCEEDED", reserved: 0, settled: 0, input, output, request: `lmstudio-${n}`, age: -2 });
    }
    await call({ id: "call-live-1", task: "task-2", phase: "WORK", model: "anthropic", provider: "anthropic", live: true, status: "SUCCEEDED", reserved: 240000, settled: 187400, input: 8420, output: 2140, request: "req_fixture_a", age: -1 });
    await call({ id: "call-live-2", task: "task-3", phase: "REVIEW", model: "anthropic", provider: "anthropic", live: true, status: "UNCERTAIN", reserved: 180000, tokens: 24000, input: 6100, request: "req_fixture_b", age: 0 });

    const experiment = async (row) => {
      await tx.query(
        `INSERT INTO experiments(id,task_id,title,status,hypothesis,customer,offer,channel,price,max_loss,success_criteria,kill_criteria,deadline,evidence,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [row.id, row.task ?? null, row.title, row.status, row.hypothesis, row.customer, row.offer, row.channel, row.price,
        row.maxLoss, row.success, row.kill, iso(row.deadline), JSON.stringify(row.evidence ?? []), iso(row.age ?? -3)],
      );
    };
    await experiment({ id: "exp-1", task: "task-1", title: "Permit-expiry digest, one metro", status: "VALIDATING", hypothesis: "Three HVAC firms will pay $79/month for a weekly credential-expiration digest before the second issue ships.", customer: "Owner-operators of 4-25 person mechanical contracting firms.", offer: "Weekly emailed expiration digest with renewal links.", channel: "Two regional trade association directories.", price: "$79/month", maxLoss: 40000000, success: "Three paid firms within fourteen days.", kill: "Fewer than two paid conversions by the deadline.", deadline: 11, age: -3, evidence: [{ note: "Nine forum posts describe a bid lost to a lapsed credential." }] });
    await experiment({ id: "exp-2", title: "Same-day drawing markup for small GCs", status: "DRAFT", hypothesis: "General contractors will pay per-drawing for a same-day redline turnaround.", customer: "General contractors under 30 staff.", offer: "Per-drawing markup returned within eight working hours.", channel: "Direct referral from the HVAC segment.", price: "$45/drawing", maxLoss: 25000000, success: "Two paid drawings from separate firms.", kill: "No firm agrees to send a first drawing within ten days.", deadline: 21, age: -1 });
    await experiment({ id: "exp-3", title: "Generic small-business newsletter", status: "KILLED", hypothesis: "A broad small-business newsletter converts to paid sponsorship.", customer: "Undefined.", offer: "Weekly newsletter.", channel: "Cold social posting.", price: "Sponsorship, unpriced", maxLoss: 10000000, success: "One sponsor.", kill: "No named buyer after seven days.", deadline: -2, age: -8 });

    const action = async (row) => {
      const expiresAt=iso(row.expires??2);
      const hash=actionHash({id:row.id,taskId:row.task??null,experimentId:row.experiment??null,actionType:row.type,target:row.target,payload:row.payload,rationale:row.rationale,maxCostMicroUsd:row.maxCost,expiresAt});
      await tx.query(
        `INSERT INTO actions(id,task_id,experiment_id,action_type,target,payload,rationale,max_cost,expires_at,action_hash,status,reservation,settled,result,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [row.id, row.task ?? null, row.experiment ?? null, row.type, row.target, JSON.stringify(row.payload), row.rationale,
          row.maxCost, expiresAt, hash, row.status, row.reservation ?? 0,
        row.settled ?? null, row.result ? JSON.stringify(row.result) : null, iso(row.age ?? 0)],
      );
    };
    await action({ id: "act-1", task: "task-3", experiment: "exp-1", type: "SEND_MESSAGE", target: "membership@example-trade-association.org", payload: { subject: "Vendor listing enquiry", body: "Asks whether vendor outreach to the member directory is permitted, and under what terms. No offer is made in this message." }, rationale: "The association's public rules do not state whether vendor outreach is allowed. Asking first is cheaper than being removed from the directory.", maxCost: 0, status: "PENDING", expires: 2, age: 0 });
    await action({ id: "act-2", task: "task-4", experiment: "exp-1", type: "PURCHASE", target: "permit-data-portal.example.gov bulk export", payload: { item: "Single-metro quarterly export", quantity: 1, unitPriceUsd: "35.00" }, rationale: "The per-record API would cost more than the export within eleven days at the expected query volume.", maxCost: 35000000, status: "PENDING", expires: 4, age: 0 });
    await action({ id: "act-3", type: "READ_PUBLIC_PAGE", target: "https://example-licensing-board.gov/renewals", payload: { url: "https://example-licensing-board.gov/renewals" }, rationale: "Confirm the stated renewal notice window before it is quoted as evidence.", maxCost: 0, status: "EXECUTED", settled: 0, result: { status: 200, bytes: 18420 }, age: -1 });
    await action({ id: "act-4", type: "PUBLISH", target: "hive-fixture.example.com/landing", payload: { draft: "One-page description of the digest with a single contact form." }, rationale: "A landing page makes the offer concrete before outreach begins.", maxCost: 0, status: "REJECTED", age: -2 });

    await tx.query("INSERT INTO approvals(id,action_id,action_hash,decision,rationale) SELECT $1,id,action_hash,'REJECT',$2 FROM actions WHERE id='act-4'",
      [id("apr"), "Publishing before the association confirms its outreach rules risks the only channel we have."]);

    const request = async (row) => {
      await tx.query(
        `INSERT INTO owner_requests(id,experiment_id,title,details,status,response,minutes,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.id, row.experiment ?? null, row.title, row.details, row.status ?? "OPEN", row.response ?? null, row.minutes ?? 0, iso(row.age ?? -1)],
      );
    };
    await request({ id: "req-1", experiment: "exp-1", title: "Confirm the Mac mini LAN worker address and loaded model", details: "The Mac mini needs a reachable base URL on the local network, the exact model ID that is loaded, and its context limit. Add it to config/models.json with allowLan set, then restart the API.", age: -2 });
    await request({ id: "req-2", experiment: "exp-1", title: "Confirm the trade association permits vendor outreach", details: "One phone call or one email to the association office. The answer decides whether the only identified channel is usable. Estimated fifteen minutes.", age: 0 });
    await request({ id: "req-3", title: "Record whether any capital has actually been deposited", details: "The $200 allocation is a planning limit, not money. Record real funding in the ledger when it arrives so available capital stops reading as zero.", status: "DONE", response: "No capital deposited yet. Operating on local models only.", minutes: 5, age: -4 });

    await tx.query(
      `INSERT INTO grants(id,action_type,target,experiment_id,max_transaction,total_cap,expires_at,revoked,rationale,created_at)
       VALUES($1,'READ_PUBLIC_PAGE','https://example-licensing-board.gov',$2,0,0,$3,false,$4,$5)`,
      [id("grant"), "exp-1", iso(14), "Reading published licensing pages costs nothing and is needed on every research cycle.", iso(-3)]);

    const money = async (row) => {
      await tx.query(
        `INSERT INTO ledger(id,idempotency_key,account,kind,amount,task_id,experiment_id,call_id,description,external_reference,occurred_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id("led"), randomUUID(), row.account, row.kind, row.amount, row.task ?? null, row.experiment ?? null, row.call ?? null,
        row.description, row.reference ?? null, iso(row.age)]);
    };
    await money({ account: "BUSINESS", kind: "FUNDING", amount: 200000000, description: "Owner funding deposit", reference: "transfer-2026-08-30", age: -9 });
    await money({ account: "BUSINESS", kind: "REVENUE", amount: 79000000, experiment: "exp-1", description: "First paid digest subscription", reference: "inv-1001", age: -2 });
    await money({ account: "BUSINESS", kind: "REVENUE", amount: 79000000, experiment: "exp-1", description: "Second paid digest subscription", reference: "inv-1002", age: -1 });
    await money({ account: "BUSINESS", kind: "COST", amount: 12000000, experiment: "exp-1", description: "Trade association directory access, one month", reference: "receipt-88213", age: -3 });
    await money({ account: "OPERATING", kind: "COST", amount: 187400, call: "call-live-1", task: "task-2", description: "Anthropic model call, work phase", age: -1 });
    await money({ account: "BUSINESS", kind: "REFUND", amount: 79000000, experiment: "exp-1", description: "Refunded first subscription: the first digest missed two jurisdictions", reference: "credit-1001", age: 0 });

    const message = async (row) => {
      await tx.query(
        `INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id("msg"), row.from, row.to, row.kind, row.subject, row.body, row.task ?? null, iso(row.age)]);
    };
    await message({ from: "ceo", to: "emp-research", kind: "MESSAGE", subject: "Narrow to one metro before anything else", body: "Coverage across jurisdictions is the whole product risk. Prove one metro end to end before we describe the offer to anyone.", task: "task-2", age: -4 });
    await message({ from: "emp-analyst", to: "emp-research", kind: "ESCALATION", subject: "Two vendor prices are not publicly stated", body: "I can observe one competitor price. The other two are quote-only. I would rather report one observation than three inferences.", task: "task-6", age: -2 });
    await message({ from: "emp-research", to: "ceo", kind: "DECISION", subject: "Dropping the competitor pricing comparison", body: "Reporting inferred prices as evidence would corrupt every downstream decision. We proceed with one observed price and say so.", task: "task-6", age: -2 });
    await message({ from: "emp-sales", to: "owner", kind: "REQUEST", subject: "Outreach is blocked on the association's rules", body: "The draft is ready and will not be sent until the association confirms vendor outreach is permitted.", task: "task-3", age: 0 });

    await tx.query(
      `INSERT INTO meetings(id,title,objective,organizer_id,participants,scheduled_at,budget,status,decisions,token_budget,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      ["meet-1", "Go / no-go on the first metro", "Decide whether the permit digest is worth a paid test, or whether coverage risk kills it.",
        "ceo", JSON.stringify(["emp-research", "emp-build", "emp-sales"]), iso(-1), 400000, "COMPLETED",
        JSON.stringify({ summary: "Proceed with one metro and a hand-built first issue. Automation is not funded until a second firm pays.", decisions: ["Ship the first digest by hand", "No automation spend before two paid firms"] }), 180000, iso(-2)]);
    await tx.query(
      `INSERT INTO meetings(id,title,objective,organizer_id,participants,scheduled_at,budget,status,token_budget,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      ["meet-2", "Coverage gap review", "Review what the first digest missed and decide whether to refund or repair.",
        "ceo", JSON.stringify(["emp-research", "emp-ops"]), iso(1), 300000, "SCHEDULED", 180000, iso(0)]);

    await tx.query(
      `INSERT INTO task_artifacts(id,task_id,call_id,filename,media_type,content,sha256,created_at)
       VALUES($1,'task-1','call-3','buyer-segment-brief.md','text/markdown',$2,$3,$4)`,
      [id("art"), "# Permit-expiry monitoring\n\nOne buyer segment, three sourced observations, and one priced test.\n", "f".repeat(64), iso(-5)]);

    const direction = async (row) => {
      await tx.query(
        `INSERT INTO directions(id,headline,statement,set_by,set_by_role,task_id,superseded_at,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.id, row.headline, row.statement, row.by, row.role, row.task ?? null, row.superseded ? iso(row.superseded) : null, iso(row.age)]);
    };
    await direction({ id: 'dir-1', headline: 'Sell to anyone who will listen', statement: 'Cast wide and find out what sticks. Publish broadly and see who responds.', by: 'ceo', role: 'CEO', age: -8, superseded: -5 });
    await direction({ id: 'dir-2', headline: 'One metro, one credential problem, one buyer', statement: 'Broad outreach produced nothing in six days. We are going narrow: HVAC contractors in a single metro who lose bids to lapsed credentials. Sell the digest by hand before building anything. Automation is not funded until a second firm pays.', by: 'ceo', role: 'CEO', task: 'task-1', age: -5 });

    // Event types and payload shapes must match what the runtime actually writes,
    // otherwise the dashboard is being designed against events that never occur.
    const record = async (type, entity, actor, age, payload = {}) => {
      await tx.query("INSERT INTO events(type,entity_id,actor,payload,created_at) VALUES($1,$2,$3,$4,$5)",
        [type, entity, actor, JSON.stringify(payload), iso(age)]);
    };
    await record("employee.ceo_created", "ceo", "system", -6, { modelId: "local-qwen" });
    await record("company.direction_set", "dir-1", "ceo", -8, { headline: "Sell to anyone who will listen", setByRole: "CEO" });
    await record("task.plan_accepted", "task-1", "system", -5, {});
    await record("task.reviewed", "task-1", "system", -5, { decision: "PASS", reviewModel: "mock-reviewer" });
    await record("company.direction_set", "dir-2", "ceo", -5, { headline: "One metro, one credential problem, one buyer", setByRole: "CEO" });
    await record("employee.hired", "emp-analyst", "emp-research", -3, { managerId: "emp-research", role: "Research analyst", modelId: "local-qwen" });
    await record("experiment.created", "exp-1", "ceo", -3, { title: "Permit-expiry digest, one metro" });
    await record("ledger.recorded", null, "owner", -2, { kind: "REVENUE", amountUsd: "79.00", externalReference: "inv-1001" });
    await record("task.reviewed", "task-6", "system", -2, { decision: "BLOCK", reviewModel: "mock-reviewer" });
    await record("action.decided", "act-4", "owner", -2, { decision: "REJECT", hash: "fixture", rationale: "Publishing before the association confirms its rules risks the only channel we have." });
    await record("meeting.completed", "meet-1", "ceo", -1, { summaryTaskId: "task-1" });
    await record("call.settled", "call-live-1", "system", -1, { taskId: "task-2", costMicroUsd: "187400", inputTokens: 8420, outputTokens: 2140 });
    await record("operation.applied", "task-1:0", "ceo", -1, { type: "ASSIGN_TASK", entityId: "task-2" });
    await record("call.uncertain", "call-live-2", "system", 0, { reason: "Usage missing or invalid" });
    await record("action.proposed", "act-2", "emp-build", 0, { actionType: "PURCHASE", target: "permit-data-portal.example.gov bulk export", maxCostUsd: "35.00" });
    await record("owner.requested", "req-2", "emp-sales", 0, { title: "Confirm the trade association permits vendor outreach" });
    await record("operation.blocked", "task-6:1", "system", 0, { type: "PROPOSE_EXTERNAL", reason: "Two of three vendor prices were inferred rather than observed." });

    await tx.query(
      `UPDATE company SET mandate=$1, max_agents=12, max_concurrency=3, cycle_interval_minutes=45,
        ceo_model_id='local-qwen', ceo_review_model_id='local-qwen', daily_cap=10000000, live_cap=25000000 WHERE id=1`,
      ["Find one reachable buyer with an expensive, recurring problem and sell them something small this month. Prefer evidence over volume. Every expense and external action waits for the owner."]);
  });
}

await seed();
await app.listen({ port, host: "127.0.0.1" });
console.log(`Dev fixture dashboard: http://127.0.0.1:${port}`);
console.log(`Access key: ${token}`);
console.log("In-memory database. Nothing here touches the live data directory.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void app.close().then(() => db.close()).then(() => process.exit(0)); });
}
