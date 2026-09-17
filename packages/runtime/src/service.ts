import {instanceSettings} from './instance-settings.js';
import {currentMission,missionTemplates} from './missions.js';
import {orderRegister} from './orders.js';
import {backlogScheduleStatus} from './backlog-scheduling.js';
import {consultations} from './consultations.js';
import {experimentEconomics,linkTaskExperiment} from './experiment-economics.js';
import {backlogItems} from './backlog.js';
import {pendingFollowUps} from './follow-ups.js';
import {ownerEffort} from './owner-effort.js';
import type {Workspaces} from './workspaces.js';
import {emailQueueStatus} from './email-status.js';
import {hostingSetup,type HostingSetup} from './hosting.js';
import {staticPublication} from './releases.js';
import { documentIndex } from './documents.js';
import { smsSetupStatus } from './sms-config.js';
import { modelOutcomes } from './model-evidence.js';
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { parseUsd } from "@hive/core";
import { event, one, type Row, type Tx } from "./db.js";
import { actionInput, companyRecordInput, experimentInput, formatUsd, grantInput, taskInput } from "./contracts.js";
import { modelProfileSchema, paidModelSettingsSchema, applyContextLimit, priceTokens, type RuntimeModel } from "./models.js";
import type { Candidate } from "./personas.js";
import { publishedPrice } from './published-prices.js';

export class DomainError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}
export const activeCalls = "('RESERVED','DISPATCHED','UNCERTAIN')";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",") + "}";
  return JSON.stringify(value);
}
export function actionHash(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
const terminal = ["COMPLETED", "CANCELLED", "FAILED", "EXPIRED"];

/**
 * What has actually happened since a direction was set. A strategy that produces
 * nothing should be visible as such — to the owner, and to the CEO on its next cycle.
 */
export async function directionScorecard(tx: Pick<Tx, "query">, since: string | Date, missionId?:string) {
  const at=new Date(since).toISOString();
  const mission=missionId?await one(tx,'SELECT * FROM missions WHERE id=$1',[missionId]):await currentMission(tx);
  const row=await one(tx, `SELECT
   (SELECT COUNT(*)::integer FROM tasks WHERE mission_id=$2 AND status='COMPLETED' AND finished_at>=$1) AS completed,
   (SELECT COUNT(*)::integer FROM tasks WHERE mission_id=$2 AND status IN ('FAILED','EXPIRED') AND finished_at>=$1) AS failed,
   (SELECT COUNT(*)::integer FROM experiments WHERE mission_id=$2 AND created_at>=$1) AS opportunities,
   (SELECT COALESCE(SUM(amount),0)::text FROM ledger WHERE mission_id=$2 AND account='BUSINESS' AND kind='REVENUE' AND occurred_at>=$1) AS revenue,
   (SELECT COALESCE(SUM(amount),0)::text FROM ledger WHERE mission_id=$2 AND account='BUSINESS' AND kind='REFUND' AND occurred_at>=$1) AS refunds,
   (SELECT COALESCE(SUM(amount),0)::text FROM ledger WHERE mission_id=$2 AND kind='COST' AND account<>'TEST' AND occurred_at>=$1) AS spend,
   (SELECT COUNT(*)::integer FROM document_versions WHERE mission_id=$2 AND created_at>=$1) AS documents,
   (SELECT COUNT(*)::integer FROM actions WHERE mission_id=$2 AND action_type='READ_PUBLIC_PAGE' AND status='EXECUTED' AND created_at>=$1) AS sources,
   (SELECT COUNT(*)::integer FROM approvals ap JOIN actions a ON a.id=ap.action_id WHERE ap.mission_id=$2 AND ap.created_at>=$1 AND ap.decision='APPROVE' AND a.action_type<>'MODEL_CALL') AS approved`,[at,mission?.id??null]);
  const completion=(await tx.query<Row>("SELECT payload FROM events WHERE entity_id=$1 AND type='mission.completion_requested' ORDER BY sequence DESC LIMIT 1",[mission?.id??null])).rows[0]?.payload;
  return {
   completedTasks:row.completed,failedTasks:row.failed,spendUsd:formatUsd(row.spend),
   recordedProgress:{documentVersions:row.documents,fetchedSources:row.sources,approvedActions:row.approved},
   completionConditions:(mission?.definition_of_done??[]).map((condition:string,index:number)=>({condition,evidence:completion?.packet.conditions.find((item:any)=>item.conditionIndex===index)?.evidence??[],ownerConfirmed:mission?.status==='COMPLETED'})),
   ...(mission?.capabilities.includes('commerce')?{opportunitiesOpened:row.opportunities,revenueUsd:formatUsd(row.revenue),refundsUsd:formatUsd(row.refunds)}:{}),
   daysActive:Math.max(0,Math.floor((Date.now()-new Date(at).getTime())/86400000)),
  };
}

export class HiveService {
  /** People the CEO and its managers can hire. Loaded from config; empty is allowed. */
  candidates: Candidate[] = [];
  emailOAuthConfigured=false;
  workspaces?:Workspaces;
  sandboxReady=false;
  browserAvailable=false;
  hosting:HostingSetup=hostingSetup({});
  constructor(readonly db: PGlite, readonly models: RuntimeModel[], readonly now: () => Date = () => new Date()) { }
  async saveOwnerProfile(profile: {name:string;role:string;background:string;availability:string;preferences:string;constraints:string}) {
    await this.db.transaction(async tx => {
      await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
      const body = Object.entries(profile).filter(([,value]) => value).map(([label,value]) => `${label}: ${value}`).join('\n\n');
      await tx.query(`INSERT INTO company_records(id,kind,title,body) VALUES('owner-profile','NOTE',$1,$2)
        ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,archived=false,updated_at=now()`,[`Owner: ${profile.name}`,body]);
      await event(tx,'owner.profile_updated','owner',profile,'owner');
    });
  }
  async createProviderTest(modelId:string) {
    return this.db.transaction(async tx => {
      const company = await one(tx,'SELECT status FROM company WHERE id=1 FOR UPDATE');
      if (company.status === 'KILLED') throw new DomainError('Restart the company before requesting a provider test.');
      const model = this.model(modelId);
      const maximum = priceTokens(model,Math.min(1024,model.maxInputTokens),Math.min(1024,model.maxOutputTokens));
      const prior = (await tx.query<Row>(`SELECT id FROM tasks WHERE model_id=$1 AND expires_at>$2
        AND status NOT IN ('COMPLETED','FAILED','EXPIRED','CANCELLED')
        AND EXISTS(SELECT 1 FROM events WHERE entity_id=tasks.id AND type='model.test_requested') LIMIT 1`,[modelId,this.now()])).rows[0];
      if (prior) return {id:prior.id,maximumUsd:formatUsd(maximum)};
      const id = randomUUID();
      await tx.query(`INSERT INTO tasks(id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id)
        VALUES($1,$1,$2,'Provider connection test',0,'PLAN_PENDING',$3,10000,$4,$5,NULL)`,[id,`Provider connection test: ${model.model}. No business work.`,maximum.toString(),new Date(this.now().getTime()+3600000),modelId]);
      await event(tx,'model.test_requested',id,{modelId,maximumUsd:formatUsd(maximum)},'owner');
      return {id,maximumUsd:formatUsd(maximum)};
    });
  }
  async persistModelProfile(tx:Tx,raw:unknown,actor:string,id:string) {
    const input=modelProfileSchema.parse(raw);
    await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
    if(actor!=='owner'&&!(await tx.query("SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[actor])).rows.length)throw new DomainError('An active employee is required to register a model.');
    const connection=this.models.find(m=>m.id===input.connectionId&&!m.connectionId&&m.provider!=='mock');
    if(!connection)throw new DomainError('Select an existing provider connection.');
    const count=await one(tx,"SELECT count(*)::integer AS count FROM events WHERE type='model.profile_created'");
    if(count.count>=100)throw new DomainError('The configured model limit is 100 additional profiles.');
    const {connectionId,name,...settings}=input;
    await event(tx,'model.profile_created',id,{connectionId,name},actor);
    await event(tx,connection.live?'model.settings_updated':'model.local_settings_updated',id,connection.live?settings:{...settings,inputPerMillionUsd:'0',outputPerMillionUsd:'0'},actor);
  }
  async configureAgentModel(tx:Tx,id:string,raw:unknown,actor:string){
    const settings=paidModelSettingsSchema.strict().parse(raw);
    const company=await one(tx,'SELECT ceo_model_id FROM company WHERE id=1 FOR UPDATE');
    const model=this.models.find(m=>m.id===id&&m.provider!=='mock');
    if(!model)throw new DomainError('Select an existing provider model.');
    const reports=(await tx.query<Row>(`WITH RECURSIVE reports AS (
      SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'
      UNION SELECT e.id FROM employees e JOIN reports r ON e.manager_id=r.id WHERE e.status='ACTIVE'
    ) SELECT id FROM reports`,[actor])).rows.map(r=>r.id);
    if(!reports.length)throw new DomainError('An active employee is required to configure a model.');
    if(company.ceo_model_id===id||(await tx.query("SELECT id FROM employees WHERE role='CEO' AND status='ACTIVE' AND model_id=$1",[id])).rows.length)throw new DomainError('The owner controls the CEO model configuration. Register a separate model for other work.');
    if((await tx.query("SELECT id FROM employees WHERE model_id=$1 AND status='ACTIVE' AND NOT(id=ANY($2::text[]))",[id,reports])).rows.length)throw new DomainError('This model is shared outside your reporting chain. Register a separate configuration.');
    if((await tx.query("SELECT id FROM tasks WHERE (model_id=$1 OR review_model_id=$1) AND status NOT IN ('COMPLETED','FAILED','EXPIRED','CANCELLED') AND (employee_id IS NULL OR NOT(employee_id=ANY($2::text[])))",[id,reports])).rows.length)throw new DomainError('This model has work outside your reporting chain. Register a separate configuration.');
    if((await tx.query(`SELECT id FROM calls WHERE model_id=$1 AND status IN ${activeCalls}`,[id])).rows.length)throw new DomainError('Wait for active calls and reconcile uncertain usage before changing this model.');
    await event(tx,model.live?'model.settings_updated':'model.local_settings_updated',id,model.live?settings:{...settings,inputPerMillionUsd:'0',outputPerMillionUsd:'0'},actor);
  }
  async createModelProfile(raw:unknown) {
    const id='profile-'+randomUUID();
    await this.db.transaction(tx=>this.persistModelProfile(tx,raw,'owner',id));
    await this.loadModelSettings();
    return {id,ready:this.models.find(m=>m.id===id)?.ready===true};
  }
  async loadModelSettings() {
    const profiles=await this.db.query<Row>("SELECT entity_id,payload FROM events WHERE type='model.profile_created' ORDER BY sequence");
    for(const row of profiles.rows){
      if(this.models.some(m=>m.id===row.entity_id))continue;
      const connection=this.models.find(m=>m.id===row.payload.connectionId&&!m.connectionId);
      if(!connection)continue;
      this.models.push({...connection,id:row.entity_id,name:row.payload.name,connectionId:connection.id,ready:false,spendingCapsEnabled:true});
    }

    const localRows=await this.db.query<Row>("SELECT DISTINCT ON (entity_id) entity_id,payload FROM events WHERE type='model.local_settings_updated' ORDER BY entity_id,sequence DESC");
    for(const row of localRows.rows){
      const model=this.models.find(m=>m.id===row.entity_id&&m.provider==='lmstudio');if(!model)continue;
      const settings=paidModelSettingsSchema.parse(row.payload);Object.assign(model,settings,{inputPerMillionUsd:'0',outputPerMillionUsd:'0'});
      try{model.ready=(await model.adapter.listModels()).some(m=>m.modelId===model.model);const context=await model.adapter.loadedContextLength?.(model.model);if(context)applyContextLimit(model,context);}catch{model.ready=false;}
    }

    const rows = await this.db.query<Row>("SELECT DISTINCT ON (entity_id) entity_id,payload FROM events WHERE type='model.settings_updated' ORDER BY entity_id,sequence DESC");
    for (const row of rows.rows) {
      const index = this.models.findIndex(m => m.id === row.entity_id && m.live);
      if (index < 0) continue;
      const current = this.models[index];
      const settings = paidModelSettingsSchema.parse(row.payload);
      const published = publishedPrice(current.provider, settings.model);
      const missingPrice = parseUsd(settings.inputPerMillionUsd) === 0n || parseUsd(settings.outputPerMillionUsd) === 0n;
      if (published) settings.model = published.model;
      if (published && missingPrice && settings.maxInputTokens <= published.maxInputTokens) {
        settings.inputPerMillionUsd = published.input; settings.outputPerMillionUsd = published.output;
      }
      this.models[index] = { ...current, ...settings,
        pricingSource: published && missingPrice ? published.source : undefined,
        pricingCheckedAt: published && missingPrice ? '2026-09-08' : undefined,
        ready: current.credentialsConfigured === true && parseUsd(settings.inputPerMillionUsd) > 0n && parseUsd(settings.outputPerMillionUsd) > 0n };
    }
    const caps = await this.db.query<Row>("SELECT DISTINCT ON (entity_id) entity_id,payload FROM events WHERE type='model.spending_caps_updated' ORDER BY entity_id,sequence DESC");
    for (const row of caps.rows) {
      const index = this.models.findIndex(m => m.id === row.entity_id);
      if (index >= 0) this.models[index] = {...this.models[index],spendingCapsEnabled:row.payload.enabled !== false};
    }
  }
  async setModelSpendingCaps(id:string, enabled:boolean) {
    await this.db.transaction(async tx => {
      await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
      if (!this.models.some(m => m.id === id && m.live)) throw new DomainError('Select a paid provider model.');
      await event(tx,'model.spending_caps_updated',id,{enabled},'owner');
      const tasks = await tx.query<Row>(`UPDATE tasks SET
        status=CASE phase WHEN 'PLAN' THEN 'PLAN_PENDING' WHEN 'WORK' THEN 'READY' ELSE 'REVIEW' END,error=NULL,updated_at=now()
        WHERE status='BLOCKED_BUDGET' AND expires_at>$1
        AND model_id=$2
        AND (error LIKE 'Daily operating cap%' OR error LIKE 'Lifetime live-test cap%' OR error LIKE 'Lifetime paid-model cap%')
        AND NOT EXISTS(SELECT 1 FROM calls WHERE task_id=tasks.id AND status IN ${activeCalls}) RETURNING id`,[this.now(),id]);
      for (const task of tasks.rows) await event(tx,'task.budget_recheck_requested',task.id,{reason:'Owner changed model spending-cap enforcement.'},'owner');
    });
    await this.loadModelSettings();
  }
  async configureModel(id: string, raw: unknown) {
    const local=this.models.find(m=>m.id===id&&m.provider==='lmstudio');
    if(local){
      const settings=paidModelSettingsSchema.omit({inputPerMillionUsd:true,outputPerMillionUsd:true}).strict().parse(raw);
      let available;try{available=await local.adapter.listModels();}catch{throw new DomainError('Cannot reach this LM Studio server. Start it and try again.');}
      if(!available.some(m=>m.modelId===settings.model))throw new DomainError('Model ID is not available on this LM Studio server. Load the model and copy its exact ID.');
      const next={...local,...settings,ready:true};const context=await local.adapter.loadedContextLength?.(settings.model);if(context)applyContextLimit(next,context);
      await this.db.transaction(async tx=>{
        await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
        if((await tx.query(`SELECT id FROM calls WHERE model_id=$1 AND status IN ${activeCalls}`,[id])).rows.length)throw new DomainError('Wait for active calls and reconcile uncertain calls before changing this model.');
        await event(tx,'model.local_settings_updated',id,settings,'owner');
      });Object.assign(local,next);return {ready:local.ready};
    }

    const settings = paidModelSettingsSchema.strict().parse(raw);
    await this.db.transaction(async tx => {
      await one(tx, 'SELECT id FROM company WHERE id=1 FOR UPDATE');
      const index = this.models.findIndex(m => m.id === id && m.live);
      if (index < 0) throw new DomainError('Select a paid provider model.');
      const held = await tx.query(`SELECT id FROM calls WHERE model_id=$1 AND status IN ${activeCalls}`, [id]);
      if (held.rows.length) throw new DomainError('Wait for active calls and reconcile uncertain charges before changing this model.');
      await event(tx, 'model.settings_updated', id, settings, 'owner');
    });
    await this.loadModelSettings();
    return { ready: this.models.find(m => m.id === id)!.ready };
  }
  model(id: string) {
    const model = this.models.find((m) => m.id === id);
    if (!model?.ready) throw new DomainError("Model is not configured with credentials, model ID, and pricing.");
    return model;
  }
  async createRecord(input: unknown) {
    const x = companyRecordInput.parse(input);
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query("INSERT INTO company_records(id,kind,title,body) VALUES($1,$2,$3,$4)", [id, x.kind, x.title, x.body]);
      await event(tx, "company.record_added", id, { kind: x.kind, title: x.title }, "owner");
    });
    return { id };
  }
  async updateRecord(id: string, input: unknown) {
    const x = companyRecordInput.parse(input);
    await this.db.transaction(async (tx) => {
      await one(tx, "SELECT id FROM company_records WHERE id=$1", [id]);
      await tx.query("UPDATE company_records SET kind=$2,title=$3,body=$4,updated_at=now() WHERE id=$1", [id, x.kind, x.title, x.body]);
      await event(tx, "company.record_updated", id, { kind: x.kind, title: x.title }, "owner");
    });
  }
  async archiveRecord(id: string) {
    await this.db.transaction(async (tx) => {
      await one(tx, "SELECT id FROM company_records WHERE id=$1", [id]);
      await tx.query("UPDATE company_records SET archived=true,updated_at=now() WHERE id=$1", [id]);
      await event(tx, "company.record_archived", id, {}, "owner");
    });
  }
  async snapshot() {
    return this.db.transaction(async (tx) => {
      const company = await one(tx, "SELECT * FROM company WHERE id=1");
      const query = async (sql: string,params:any[] = []) => (await tx.query<Row>(sql,params)).rows;
      const tasks = await query(`SELECT t.*, COALESCE((SELECT SUM(COALESCE(c.settled,0)) FROM calls c WHERE c.task_id=t.id),0)::text AS spent,
        COALESCE((SELECT SUM(c.reserved) FROM calls c WHERE c.task_id=t.id AND c.status IN ${activeCalls}),0)::text AS reserved FROM tasks t ORDER BY created_at DESC LIMIT 200`);
      const ledger = await query("SELECT * FROM ledger ORDER BY occurred_at DESC LIMIT 200");
      const totals = await query("SELECT account,kind,SUM(amount)::text AS amount FROM ledger GROUP BY account,kind");
      const amount = (account: string, kind: string) => BigInt(totals.find((r) => r.account === account && r.kind === kind)?.amount ?? 0);
      const holds = await one(tx, `SELECT COALESCE(SUM(reserved),0)::text AS amount FROM calls WHERE status IN ${activeCalls}`);
      const smsHolds = await one(tx, "SELECT COALESCE(SUM(reserved),0)::text AS amount FROM notifications WHERE settled IS NULL");
      const actionHolds = await one(tx,"SELECT COALESCE(SUM(reservation),0)::text AS amount FROM actions WHERE settled IS NULL");
      const today = this.now().toISOString().slice(0, 10);
      const day = await one(tx, `SELECT COALESCE(SUM(COALESCE(settled,0) + CASE WHEN status IN ${activeCalls} THEN reserved ELSE 0 END),0)::text AS amount FROM calls WHERE budget_day=$1 OR status IN ${activeCalls}`, [today]);
      const smsDay = await one(tx, "SELECT COALESCE(SUM(COALESCE(settled,0)+CASE WHEN settled IS NULL THEN reserved ELSE 0 END),0)::text AS amount FROM notifications WHERE budget_day=$1 OR (settled IS NULL AND reserved>0)", [today]);
      const dailyUsed = BigInt(day.amount) + BigInt(smsDay.amount);
      const business = amount("BUSINESS", "FUNDING") + amount("BUSINESS", "REVENUE") - amount("BUSINESS", "COST") - amount("BUSINESS", "REFUND");
      const daily = await query("SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day, account,kind,SUM(amount)::text AS amount FROM ledger WHERE occurred_at >= now() - interval '90 days' GROUP BY day,account,kind ORDER BY day");
      return {
        businessGeneration:(await query("SELECT payload->>'archive' AS generation FROM events WHERE type='company.reset' ORDER BY sequence DESC LIMIT 1"))[0]?.generation??'initial',
        ledgerRevision:(await one(tx,'SELECT COUNT(*)::text AS count FROM ledger')).count,
        recruitmentSearches:await query(`SELECT e.entity_id AS task_id,e.payload->>'role' AS role,
          e.payload->>'requirements' AS requirements,e.created_at,
          jsonb_array_length(e.payload->'candidates') AS candidate_count,t.employee_id,t.status,
          hires.people AS hires,
          CASE WHEN jsonb_array_length(hires.people)>0 THEN 'FILLED'
            WHEN t.status IN ('FAILED','CANCELLED','EXPIRED') OR (t.status='COMPLETED' AND t.operations_applied) THEN 'CLOSED'
            WHEN t.status IN ('BLOCKED_APPROVAL','BLOCKED_BUDGET') THEN 'ON_HOLD'
            WHEN t.phase='PLAN' THEN 'OPEN' ELSE 'IN_PROGRESS' END AS posting_status
          FROM events e JOIN tasks t ON t.id=e.entity_id
          LEFT JOIN LATERAL (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'role',p.role,'status',p.status,'hired_at',p.created_at) ORDER BY p.created_at),'[]'::jsonb) AS people
            FROM employees p WHERE p.candidate_id IN (SELECT c->>'id' FROM jsonb_array_elements(e.payload->'candidates') c)
          ) hires ON true
          WHERE e.type='recruitment.generated'
          ORDER BY CASE WHEN t.status NOT IN ('COMPLETED','FAILED','CANCELLED','EXPIRED') AND jsonb_array_length(hires.people)=0 THEN 0 ELSE 1 END,e.sequence DESC LIMIT 24`),
        reconciliationTasks:await query("SELECT e.entity_id AS call_id,t.id AS task_id,t.status,t.employee_id FROM events e JOIN tasks t ON t.id=e.payload->>'taskId' WHERE e.type='call.reconciliation_queued' ORDER BY e.sequence DESC LIMIT 100"),
        ownerEffort:await ownerEffort(tx),
        company: { ...company, dailyCapUsd: formatUsd(company.daily_cap), liveCapUsd: formatUsd(company.live_cap), capitalAllocationUsd: formatUsd(company.capital_allocation) },
        workspacesAvailable:!!this.workspaces,
        browserAvailable:this.browserAvailable,
        emailOAuthConfigured:this.emailOAuthConfigured,
        instance:instanceSettings,
        mission:await currentMission(tx),missionTemplates,
        missions:await query('SELECT * FROM missions ORDER BY created_at DESC'),
        emailMailbox:(await query("SELECT address,provider,enabled,daily_send_limit,last_synced_at,error,credential_ciphertext IS NOT NULL AS connected FROM email_mailboxes WHERE address=$1",[instanceSettings.mailbox]))[0]??null,
        emailPermissions:await query("SELECT e.id,e.name,e.role,COALESCE(p.can_read,e.role='CEO') AS can_read,COALESCE(p.can_send,e.role='CEO') AS can_send FROM employees e LEFT JOIN email_permissions p ON p.employee_id=e.id WHERE e.status='ACTIVE'"),
        emailQueueStatus:await emailQueueStatus(tx,this.now()),
      emailEntities:await query('SELECT e.*, (SELECT count(*)::integer FROM email_links l WHERE l.kind=e.kind AND l.entity_id=e.id) AS linked_messages FROM email_entities e ORDER BY e.kind,e.label LIMIT 100'),
      experimentEconomics:await experimentEconomics(tx),
      orders:await orderRegister(tx),
      backlog:await backlogItems(tx),
      backlogSchedules:await backlogScheduleStatus(tx,this),
      sandboxReady:this.sandboxReady,
      consultations:await consultations(tx,'owner'),
      followUps:await pendingFollowUps(tx),
      emailMessages:await query("SELECT id,direction,status,content->>'subject' AS subject,content->'from' AS sender,content->'to' AS recipients,content->'cc' AS cc_recipients,content->'bcc' AS bcc_recipients,thread_id,COALESCE(received_at,created_at) AS received_at,error FROM email_messages ORDER BY COALESCE(received_at,created_at) DESC,id DESC LIMIT 100"),
        hosting: this.hosting,
        deployments: await query('SELECT d.*,a.reservation,a.settled,a.max_cost,r.title FROM deployments d JOIN actions a ON a.id=d.action_id JOIN static_releases r ON r.id=d.release_id ORDER BY d.created_at DESC LIMIT 100'),
        staticReleases: await query('SELECT id,title,provider,site_id,content_hash,source_versions,author_id,created_at FROM static_releases ORDER BY created_at DESC LIMIT 100'),
        ceoCycle: (await query(`SELECT t.id,t.status,t.error,t.finished_at,
          EXISTS(SELECT 1 FROM events a WHERE a.entity_id=t.id AND a.type='company.ceo_cycle_acknowledged' AND a.created_at>=t.finished_at) AS acknowledged,
          EXISTS(SELECT 1 FROM calls c WHERE c.task_id=t.id AND c.status IN ${activeCalls}) AS unresolved
          FROM tasks t JOIN employees p ON p.id=t.employee_id AND p.role='CEO' AND p.status='ACTIVE'
          WHERE EXISTS(SELECT 1 FROM events e WHERE e.entity_id=t.id AND e.type='company.ceo_cycle_started')
          ORDER BY t.created_at DESC LIMIT 1`))[0] ?? null,
        metrics: {
          revenueUsd: formatUsd(amount("BUSINESS", "REVENUE")), refundsUsd: formatUsd(amount("BUSINESS", "REFUND")),
          businessCostsUsd: formatUsd(amount("BUSINESS", "COST")), operatingCostsUsd: formatUsd(amount("OPERATING", "COST")),
          contributionUsd: formatUsd(amount("BUSINESS", "REVENUE") - amount("BUSINESS", "REFUND") - amount("BUSINESS", "COST") - amount("OPERATING", "COST")),
          fundedUsd: formatUsd(amount("BUSINESS", "FUNDING")), availableCapitalUsd: formatUsd(business),
          reservedUsd: formatUsd(BigInt(holds.amount) + BigInt(smsHolds.amount) + BigInt(actionHolds.amount)), dailyUsedUsd: formatUsd(dailyUsed), dailyRemainingUsd: formatUsd(BigInt(company.daily_cap) - dailyUsed)
        },
        tasks: tasks.map((t): Row => ({ ...t, budgetUsd: formatUsd(t.budget), spentUsd: formatUsd(t.spent), reservedUsd: formatUsd(t.reserved) })),
        experiments: await query("SELECT * FROM experiments ORDER BY created_at DESC LIMIT 100"),
        actions: await query("SELECT * FROM actions ORDER BY created_at DESC LIMIT 100"),
        grants: await query("SELECT * FROM grants ORDER BY created_at DESC LIMIT 100"),
        requests: await query("SELECT * FROM owner_requests ORDER BY created_at DESC LIMIT 100"),
        calls: await query("SELECT id,task_id,phase,model_id,provider,is_live,status,reserved,settled,input_tokens,output_tokens,request_id,error,created_at,completed_at,usage->>'latencyMs' AS latency_ms FROM calls ORDER BY created_at DESC LIMIT 100"),
        modelStats: await query(`SELECT model_id,COUNT(*)::integer AS total,
          COUNT(*) FILTER(WHERE status='SUCCEEDED')::integer AS succeeded,
          COUNT(*) FILTER(WHERE status IN ('FAILED','UNCERTAIN'))::integer AS failed,
          COUNT(*) FILTER(WHERE settled IS NULL)::integer AS unsettled,
          COALESCE(SUM(input_tokens),0)::text AS input_tokens,COALESCE(SUM(output_tokens),0)::text AS output_tokens,
          COALESCE(SUM(settled),0)::text AS settled,
          COALESCE(SUM(reserved) FILTER(WHERE status IN ${activeCalls}),0)::text AS held,
          AVG((usage->>'latencyMs')::double precision) AS latency_ms,BOOL_OR(is_live) AS is_live
          FROM calls GROUP BY model_id`),
        modelOutcomes: await modelOutcomes(tx),
        experimentTotals: await query("SELECT experiment_id,kind,SUM(amount)::text AS amount FROM ledger WHERE experiment_id IS NOT NULL AND account<>'TEST' GROUP BY experiment_id,kind"),
        events: await query("SELECT * FROM events ORDER BY sequence DESC LIMIT 100"), ledger, daily,
        direction: await (async () => {
          const current = (await query("SELECT d.*,COALESCE(e.name,CASE WHEN d.set_by='owner' THEN 'Owner' ELSE d.set_by END) AS set_by_name FROM directions d LEFT JOIN employees e ON e.id=d.set_by WHERE d.superseded_at IS NULL AND d.mission_id=current_mission_id()"))[0];
          return current ? { ...current, scorecard: await directionScorecard(tx, current.created_at) } : null;
        })(),
        directions: await query("SELECT d.*,COALESCE(e.name,CASE WHEN d.set_by='owner' THEN 'Owner' ELSE d.set_by END) AS set_by_name FROM directions d LEFT JOIN employees e ON e.id=d.set_by ORDER BY d.created_at DESC LIMIT 20"),
        documents: await documentIndex(tx),
        records: await query("SELECT * FROM company_records WHERE NOT archived ORDER BY kind, created_at"),
        ownerProfile: (await query("SELECT payload FROM events WHERE type='owner.profile_updated' ORDER BY sequence DESC LIMIT 1"))[0]?.payload ?? null,
        departments: await query("SELECT * FROM departments ORDER BY name"),
        employees: await query("SELECT * FROM employees ORDER BY depth,created_at"),
        ownerMessages: await query("SELECT m.*,COALESCE(e.name,m.sender_id) AS sender_name,COALESCE(r.name,m.recipient_id) AS recipient_name,t.status AS task_status FROM messages m LEFT JOIN employees e ON e.id=m.sender_id LEFT JOIN employees r ON r.id=m.recipient_id LEFT JOIN tasks t ON t.id=m.task_id WHERE m.sender_id='owner' OR m.recipient_id='owner' ORDER BY m.created_at DESC,m.id DESC LIMIT 100"),
        messages: await query("SELECT m.*,COALESCE(e.name,m.sender_id) AS sender_name,COALESCE(r.name,m.recipient_id) AS recipient_name FROM messages m LEFT JOIN employees e ON e.id=m.sender_id LEFT JOIN employees r ON r.id=m.recipient_id ORDER BY m.created_at DESC LIMIT 100"),
        meetings: await query("SELECT * FROM meetings ORDER BY scheduled_at DESC LIMIT 100"),
        notifications: await query("SELECT n.id,n.action_id,n.code,n.status,n.error,n.created_at,n.reserved,n.settled,n.sent_at,a.status AS action_status,a.expires_at AS action_expires_at,a.action_type,a.target,a.rationale FROM notifications n LEFT JOIN actions a ON a.id=n.action_id ORDER BY n.created_at DESC LIMIT 100"),
        artifacts: await query("SELECT id,task_id,call_id,filename,media_type,sha256,created_at FROM task_artifacts ORDER BY created_at DESC LIMIT 200"),
        smsSetup: smsSetupStatus(),
        smsStatus: this.smsConfigured() ? (smsSetupStatus().replyEnabled ? "SMS configured with signed replies." : "SMS configured for notifications. Review proposals in the dashboard.") : "SMS setup incomplete. Configure provider credentials, phone numbers, and spending caps.",
        smsLimits: { maxCostUsd: process.env.HIVE_SMS_MAX_COST_USD ?? null, dailyCapUsd: process.env.HIVE_SMS_DAILY_CAP_USD ?? null },
        models: this.models.map(({ adapter, ...m }) => m), timestamp: this.now().toISOString()
      };
    });
  }
  async setStatus(status: "RUNNING" | "PAUSED" | "KILLED") {
    await this.db.transaction(async (tx) => {
      if (status === 'RUNNING') { const c = await one(tx, "SELECT * FROM company WHERE id=1"); this.model(c.ceo_model_id); }
      await tx.query("UPDATE company SET status=$1,revision=revision+1 WHERE id=1", [status]);
      await event(tx, `company.${status.toLowerCase()}`, "company", {}, "owner");
    });
  }
  async configure(input: { dailyCapUsd: string; liveCapUsd: string; capitalAllocationUsd: string }) {
    const daily = parseUsd(input.dailyCapUsd), live = parseUsd(input.liveCapUsd), capital = parseUsd(input.capitalAllocationUsd);
    await this.db.transaction(async (tx) => {
      await tx.query("UPDATE company SET daily_cap=$1,live_cap=$2,capital_allocation=$3,revision=revision+1 WHERE id=1", [daily.toString(), live.toString(), capital.toString()]);
      await event(tx, "company.budgets_updated", "company", input, "owner");
      // Recheck cost-cap blockers after an owner changes limits. Never release
      // uncertain holds, reset attempts, or revive expired/cancelled work.
      const requeued = await tx.query<Row>(`UPDATE tasks SET
        status=CASE phase WHEN 'PLAN' THEN 'PLAN_PENDING' WHEN 'WORK' THEN 'READY' ELSE 'REVIEW' END,
        error=NULL,updated_at=now()
        WHERE status='BLOCKED_BUDGET' AND expires_at>$1
        AND (error LIKE 'Daily operating cap%' OR error LIKE 'Lifetime live-test cap%' OR error LIKE 'Lifetime paid-model cap%')
        AND NOT EXISTS(SELECT 1 FROM calls WHERE task_id=tasks.id AND status IN ${activeCalls})
        RETURNING id`, [this.now()]);
      for (const task of requeued.rows) await event(tx,'task.budget_recheck_requested',task.id,{reason:'Owner updated company spending limits.'},'owner');
    });
  }
  smsConfigured() { return smsSetupStatus().configured; }
  async setApprovalPolicy(input: Record<string, boolean>) {
    if (input.smsEnabled && !this.smsConfigured()) throw new DomainError("SMS setup is incomplete. Configure provider credentials, phone numbers, and spending caps first.");
    await this.db.transaction(async (tx) => {
      await tx.query("UPDATE company SET approval_policy=approval_policy || $1::jsonb,revision=revision+1 WHERE id=1", [JSON.stringify(input)]);
      await event(tx, "company.approval_policy_updated", "company", input, "owner");
      if (input.modelCalls === false) {
        // A policy change removes only requests that have not been used for a call.
        // Held or uncertain calls retain their original authority and exposure.
        const obsolete = await tx.query<Row>(`UPDATE actions a SET status='CANCELLED'
          WHERE a.action_type='MODEL_CALL' AND a.status IN ('PENDING','APPROVED')
          AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.approval_action_id=a.id)
          RETURNING a.id`);
        for (const action of obsolete.rows) await event(tx,'action.cancelled',action.id,{reason:'Paid model call approval disabled by owner.'},'owner');
        const requeued = await tx.query<Row>(`UPDATE tasks t SET
          status=CASE phase WHEN 'PLAN' THEN 'PLAN_PENDING' WHEN 'REVIEW' THEN 'REVIEW' ELSE 'READY' END,
          error=NULL,updated_at=now()
          WHERE status='BLOCKED_APPROVAL' AND error='Owner approval required for this paid model call'
          AND expires_at>$1 AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.task_id=t.id AND c.status IN ('RESERVED','DISPATCHED','UNCERTAIN'))
          RETURNING id`,[this.now()]);
        for (const task of requeued.rows) await event(tx,'task.approval_recheck_requested',task.id,{reason:'Paid model call approval disabled by owner.'},'owner');
      }

    });
  }
  async queueNotification(tx: Tx, actionId: string) {
    await tx.query("INSERT INTO notifications(id,action_id,code) VALUES($1,$2,$3) ON CONFLICT(action_id) WHERE action_id IS NOT NULL DO NOTHING", [randomUUID(), actionId, randomBytes(5).toString("hex").toUpperCase()]);
  }
  async createTask(raw: unknown) {
    const input = taskInput.parse(raw); this.model(input.modelId);
    const id = randomUUID(), budget = parseUsd(input.budgetUsd);
    return this.db.transaction(async (tx) => {
      const company = await one(tx, "SELECT * FROM company WHERE id=1 FOR UPDATE");
      let depth = 0, root = id;
      const expires = new Date(this.now().getTime() + input.ttlMinutes * 60000);
      if (input.parentId) {
        const parent = await one(tx, "SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [input.parentId]);
        if (terminal.includes(parent.status) || new Date(parent.expires_at) <= this.now()) throw new DomainError("Parent task is no longer active.");
        depth = parent.depth + 1; root = parent.root_id;
        if (expires > new Date(parent.expires_at)) throw new DomainError("Child TTL cannot exceed parent TTL.");

      }
      if (depth > company.max_depth) throw new DomainError("Maximum delegation depth exceeded.");
      await tx.query(`INSERT INTO tasks(id,parent_id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id,employee_id)
        VALUES($1,$2,$3,$4,$5,$6,'PLAN_PENDING',$7,$8,$9,$10,$11,$12)`, [id, input.parentId ?? null, root, input.objective, input.role, depth, budget.toString(), input.tokenBudget, expires, input.modelId, null, input.employeeId ?? null]);
      if(input.experimentId)await linkTaskExperiment(tx,id,input.experimentId,'owner');
      await event(tx, "task.created", id, { objective: input.objective, parentId: input.parentId ?? null, modelId: input.modelId, budgetUsd: input.budgetUsd }, "owner");
      return { id };
    });
  }
  async resumeTokenEstimateBlocks(){
    await this.db.transaction(async tx=>{
      await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
      const rows=await tx.query<Row>(`UPDATE tasks t SET status=CASE phase WHEN 'PLAN' THEN 'PLAN_PENDING' WHEN 'REVIEW' THEN 'REVIEW' ELSE 'READY' END,error=NULL,updated_at=now()
       WHERE status='BLOCKED_BUDGET' AND expires_at>$1
       AND (error LIKE 'Task has % tokens remaining, which cannot fit its required context and an answer.%' OR error='Task token budget cannot cover the next maximum call.')
       AND NOT EXISTS(SELECT 1 FROM calls c WHERE c.task_id=t.id AND c.status IN ('RESERVED','DISPATCHED','UNCERTAIN')) RETURNING id`,[this.now()]);
      for(const row of rows.rows)await event(tx,'task.token_estimate_unblocked',row.id,{reason:'Token estimates no longer stop work. Monetary policy and per-call limits still apply.'});
    });
  }
  async taskExposure(tx: Tx, taskId: string) {
    const r = await one(tx, `SELECT COALESCE(SUM(COALESCE(settled,0)+CASE WHEN status IN ${activeCalls} THEN reserved ELSE 0 END),0)::text AS cost,
      COALESCE(SUM(CASE WHEN status IN ${activeCalls} OR (status='RECONCILED' AND (input_tokens IS NULL OR output_tokens IS NULL)) THEN token_reserved ELSE COALESCE(input_tokens,0)+COALESCE(output_tokens,0) END),0)::text AS tokens FROM calls WHERE task_id=$1`, [taskId]);
    return { cost: BigInt(r.cost), tokens: Number(r.tokens) };
  }
  async taskDetail(id:string) {
    return this.db.transaction(async tx=>{
      const task=await one(tx,'SELECT * FROM tasks WHERE id=$1',[id]);
      const query=async(sql:string)=>(await tx.query<Row>(sql,[id])).rows;
      const exposure=await this.taskExposure(tx,id);
      const money=await one(tx,`SELECT COALESCE(SUM(settled),0)::text AS settled,
        COALESCE(SUM(reserved) FILTER(WHERE status IN ${activeCalls}),0)::text AS held,COUNT(*)::integer AS calls FROM calls WHERE task_id=$1`,[id]);
      const allocated=await one(tx,'SELECT COALESCE(SUM(budget),0)::text AS money,COALESCE(SUM(token_budget),0)::text AS tokens,COUNT(*)::integer AS count FROM tasks WHERE parent_id=$1',[id]);
      const meetings=await one(tx,"SELECT COALESCE(SUM(budget),0)::text AS money,COALESCE(SUM(token_budget),0)::text AS tokens FROM meetings WHERE source_task_id=$1 AND status='SCHEDULED'",[id]);
      return {
        task:{...task,budgetUsd:formatUsd(task.budget),spentUsd:formatUsd(money.settled),reservedUsd:formatUsd(money.held)},
        allocation:{delegatedUsd:formatUsd(allocated.money),scheduledMeetingsUsd:formatUsd(meetings.money),
          remainingUsd:formatUsd(BigInt(task.budget)-exposure.cost-BigInt(allocated.money)-BigInt(meetings.money)),
          usedOrHeldTokens:exposure.tokens,delegatedTokens:Number(allocated.tokens),scheduledMeetingTokens:Number(meetings.tokens),
          remainingTokens:task.token_budget-exposure.tokens-Number(allocated.tokens)-Number(meetings.tokens)},
        parent:task.parent_id?(await tx.query<Row>('SELECT id,objective FROM tasks WHERE id=$1',[task.parent_id])).rows[0]:null,
        children:await query('SELECT id,objective,employee_id,status,parent_id FROM tasks WHERE parent_id=$1 ORDER BY created_at DESC LIMIT 100'),
        calls:await query('SELECT id,phase,model_id,status,settled,reserved,input_tokens,output_tokens,error,created_at FROM calls WHERE task_id=$1 ORDER BY created_at DESC LIMIT 100'),
        artifacts:await query('SELECT id,task_id,filename,sha256,created_at FROM task_artifacts WHERE task_id=$1 ORDER BY created_at DESC LIMIT 200'),
        counts:{children:allocated.count,calls:money.calls},
      };
    });
  }
  async cancelTask(id: string) {
    await this.db.transaction(async (tx) => {
      await one(tx, "SELECT id FROM company WHERE id=1 FOR UPDATE");
      await one(tx, "SELECT id FROM tasks WHERE id=$1", [id]);
      const changed = await tx.query<Row>(`WITH RECURSIVE branch AS (SELECT id FROM tasks WHERE id=$1 UNION ALL SELECT t.id FROM tasks t JOIN branch b ON t.parent_id=b.id)
        UPDATE tasks SET status='CANCELLED',updated_at=now() WHERE id IN (SELECT id FROM branch) AND (status NOT IN ('COMPLETED','CANCELLED','EXPIRED') OR (status='COMPLETED' AND NOT operations_applied)) RETURNING id`, [id]);
      for (const row of changed.rows) await event(tx, "task.cancelled", row.id, {}, "owner");
    });
  }
  /** Move legacy hidden-review assignments to the assigned agent's own self-check. */
  async migrateSelfChecks() {
    await this.db.transaction(async tx => {
      await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');
      const revisions=await tx.query<Row>(`UPDATE tasks t SET status='READY',phase='WORK',error=NULL,updated_at=now()
        WHERE status='FAILED' AND review->>'kind'='SELF' AND review->>'decision'='REVISE'
        AND error='Self-check requested REVISE; bounded revision attempts exhausted or blocked.' AND expires_at>$1
        AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.task_id=t.id AND c.status IN ('RESERVED','DISPATCHED','UNCERTAIN'))
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.entity_id=t.id AND e.type='company.ceo_cycle_acknowledged')
        AND NOT EXISTS (SELECT 1 FROM tasks newer JOIN events e ON e.entity_id=newer.id AND e.type='company.ceo_cycle_started'
          WHERE newer.employee_id=t.employee_id AND newer.created_at>t.created_at)
        RETURNING id`,[this.now()]);
      for(const task of revisions.rows)await event(tx,'task.revision_resumed',task.id,{reason:'Self-check revisions use task deadlines and configured spending controls.'});
      const tasks = await tx.query<Row>(`SELECT t.* FROM tasks t
        WHERE review_model_id IS NOT NULL AND expires_at>$1
        AND (status IN ('PLAN_PENDING','READY','REVIEW','BLOCKED_BUDGET','BLOCKED_APPROVAL')
          OR (status='FAILED' AND phase='REVIEW' AND error LIKE 'Model context is too small%'
            AND NOT EXISTS (SELECT 1 FROM events e WHERE e.entity_id=t.id AND e.type='company.ceo_cycle_acknowledged')
            AND NOT EXISTS (SELECT 1 FROM tasks newer JOIN events e ON e.entity_id=newer.id AND e.type='company.ceo_cycle_started'
              WHERE newer.employee_id=t.employee_id AND newer.created_at>t.created_at)))
        AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.task_id=t.id AND c.status IN ('RESERVED','DISPATCHED','UNCERTAIN'))
        FOR UPDATE`,[this.now()]);
      for (const task of tasks.rows) {
        if (task.phase === 'REVIEW') {
          const obsolete=await tx.query<Row>(`UPDATE actions a SET status='CANCELLED' WHERE task_id=$1
            AND action_type='MODEL_CALL' AND status IN ('PENDING','APPROVED')
            AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.approval_action_id=a.id) RETURNING id`,[task.id]);
          for (const action of obsolete.rows) await event(tx,'action.cancelled',action.id,{reason:'Hidden reviewer replaced by assigned agent self-check.'});
        }
        const requeue = task.phase === 'REVIEW' && (task.status === 'FAILED' || task.status === 'BLOCKED_BUDGET'
          || (task.status === 'BLOCKED_APPROVAL' && task.error === 'Owner approval required for this paid model call'));
        await tx.query('UPDATE tasks SET review_model_id=NULL,status=$2,error=$3,updated_at=now() WHERE id=$1',
          [task.id,requeue?'REVIEW':task.status,requeue?null:task.error]);
        await event(tx,'task.self_check_assigned',task.id,{employeeId:task.employee_id,modelId:task.model_id,previousReviewModelId:task.review_model_id});
      }
    });
  }
  async retryTask(id: string) {
    await this.db.transaction(async (tx) => {
      const task = await one(tx, "SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [id]);
      if (!["FAILED", "BLOCKED_BUDGET", "BLOCKED_APPROVAL"].includes(task.status)) throw new DomainError("Task is not retryable.");
      const held = await tx.query(`SELECT id FROM calls WHERE task_id=$1 AND status IN ${activeCalls}`, [id]);
      if (held.rows.length) throw new DomainError("Reconcile unresolved calls before retrying.");
      if (new Date(task.expires_at) <= this.now()) throw new DomainError("Task expired; create a new bounded task.");
      const status = task.phase === "PLAN" ? "PLAN_PENDING" : task.phase === "WORK" ? "READY" : "REVIEW";
      await tx.query("UPDATE tasks SET status=$2,error=NULL,finished_at=NULL,updated_at=now() WHERE id=$1", [id, status]);
      await event(tx, "task.retry_requested", id, {}, "owner");
    });
  }
  async createExperiment(raw: unknown) {
    const x = experimentInput.parse(raw), id = randomUUID();
    if (new Date(x.deadline) <= this.now()) throw new DomainError("Experiment deadline must be in the future.");
    await this.db.transaction(async (tx) => {
      await tx.query(`INSERT INTO experiments(id,task_id,title,status,hypothesis,customer,offer,channel,price,max_loss,success_criteria,kill_criteria,deadline)
        VALUES($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, x.taskId ?? null, x.title, x.hypothesis, x.customer, x.offer, x.channel, x.price, parseUsd(x.maxLossUsd).toString(), x.successCriteria, x.killCriteria, x.deadline]);
      await event(tx, "experiment.created", id, { title: x.title }, "owner");
    }); return { id };
  }
  async updateExperiment(id: string, status: string, note: string) {
    if (!["DRAFT", "VALIDATING", "DELIVERING", "REPEATING", "KILLED", "ARCHIVED"].includes(status)) throw new DomainError("Invalid experiment status.");
    await this.db.transaction(async (tx) => {
      await one(tx, "SELECT id FROM experiments WHERE id=$1", [id]);
      await tx.query("UPDATE experiments SET status=$2,evidence=evidence || $3::jsonb WHERE id=$1", [id, status, JSON.stringify([{ note, date: this.now().toISOString(), source: "owner" }])]);
      await event(tx, "experiment.updated", id, { status, note }, "owner");
    });
  }
  async createRequest(input: { title: string; details: string; experimentId?: string }) {
    const id = randomUUID(); await this.db.transaction(async (tx) => {
      await tx.query("INSERT INTO owner_requests(id,title,details,experiment_id) VALUES($1,$2,$3,$4)", [id, input.title, input.details, input.experimentId ?? null]);
      await event(tx, "owner.requested", id, input, "owner");
    }); return { id };
  }
  async resolveRequest(id: string, status: string, response: string, minutes: number) {
    await this.db.transaction(async (tx) => {
      const row = await one(tx, "SELECT * FROM owner_requests WHERE id=$1 FOR UPDATE", [id]);
      if (row.status !== "OPEN") throw new DomainError("Request already resolved.");
      await tx.query("UPDATE owner_requests SET status=$2,response=$3,minutes=$4 WHERE id=$1", [id, status, response, minutes]);
      await event(tx, "owner.request_resolved", id, { status, response, minutes }, "owner");
      const origin=(await tx.query<Row>("SELECT payload FROM events WHERE entity_id=$1 AND type='owner.requested' ORDER BY sequence LIMIT 1",[id])).rows[0]?.payload;
      const messageId=randomUUID(),recipient=origin?.requestedBy??'company';
      await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'owner',$2,'DECISION',$3,$4,$5)",
        [messageId,recipient,`${status==='DONE'?'Answered':'Declined'}: ${row.title}`.slice(0,250),`Owner request ${id}: ${status}\n${response}`,origin?.sourceTaskId??null]);
      await event(tx,'message.created',messageId,{senderId:'owner',recipientId:recipient,subject:row.title,kind:'DECISION'},'owner');
    });
  }
  async publishingBinding(tx:Tx,releaseId:string,target:string,mode:unknown,maxCostUsd:string){
    const publication=await staticPublication(tx,releaseId,target);
    if(mode===undefined||mode===null||mode==='OWNER_ASSISTED')return publication;
    if(mode!=='NETLIFY_AUTOMATIC')throw new DomainError('Unknown publishing execution mode.');
    if(!this.hosting.ready||this.hosting.siteId!==target)throw new DomainError('Automatic publishing is not configured for this site.');
    if(parseUsd(maxCostUsd)!==parseUsd(this.hosting.maxDeploymentUsd!))throw new DomainError('Use the configured maximum deployment charge for this proposal.');
    return {...publication,executionMode:'NETLIFY_AUTOMATIC'};
  }
  async createAction(raw: unknown) {
    const x = actionInput.parse(raw), id = randomUUID();
    if (new Date(x.expiresAt) <= this.now()) throw new DomainError("Action expiry must be in the future.");
    await this.db.transaction(async (tx) => {
      if(x.payload.releaseId!==undefined){
        if(x.actionType!=='PUBLISH')throw new DomainError('A prepared release can only be attached to a publishing proposal.');
        const publication=await this.publishingBinding(tx,String(x.payload.releaseId),x.target,x.payload.executionMode,x.maxCostUsd);
        for(const [key,value] of Object.entries(publication))if(x.payload[key]!==undefined && x.payload[key]!==value)throw new DomainError('Publishing details do not match the frozen release.');
        x.payload={...x.payload,...publication};
      }
      const hash = actionHash({ id, ...x, executorVersion: 1 });
      await tx.query(`INSERT INTO actions(id,task_id,experiment_id,action_type,target,payload,rationale,max_cost,expires_at,action_hash,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING')`, [id, x.taskId ?? null, x.experimentId ?? null, x.actionType, x.target, JSON.stringify(x.payload), x.rationale, parseUsd(x.maxCostUsd).toString(), x.expiresAt, hash]);
      await event(tx, "action.proposed", id, { actionType: x.actionType, target: x.target, maxCostUsd: x.maxCostUsd, hash }, "owner");
      await this.queueNotification(tx, id);
    }); return { id };
  }
  async approveAction(id: string, hash: string, decision: "APPROVE" | "REJECT", rationale: string) {
    await this.db.transaction(tx => this.approveActionInTransaction(tx, id, hash, decision, rationale));
  }
  async approveActionInTransaction(tx: Tx, id: string, hash: string, decision: "APPROVE" | "REJECT", rationale: string) {
    const row = await one(tx, "SELECT * FROM actions WHERE id=$1 FOR UPDATE", [id]);
    if (row.status !== "PENDING" || row.action_hash !== hash || new Date(row.expires_at) <= this.now()) throw new DomainError("Action changed, expired, or was already decided.");
    await tx.query("INSERT INTO approvals(id,action_id,action_hash,decision,rationale) VALUES($1,$2,$3,$4,$5)", [randomUUID(), id, hash, decision, rationale]);
    await tx.query("UPDATE actions SET status=$2 WHERE id=$1", [id, decision === "APPROVE" ? "APPROVED" : "REJECTED"]);
    if (row.action_type === "MODEL_CALL" && row.task_id) {
      const task = await one(tx, "SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [row.task_id]);
      if (task.status === "BLOCKED_APPROVAL") await tx.query("UPDATE tasks SET status=$2,error=$3 WHERE id=$1", [task.id, decision === "REJECT" ? "FAILED" : task.phase === "PLAN" ? "PLAN_PENDING" : task.phase === "WORK" ? "READY" : "REVIEW", decision === "REJECT" ? "Owner denied paid model call" : null]);
    }
    await event(tx, "action.decided", id, { decision, hash, rationale }, "owner");
    const source=row.task_id?(await tx.query<Row>('SELECT employee_id FROM tasks WHERE id=$1',[row.task_id])).rows[0]:null;
    const recipient=source?.employee_id??'company',messageId=randomUUID();
    const subject=`${decision==='APPROVE'?'Approved':'Rejected'}: ${row.action_type}`;
    await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'owner',$2,'DECISION',$3,$4,$5)",
      [messageId,recipient,subject,`Action ${id} for ${row.target}: ${decision}.\n${rationale}\n${decision==='APPROVE'?'Permission only. Execution and its receipt have not been confirmed by this decision.':'Do not execute this proposal. Address the owner’s reason before proposing an alternative.'}`,row.task_id]);
    await event(tx,'message.created',messageId,{senderId:'owner',recipientId:recipient,subject,kind:'DECISION'},'owner');
  }
  async createGrant(raw: unknown) {
    const x = grantInput.parse(raw), id = randomUUID();
    if (new Date(x.expiresAt) <= this.now() || parseUsd(x.maxTransactionUsd) > parseUsd(x.totalCapUsd)) throw new DomainError("Invalid grant expiry or transaction limit.");
    await this.db.transaction(async (tx) => {
      await tx.query("INSERT INTO grants(id,action_type,target,experiment_id,max_transaction,total_cap,expires_at,rationale) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, x.actionType, x.target, x.experimentId ?? null, parseUsd(x.maxTransactionUsd).toString(), parseUsd(x.totalCapUsd).toString(), x.expiresAt, x.rationale]);
      await event(tx, "grant.created", id, x, "owner");
    }); return { id };
  }
  async revokeGrant(id: string) {
    await this.db.transaction(async (tx) => { await one(tx, "SELECT id FROM grants WHERE id=$1", [id]); await tx.query("UPDATE grants SET revoked=true WHERE id=$1", [id]); await event(tx, "grant.revoked", id, {}, "owner"); });
  }
  async recordMoney(input: { kind: "FUNDING" | "REVENUE" | "COST" | "REFUND"; amountUsd: string; description: string; externalReference: string; experimentId?: string; idempotencyKey: string }) {
    const amount = parseUsd(input.amountUsd); if (amount === 0n) throw new DomainError("Amount must be positive.");
    return this.db.transaction(async (tx) => {
      const old = await tx.query<Row>("SELECT * FROM ledger WHERE idempotency_key=$1", [input.idempotencyKey]);
      if (old.rows.length) { const r = old.rows[0]; if (r.kind !== input.kind || BigInt(r.amount) !== amount || r.external_reference !== input.externalReference || r.experiment_id !== (input.experimentId ?? null)) throw new DomainError("Idempotency key already belongs to a different entry."); return { id: r.id }; }
      const id = randomUUID();
      await tx.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,experiment_id,description,external_reference) VALUES($1,$2,'BUSINESS',$3,$4,$5,$6,$7)", [id, input.idempotencyKey, input.kind, amount.toString(), input.experimentId ?? null, input.description, input.externalReference]);
      await event(tx, "ledger.recorded", id, { kind: input.kind, amountUsd: input.amountUsd, externalReference: input.externalReference }, "owner"); return { id };
    });
  }
  async cancelAction(id: string) {
    await this.db.transaction(async (tx) => {
      const action = await one(tx, "SELECT * FROM actions WHERE id=$1 FOR UPDATE", [id]);
      if (!['PENDING', 'APPROVED'].includes(action.status)) throw new DomainError('Only an unexecuted proposal or approval can be withdrawn.');
      await tx.query("UPDATE actions SET status='CANCELLED' WHERE id=$1", [id]);
      await tx.query("UPDATE notifications SET status='DISABLED' WHERE action_id=$1 AND status='PENDING'", [id]);
      if (action.action_type === 'MODEL_CALL' && action.task_id) await tx.query("UPDATE tasks SET status='FAILED',error='Owner withdrew model-call authority' WHERE id=$1 AND status='BLOCKED_APPROVAL'", [action.task_id]);
      await event(tx, 'action.cancelled', id, {}, 'owner');
    });
  }
  async expire() {
    await this.db.transaction(async (tx) => {
      const actions = await tx.query<Row>("UPDATE actions SET status='EXPIRED' WHERE status IN ('PENDING','APPROVED') AND expires_at<=$1 RETURNING id,task_id,action_type", [this.now()]);
      for (const a of actions.rows) {
        await tx.query("UPDATE notifications SET status='DISABLED' WHERE action_id=$1 AND status='PENDING'", [a.id]);
        if (a.action_type === 'MODEL_CALL' && a.task_id) await tx.query("UPDATE tasks SET status='FAILED',error='Model-call approval expired' WHERE id=$1 AND status='BLOCKED_APPROVAL'", [a.task_id]);
        await event(tx, 'action.expired', a.id);
      }
      const tasks = await tx.query<Row>("UPDATE tasks SET status='EXPIRED',updated_at=now() WHERE expires_at<=$1 AND status IN ('PLAN_PENDING','READY','REVIEW','BLOCKED_BUDGET','BLOCKED_APPROVAL') RETURNING id", [this.now()]);
      for (const t of tasks.rows) await event(tx, 'task.expired', t.id);
    });
  }
  async reconcileNotification(id: string, input: { amountUsd: string; externalReference: string; rationale: string }) {
    const cost = parseUsd(input.amountUsd);
    await this.db.transaction(async (tx) => {
      await one(tx, "SELECT * FROM company WHERE id=1 FOR UPDATE");
      const n = await one(tx, "SELECT * FROM notifications WHERE id=$1 FOR UPDATE", [id]);
      if (n.settled !== null) {
        const prior = await tx.query<Row>("SELECT * FROM ledger WHERE notification_id=$1", [id]);
        if (BigInt(n.settled) === cost && prior.rows[0]?.external_reference === input.externalReference) return;
        throw new DomainError('Notification already has a different settlement.');
      }
      if (!['UNCERTAIN', 'SENT'].includes(n.status)) throw new DomainError('Only dispatched notifications awaiting a confirmed charge can be reconciled.');
      await tx.query("UPDATE notifications SET settled=$2,error=NULL WHERE id=$1", [id, cost.toString()]);
      await tx.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,notification_id,description,external_reference) VALUES($1,$2,'OPERATING','COST',$3,$4,$5,$6)", [randomUUID(), `sms:${id}`, cost.toString(), id, input.rationale, input.externalReference]);
      if (cost > BigInt(n.reserved)) { await tx.query("UPDATE company SET status='PAUSED',revision=revision+1 WHERE id=1"); await event(tx, 'company.sms_bound_exceeded', 'company', { notificationId: id }); }
      await event(tx, 'notification.owner_reconciled', id, input, 'owner');
    });
  }
  async recordActionCompletion(id: string, input: { actualCostUsd: string; externalReference: string; resultNote: string }) {
    const cost = parseUsd(input.actualCostUsd);
    await this.db.transaction(async (tx) => {
      await one(tx,"SELECT id FROM company WHERE id=1 FOR UPDATE");
      const action = await one(tx, "SELECT * FROM actions WHERE id=$1 FOR UPDATE", [id]);
      if(action.payload?.integration==='business-email')throw new DomainError('Business email requires its provider receipt; manual completion cannot replace a send result.');
      if(action.payload?.executionMode==='NETLIFY_AUTOMATIC')throw new DomainError('Use deployment cost reconciliation for automatic publishing; owner-assisted completion cannot replace its provider result.');
      if (action.status === 'EXECUTED') {
        if (action.result?.execution === 'OWNER_ASSISTED' && action.result.externalReference === input.externalReference && action.result.resultNote === input.resultNote && BigInt(action.settled) === cost) return;
        throw new DomainError('This action already has a different completion record.');
      }
      if (!['APPROVED','EXPIRED','CANCELLED'].includes(action.status) || ['MODEL_CALL', 'SANDBOX_PURCHASE', 'READ_PUBLIC_PAGE'].includes(action.action_type)) throw new DomainError('Only a previously approved owner-assisted external action can be recorded here.');
      const approval = (await tx.query<Row>("SELECT * FROM approvals WHERE action_id=$1", [id])).rows[0];
      if (!approval || approval.decision !== 'APPROVE' || approval.action_hash !== action.action_hash) throw new DomainError('Completion is not bound to an approved proposal.');
      // This records an observed outside transaction; never hide a real overrun or late completion.
      const varianceReasons=[...(cost>BigInt(action.max_cost)?['COST_EXCEEDED']:[]),
        ...(new Date(action.expires_at)<=this.now()?['APPROVAL_EXPIRED']:[]),
        ...(action.status==='CANCELLED'?['APPROVAL_WITHDRAWN']:[])];
      await tx.query("UPDATE actions SET status='EXECUTED',settled=$2,result=$3 WHERE id=$1", [id, cost.toString(), JSON.stringify({ ...input, execution: 'OWNER_ASSISTED', authorizationStatusAtRecording: action.status, varianceReasons })]);
      await tx.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,action_id,task_id,experiment_id,description,external_reference) VALUES($1,$2,'BUSINESS','COST',$3,$4,$5,$6,$7,$8)", [randomUUID(), `owner-action:${id}`, cost.toString(), id, action.task_id, action.experiment_id, input.resultNote, input.externalReference]);
      if (varianceReasons.length) { await tx.query("UPDATE company SET status='PAUSED',revision=revision+1 WHERE id=1"); await event(tx, 'company.external_completion_variance', 'company', { actionId: id, costMicroUsd: cost.toString(), varianceReasons }); }
      await event(tx, 'action.owner_completed', id, input, 'owner');
      const source = action.task_id ? await one(tx, "SELECT employee_id FROM tasks WHERE id=$1", [action.task_id]) : null;
      await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'owner',$2,'DECISION',$3,$4,$5)", [randomUUID(), source?.employee_id ?? 'company', `Completed: ${action.action_type}`, `${input.resultNote}\nReceipt: ${input.externalReference}\nActual cost USD: ${input.actualCostUsd}`, action.task_id]);
    });
  }
  async executeSandbox(id: string) {
    return this.db.transaction(async (tx) => {
      const company = await one(tx, "SELECT * FROM company WHERE id=1 FOR UPDATE");
      if (company.status !== "RUNNING") throw new DomainError("Company must be running to dispatch actions.");
      const action = await one(tx, "SELECT * FROM actions WHERE id=$1 FOR UPDATE", [id]);
      if (action.status === "EXECUTED") return action.result;
      if (action.action_type !== "SANDBOX_PURCHASE") throw new DomainError("No live external executor is installed for this action. Approval alone does not execute it.");
      if (!["PENDING", "APPROVED"].includes(action.status) || new Date(action.expires_at) <= this.now()) throw new DomainError("Action is not executable.");
      let grantId: string | null = null;
      if (action.status !== "APPROVED") {
        if (action.revises_action_id || company.approval_policy.expenses !== false) throw new DomainError("Owner approval is required for every expense under the current policy.");
        const grants = await tx.query<Row>("SELECT * FROM grants WHERE action_type=$1 AND target=$2 AND (experiment_id IS NULL OR experiment_id=$3) AND NOT revoked AND expires_at>$4 ORDER BY created_at,id FOR UPDATE", [action.action_type, action.target, action.experiment_id, this.now()]);
        for (const grant of grants.rows) { const used = await one(tx, "SELECT COALESCE(SUM(COALESCE(settled,0)+reservation),0)::text AS amount FROM actions WHERE grant_id=$1", [grant.id]); if (BigInt(action.max_cost) <= BigInt(grant.max_transaction) && BigInt(action.max_cost) + BigInt(used.amount) <= BigInt(grant.total_cap)) { grantId = grant.id; break; } }
        if (!grantId) throw new DomainError("No matching active grant; approve the exact action first.");
      } else {
        const approval = await one(tx, "SELECT * FROM approvals WHERE action_id=$1", [id]);
        if (approval.decision !== "APPROVE" || approval.action_hash !== action.action_hash) throw new DomainError("Approval is not bound to this action.");
      }
      // The only installed executor is deterministic and has no external effects or real capital movement.
      const result = { sandbox: true, receipt: `fixture-${id}`, amountUsd: formatUsd(action.max_cost) };
      await tx.query("UPDATE actions SET status='EXECUTED',settled=max_cost,grant_id=$2,result=$3 WHERE id=$1", [id, grantId, JSON.stringify(result)]);
      await tx.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,action_id,description) VALUES($1,$2,'TEST','COST',$3,$4,'Sandbox fixture; no real money moved')", [randomUUID(), `action:${id}`, action.max_cost, id]);
      await event(tx, "action.sandbox_executed", id, result); return result;
    });
  }
}
