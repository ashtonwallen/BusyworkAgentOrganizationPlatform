import {proposeOrderEmail} from '@hive/runtime';
import {saveOrder,readOrder} from '@hive/runtime';
import {cancelBacklogStart} from '@hive/runtime';
import {consultations} from '@hive/runtime';
import {linkTaskExperiment} from '@hive/runtime';
import {saveBacklog,startBacklog} from '@hive/runtime';
import {cachedEmailAttachment} from '@hive/runtime';
import {frozenEmailAttachment} from '@hive/runtime';
import {documentPdf} from '@hive/runtime';
import {cancelFollowUp} from '@hive/runtime';
import {readBusinessEmail} from '@hive/runtime';
import {saveBusinessEntity} from '@hive/runtime';
import {resetPreview} from '@hive/runtime';
import {emailQueueStatus,BusinessEmail,GmailOAuth,businessMailbox,emailDraftSchema,event,setEmailPermission} from '@hive/runtime';
import {createStaticRelease,reconcileDeploymentCost} from '@hive/runtime';
import { documentIndex, readDocument, writeDocument, documentInput, one } from '@hive/runtime';
import Fastify, { LogController } from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { createHash, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { DomainError, Organization, ToolGateway, ToolRegistry, publicPageTool, messageInput, meetingInput, ledgerCsv, type Candidate, type SmsService, type HiveService, type Worker, shortText, text, usd } from "@hive/runtime";

export interface AppOptions { resetBusiness?: (revision:number)=>Promise<unknown>; isResetting?:()=>boolean; service?: HiveService; email?:BusinessEmail; emailOAuth?:GmailOAuth; worker?: Worker; sms?: SmsService; ownerToken?: string; dashboardAuthDisabled?: boolean; dashboardRoot?: string; paymentInfoPath?: string; logger?: boolean }
const hash = (s: string) => createHash("sha256").update(s).digest();
export function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? true, bodyLimit: 256 * 1024,
    logController: new LogController({ disableRequestLogging: true })
  });
  const resetTokens=new Map<string,{revision:number;expires:number}>();
  const mutations=new Set<unknown>();
  app.addHook('onResponse',async request=>{mutations.delete(request);});
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; until: number }>();
  const service = options.service;
  if(service)service.emailOAuthConfigured=!!options.emailOAuth;
  app.setReplySerializer((payload) => JSON.stringify(payload, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  app.register(cookie);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer")
      .header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(options.isResetting?.())return reply.code(503).send({error:'Business reset in progress. Refresh shortly.'});
    if(!['GET','HEAD','OPTIONS'].includes(request.method)||request.url.startsWith('/email/oauth/callback'))mutations.add(request);
    const host = request.hostname;
    const smsHost = options.sms && request.url === '/webhooks/twilio' && request.method === 'POST' && host === new URL(options.sms.config.webhookUrl).hostname;
    if (!smsHost && !["localhost", "127.0.0.1", "[::1]"].includes(host)) return reply.code(403).send({ error: "Local access only." });
    const origin = request.headers.origin;
    if (origin) {
      let parsed: URL;
      try { parsed = new URL(origin); } catch { return reply.code(403).send({ error: "Invalid origin." }); }
      if (parsed.host !== request.headers.host || !["http:", "https:"].includes(parsed.protocol)) return reply.code(403).send({ error: "Cross-origin requests are not allowed." });
    }
    if (request.url.startsWith("/v1/")) reply.header("Cache-Control", "no-store");
  });
  function authenticated(request: { headers: Record<string, any>; cookies: Record<string, string | undefined> }) {
    if(options.dashboardAuthDisabled===true)return true;
    const bearer = request.headers.authorization;
    if (options.ownerToken && typeof bearer === "string" && bearer.startsWith("Bearer ") && timingSafeEqual(hash(bearer.slice(7)), hash(options.ownerToken))) return true;
    const session = request.cookies.hive_session;
    if (!session) return false;
    const expiry = sessions.get(session) ?? 0;
    if (expiry <= Date.now()) { sessions.delete(session); return false; }
    return true;
  }
  app.get('/email/oauth/callback',async(request,reply)=>{
    const q=request.query as Record<string,string>;
    if(!options.emailOAuth||typeof q.code!=='string'||typeof q.state!=='string'||q.state!==request.cookies.hive_email_oauth)return reply.code(400).type('text/plain').send('Mailbox connection was not confirmed. Start again from Hive Email.');
    reply.clearCookie('hive_email_oauth',{path:'/email/oauth/callback'});
    try{await options.emailOAuth.complete(q.code,q.state);return reply.redirect('/#email');}catch{return reply.code(400).type('text/plain').send('Mailbox connection failed. Confirm the Gmail API, OAuth scopes and account matching HIVE_BUSINESS_EMAIL, then restart connection from Busywork.');}
  });
  app.get("/health", async () => ({ ok: true, service: "hive-api", timestamp: new Date().toISOString() }));
  app.get("/v1/auth/status", async (request) => ({ authenticated: authenticated(request), configured: !!options.ownerToken, signInRequired: options.dashboardAuthDisabled!==true }));
  app.post("/v1/auth/login", async (request, reply) => {
    const body = z.object({ token: z.string().min(1).max(500) }).strict().parse(request.body);
    const key = request.ip, now = Date.now(); const prior = attempts.get(key);
    const count = prior && prior.until > now ? prior.count : 0;
    if (count >= 10) return reply.code(429).send({ error: "Too many attempts. Try again in one minute." });
    if (!options.ownerToken || !timingSafeEqual(hash(body.token), hash(options.ownerToken))) { attempts.set(key, { count: count + 1, until: prior && prior.until > now ? prior.until : now + 60000 }); return reply.code(401).send({ error: "Incorrect owner access key." }); }
    attempts.delete(key);
    for (const [id, expiry] of sessions) if (expiry <= now) sessions.delete(id);
    const session = randomBytes(32).toString("hex"); sessions.set(session, now + 12 * 3600000);
    reply.setCookie("hive_session", session, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 12 * 3600 });
    return { ok: true };
  });
  app.post("/v1/auth/logout", async (request, reply) => { if (request.cookies.hive_session) sessions.delete(request.cookies.hive_session); reply.clearCookie("hive_session", { path: "/" }); return { ok: true }; });
  if (options.sms) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      const result: Record<string, string> = Object.create(null); for (const [key, value] of new URLSearchParams(body as string)) { if (Object.hasOwn(result, key)) return done(new DomainError('Duplicate form field.', 400)); result[key] = value; } done(null, result);
    });
    app.post('/webhooks/twilio', async (request, reply) => {
      if (request.url !== '/webhooks/twilio') throw new DomainError('Invalid webhook URL.', 400);
      const params = z.record(z.string(), z.string()).parse(request.body);
      await options.sms!.receive(String(request.headers['x-twilio-signature'] ?? ''), params);
      return reply.type('text/xml').send('<Response></Response>');
    });
  }
  app.register(async (api) => {
    api.addHook("preHandler", async (request, reply) => {
      if (!authenticated(request)) return reply.code(401).send({ error: "Owner sign-in required." });
      if (!service) return reply.code(503).send({ error: "Persistent control plane is not initialized." });
    });
    const svc = () => service!;
    const id = (request: { params: unknown }) => z.object({ id: shortText }).parse(request.params).id;
    api.get("/company/state", async () => ({ ready: !!service, ...await svc().snapshot() }));
    api.get("/snapshot", async () => svc().snapshot());
    api.post('/email/connect',async(_request,reply)=>{if(!options.emailOAuth)throw new DomainError('Configure HIVE_GMAIL_CLIENT_ID and HIVE_GMAIL_CLIENT_SECRET on the server, then restart.');const url=options.emailOAuth.begin();reply.setCookie('hive_email_oauth',new URL(url).searchParams.get('state')!,{httpOnly:true,sameSite:'lax',path:'/email/oauth/callback',maxAge:600});return {url};});
    api.get('/email/history',async request=>{const {before,search}=z.object({before:shortText.optional(),search:z.string().max(250).default('')}).parse(request.query);return readBusinessEmail(svc().db,'owner','inbox',before,0,search);});
    api.get('/email/messages/:id/attachments/:index',async(request,reply)=>{const {id,index}=z.object({id:z.uuid(),index:z.coerce.number().int().min(0).max(99)}).parse(request.params);const message=await one(svc().db,'SELECT direction FROM email_messages WHERE id=$1',[id]);const attachment=message.direction==='INBOUND'?await cachedEmailAttachment(svc().db,'owner',id,index):await frozenEmailAttachment(svc().db,id,index);return reply.type(attachment.mimeType).header('Content-Disposition',`attachment; filename="${attachment.filename}"`).header('Cache-Control','no-store').send(attachment.content);});
    api.get('/email/messages/:id',async request=>{const message=await one(svc().db,'SELECT id,direction,status,provider_message_id,thread_id,rfc_message_id,content,received_at,error FROM email_messages WHERE id=$1',[id(request)]);return {...message,queueStatus:message.status==='QUEUED'?(await emailQueueStatus(svc().db,svc().now()))[message.id]:undefined,links:(await svc().db.query('SELECT kind,entity_id,source FROM email_links WHERE message_id=$1',[id(request)])).rows};});
    api.post('/email/proposals',{bodyLimit:1500000},async request=>{const x=z.object({requestId:z.uuid(),email:emailDraftSchema,order:z.object({id:z.uuid(),version:z.number().int().positive()}).optional()}).strict().parse(request.body);return svc().db.transaction(async tx=>{
      const message=await proposeOrderEmail(tx,x.email,'owner',undefined,x.requestId,svc().workspaces,x.order);
      return {id:message.id,actionId:message.action_id};});});
    api.post('/email/messages/:id/reconcile',async request=>{if(!options.email)throw new DomainError('Email provider is not configured.');return options.email.reconcileSend(id(request));});
    api.post('/email/sync',async()=>{if(!options.email)throw new DomainError('Email provider is not configured.');await options.email.sync();return {ok:true};});
    api.post('/email/settings',async request=>{const x=z.object({enabled:z.boolean(),dailySendLimit:z.number().int().min(1).max(2000)}).strict().parse(request.body);await svc().db.transaction(async tx=>{await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');await tx.query('UPDATE email_mailboxes SET enabled=$2,daily_send_limit=$3 WHERE address=$1',[businessMailbox,x.enabled,x.dailySendLimit]);await event(tx,'email.settings_updated',businessMailbox,x,'owner');});return {ok:true};});
    api.put('/email/permissions/:id',async request=>{const x=z.object({canRead:z.boolean(),canSend:z.boolean()}).strict().parse(request.body);await svc().db.transaction(tx=>setEmailPermission(tx,'owner',id(request),x));return {ok:true};});
    api.put('/email/entities',async request=>svc().db.transaction(tx=>saveBusinessEntity(tx,request.body,'owner')));
    api.get("/actions/:id",async request=>one(svc().db,"SELECT a.*,(SELECT row_to_json(r) FROM proposal_revisions r WHERE r.action_id=a.id) AS revision_request,EXISTS(SELECT 1 FROM approvals p WHERE p.action_id=a.id AND p.decision='APPROVE' AND p.action_hash=a.action_hash) AS has_matching_approval FROM actions a WHERE a.id=$1",[id(request)]));
    api.post('/workspaces/copy',async request=>{const x=z.object({employeeId:shortText,source:shortText,destination:shortText,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(request.body);return svc().db.transaction(async tx=>{await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');await one(tx,'SELECT id FROM employees WHERE id=$1',[x.employeeId]);if(!svc().workspaces)throw new DomainError('Workspace storage is not configured.');const result=await svc().workspaces!.copy(x.employeeId,x.source,x.destination,x.sha256);await event(tx,'workspace.copied',randomUUID(),result,'owner');return result;});});
    api.get('/workspaces',async request=>{const x=z.object({employeeId:shortText,scope:z.enum(['private','shared']).default('private'),path:z.string().optional()}).parse(request.query);await one(svc().db,'SELECT id FROM employees WHERE id=$1',[x.employeeId]);if(!svc().workspaces)throw new DomainError('Workspace storage is not configured.');return x.path?svc().workspaces!.read(x.employeeId,x.path,x.scope):svc().workspaces!.list(x.employeeId,x.scope);});
    api.get('/documents',async request => { const x=z.object({search:z.string().max(250).default('')}).parse(request.query); return documentIndex(svc().db,x.search); });
    api.get('/documents/export.pdf',async(request,reply)=>{
      const x=z.object({path:z.string(),version:z.coerce.number().int().positive()}).parse(request.query);
      const doc=await readDocument(svc().db,x.path,x.version);const content=await documentPdf(doc.title,doc.content);
      const filename=(doc.path.split('/').pop()||'document').replace(/[^a-zA-Z0-9_.-]/g,'_').replace(/\.[^.]+$/,'')+'.pdf';
      return reply.type('application/pdf').header('Content-Disposition',`attachment; filename="${filename}"`).header('Cache-Control','no-store').send(content);
    });
    api.get('/documents/read',async request => { const x=z.object({path:z.string(),version:z.coerce.number().int().positive().optional()}).parse(request.query); return readDocument(svc().db,x.path,x.version); });
    api.get('/documents/versions',async request => { const x=z.object({path:z.string()}).parse(request.query); return (await svc().db.query('SELECT v.version,v.title,v.author_id,v.created_at FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.path=$1 ORDER BY v.version DESC',[x.path])).rows; });
    api.put('/documents',async request => { const x=documentInput.parse(request.body); return svc().db.transaction(async tx=>{await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');return writeDocument(tx,x,'owner');}); });

    api.get('/deployments',async()=> (await svc().db.query('SELECT d.*,a.reservation,a.settled,a.max_cost FROM deployments d JOIN actions a ON a.id=d.action_id ORDER BY d.created_at DESC LIMIT 100')).rows);
    api.get('/deployments/:id',async request=>one(svc().db,'SELECT d.*,a.reservation,a.settled,a.max_cost,r.title FROM deployments d JOIN actions a ON a.id=d.action_id JOIN static_releases r ON r.id=d.release_id WHERE d.action_id=$1',[id(request)]));
    api.post('/deployments/:id/reconcile-cost',async request=>svc().db.transaction(tx=>reconcileDeploymentCost(tx,id(request),request.body)));
    api.get('/releases',async()=> (await svc().db.query('SELECT id,title,provider,site_id,content_hash,source_versions,author_id,task_id,created_at FROM static_releases ORDER BY created_at DESC LIMIT 100')).rows);
    api.get('/releases/:id',async request=>one(svc().db,'SELECT * FROM static_releases WHERE id=$1',[id(request)]));
    api.post('/releases',async request=>svc().db.transaction(async tx=>{await one(tx,'SELECT id FROM company WHERE id=1 FOR UPDATE');return createStaticRelease(tx,request.body,'owner');}));
    api.get('/ledger/view', async request => {
      const x=z.object({category:z.enum(['all','business','models']).default('all'),search:z.string().max(250).default(''),showZero:z.enum(['true','false']).default('false'),offset:z.coerce.number().int().min(0).default(0),model:z.string().max(250).optional(),day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).parse(request.query);
      const rows=(await svc().db.query(`WITH source AS (
        SELECT l.*,c.model_id,to_char(l.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day
        FROM ledger l LEFT JOIN calls c ON c.id=l.call_id
        WHERE ($1='all' OR ($1='business' AND l.call_id IS NULL) OR ($1='models' AND l.call_id IS NOT NULL))
        AND ($2='' OR strpos(lower(l.description || ' ' || coalesce(l.external_reference,'') || ' ' || coalesce(c.model_id,'')),lower($2))>0)
        AND ($3::boolean OR l.amount>0)
        AND ($4::text IS NULL OR c.model_id=$4)
        AND ($5::text IS NULL OR to_char(l.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD')=$5)
      ), grouped AS (
        SELECT min(id) AS id,model_id,day,'OPERATING'::text AS account,'COST'::text AS kind,
          sum(amount)::text AS amount,max(occurred_at) AS occurred_at,count(*)::int AS calls,
          model_id || ' model calls' AS description,NULL::text AS external_reference
        FROM source WHERE call_id IS NOT NULL AND $4::text IS NULL GROUP BY model_id,day
        UNION ALL
        SELECT id,model_id,day,account,kind,amount::text,occurred_at,0 AS calls,description,external_reference
        FROM source WHERE call_id IS NULL OR $4::text IS NOT NULL
      ) SELECT * FROM grouped ORDER BY occurred_at DESC,id DESC LIMIT 51 OFFSET $6`,[x.category,x.search,x.showZero==='true',x.model??null,x.day??null,x.offset])).rows;
      return {rows:rows.slice(0,50),hasMore:rows.length>50};
    });
    api.get('/exports/ledger.csv', async (request, reply) => reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="busywork-ledger.csv"').send(await ledgerCsv(svc(), request.query)));
    api.post('/company/reset/preview',async()=>{
      if(!options.resetBusiness)throw new DomainError('Reset is not configured on this server.');
      const preview=await resetPreview(svc());
      for(const [key,value] of resetTokens)if(value.expires<Date.now())resetTokens.delete(key);
      if(resetTokens.size>=20)resetTokens.clear();
      const token=randomBytes(24).toString('hex');resetTokens.set(token,{revision:preview.revision,expires:Date.now()+300000});
      return {...preview,token};
    });
    api.post('/company/reset',async request=>{
      const x=z.object({token:z.string(),phrase:z.literal('RESET BUSYWORK'),acknowledge:z.literal(true)}).strict().parse(request.body);
      const permit=resetTokens.get(x.token);
      if(!permit||permit.expires<Date.now())throw new DomainError('Reset confirmation expired. Review it again.');
      if(mutations.size>1)throw new DomainError('Another change is in progress. Wait for it to finish.');
      if(!options.resetBusiness)throw new DomainError('Reset is not configured.');
      resetTokens.delete(x.token);
      return options.resetBusiness(permit.revision);
    });
    api.post("/company/status", async (request) => { const x = z.object({ status: z.enum(["RUNNING", "PAUSED", "KILLED"]) }).strict().parse(request.body); await svc().setStatus(x.status); return { ok: true }; });
    api.put("/company/budgets", async (request) => { const x = z.object({ dailyCapUsd: usd, liveCapUsd: usd, capitalAllocationUsd: usd }).strict().parse(request.body); await svc().configure(x); return { ok: true }; });
    api.put("/company/approval-policy", async (request) => { const x = z.object({ expenses: z.boolean().optional(), modelCalls: z.boolean().optional(), communications: z.boolean().optional(), publishing: z.boolean().optional(), accounts: z.boolean().optional(), research: z.boolean().optional(), otherExternal: z.boolean().optional(), smsEnabled: z.boolean().optional() }).strict().parse(request.body); await svc().setApprovalPolicy(x); return { ok: true }; });
    api.put("/company/mandate", async (request) => { const x = z.object({ mandate: text, maxDepth: z.number().int().min(0).max(64), maxAgents: z.number().int().min(1).max(1000), maxConcurrency: z.number().int().min(1).max(32), ceoModelId: shortText, reviewModelId: shortText.optional(), cycleBudgetUsd: usd, cycleTokens: z.number().int().min(1000).max(1000000), cycleIntervalMinutes: z.number().int().min(1).max(10080) }).strict().parse(request.body); await new Organization(svc()).configure(x); return { ok: true }; });
    api.put("/company/direction", async (request) => { const x = z.object({ headline: shortText, statement: text }).strict().parse(request.body); await new Organization(svc()).ownerSetDirection(x); return { ok: true }; });
    api.delete("/company/direction", async () => { await new Organization(svc()).clearDirection(); return { ok: true }; });
    api.post("/messages", async (request) => { const x = messageInput.parse(request.body); return new Organization(svc()).message({ ...x, senderId: 'owner' }); });
    api.get('/orders/options',async()=>({customers:(await svc().db.query("SELECT id,label FROM email_entities WHERE kind='CUSTOMER' ORDER BY label LIMIT 500")).rows,receipts:(await svc().db.query("SELECT id,kind,amount::text AS amount,description FROM ledger WHERE account='BUSINESS' AND kind IN ('REVENUE','REFUND') ORDER BY occurred_at DESC LIMIT 500")).rows}));
    api.get('/orders/:id',async request=>svc().db.transaction(tx=>readOrder(tx,id(request),'owner')));
    api.put('/orders/:id',async request=>svc().db.transaction(tx=>saveOrder(tx,id(request),request.body,'owner')));
    api.get('/consultations',async request=>{const x=z.object({scope:z.enum(['open','all']).default('open'),before:shortText.optional()}).parse(request.query);return svc().db.transaction(tx=>consultations(tx,'owner',x.scope,x.before));});
    api.get('/conversations/history',async request=>{
      const {before}=z.object({before:shortText.optional()}).parse(request.query);
      const cursor=before?(await svc().db.query("SELECT id,created_at FROM messages WHERE id=$1 AND (sender_id='owner' OR recipient_id='owner')",[before])).rows[0] as {id:string;created_at:unknown}|undefined:undefined;
      if(before&&!cursor)throw new DomainError('Conversation cursor is unavailable.',404);
      const rows=(await svc().db.query(`SELECT m.*,COALESCE(e.name,m.sender_id) AS sender_name,COALESCE(r.name,m.recipient_id) AS recipient_name,t.status AS task_status
        FROM messages m LEFT JOIN employees e ON e.id=m.sender_id LEFT JOIN employees r ON r.id=m.recipient_id LEFT JOIN tasks t ON t.id=m.task_id
        WHERE (m.sender_id='owner' OR m.recipient_id='owner')
        AND ($1::text IS NULL OR (m.created_at,m.id)<(SELECT created_at,id FROM messages WHERE id=$1))
        ORDER BY m.created_at DESC,m.id DESC LIMIT 51`,[before??null])).rows;
      return {messages:rows.slice(0,50),hasMore:rows.length>50};
    });
    api.get('/conversations/:id',async request=>new Organization(svc()).conversationDetail(id(request)));
    api.post('/conversations', async request => new Organization(svc()).requestReply(request.body));
    api.post("/meetings", async (request) => { const x = meetingInput.parse(request.body); return new Organization(svc()).meeting({ ...x, organizerId: 'owner' }); });
    api.post('/meetings/:id/cancel', async (request) => { const x = z.object({ reason: text }).strict().parse(request.body); await new Organization(svc()).cancelMeeting(id(request), x.reason); return { ok: true }; });
    api.post('/backlog-schedules/:id/cancel',async request=>{await svc().db.transaction(tx=>cancelBacklogStart(tx,id(request),'owner','Cancelled by owner.'));return {ok:true};});
    api.put('/backlog/:id',async request=>svc().db.transaction(tx=>saveBacklog(tx,id(request),request.body,'owner')));
    api.post('/backlog/:id/start',async request=>svc().db.transaction(tx=>startBacklog(tx,svc(),id(request),'owner')));
    api.post('/follow-ups/:id/cancel',async request=>{const x=z.object({reason:text}).parse(request.body);await svc().db.transaction(tx=>cancelFollowUp(tx,id(request),'owner',x.reason));return {ok:true};});
    api.post("/tasks", async (request) => svc().createTask(request.body));
    api.put('/tasks/:id/experiment',async request=>{const x=z.object({experimentId:z.uuid().nullable()}).strict().parse(request.body);await svc().db.transaction(tx=>linkTaskExperiment(tx,id(request),x.experimentId,'owner'));return {ok:true};});
    api.get('/tasks/:id',async request=>svc().taskDetail(id(request)));
    api.post('/models',async request=>svc().createModelProfile(request.body));
    api.put('/models/:id', async request => svc().configureModel(id(request), request.body));
    api.post('/models/:id/test', async request => svc().createProviderTest(id(request)));
    api.put('/models/:id/spending-caps', async request => {
      const {enabled}=z.object({enabled:z.boolean()}).strict().parse(request.body);
      await svc().setModelSpendingCaps(id(request),enabled);
      return {ok:true};
    });
    api.put('/employees/:id/model', async request => {
      const x = z.object({modelId:shortText}).strict().parse(request.body);
      await new Organization(svc()).setEmployeeModel(id(request), x.modelId);
      return {ok:true};
    });
    api.put('/company/owner-profile', async request => {
      const profile = z.object({name:shortText,role:z.string().trim().max(250),background:z.string().trim().max(3000),availability:z.string().trim().max(1000),preferences:z.string().trim().max(2000),constraints:z.string().trim().max(2000)}).strict().parse(request.body);
      await svc().saveOwnerProfile(profile);
      return {ok:true};
    });
    api.post("/tasks/:id/cancel", async (request) => { await svc().cancelTask(id(request)); return { ok: true }; });
    api.post("/tasks/:id/retry", async (request) => { await svc().retryTask(id(request)); return { ok: true }; });
    api.post('/company/cycles/:id/acknowledge', async request => { const x = z.object({ reason: text }).strict().parse(request.body); await new Organization(svc()).acknowledgeCycleFailure(id(request), x.reason); return { ok: true }; });
    api.post("/worker/tick", async () => ({ worked: await options.worker?.runNext() ?? false }));
    api.post("/experiments", async (request) => svc().createExperiment(request.body));
    api.patch("/experiments/:id", async (request) => { const x = z.object({ status: shortText, note: text }).strict().parse(request.body); await svc().updateExperiment(id(request), x.status, x.note); return { ok: true }; });
    api.post("/requests", async (request) => svc().createRequest(z.object({ title: shortText, details: text, experimentId: shortText.optional() }).strict().parse(request.body)));
    api.post("/requests/:id/resolve", async (request) => { const x = z.object({ status: z.enum(["DONE", "DECLINED"]), response: text, minutes: z.number().int().min(0).max(100000) }).strict().parse(request.body); await svc().resolveRequest(id(request), x.status, x.response, x.minutes); return { ok: true }; });
    api.post("/actions", async (request) => svc().createAction(request.body));
    api.post('/actions/:id/request-changes', async request => { const x=z.object({hash:shortText,feedback:z.string().trim().min(1).max(10000)}).strict().parse(request.body); return new Organization(svc()).requestProposalChanges(id(request),x.hash,x.feedback); });
    api.post("/actions/:id/decision", async (request) => { const x = z.object({ hash: shortText, decision: z.enum(["APPROVE", "REJECT"]), rationale: text }).strict().parse(request.body); await svc().approveAction(id(request), x.hash, x.decision, x.rationale); return { ok: true }; });
    api.post("/actions/:id/execute", async (request) => { const action = (await svc().db.query<{ action_type: string }>("SELECT action_type FROM actions WHERE id=$1", [id(request)])).rows[0]; if (action?.action_type === 'SANDBOX_PURCHASE') return svc().executeSandbox(id(request)); return new ToolGateway(svc(), new ToolRegistry().register(publicPageTool)).execute(id(request)); });
    api.post('/actions/:id/record-completion', async (request) => { const x = z.object({ actualCostUsd: usd, externalReference: shortText, resultNote: text }).strict().parse(request.body); await svc().recordActionCompletion(id(request), x); return { ok: true }; });
    api.post('/actions/:id/cancel', async (request) => { await svc().cancelAction(id(request)); return { ok: true }; });
    api.post("/grants", async (request) => svc().createGrant(request.body));
    api.post("/grants/:id/revoke", async (request) => { await svc().revokeGrant(id(request)); return { ok: true }; });
    api.post("/ledger", async (request) => svc().recordMoney(z.object({ kind: z.enum(["FUNDING", "REVENUE", "COST", "REFUND"]), amountUsd: usd, description: text, externalReference: shortText, experimentId: shortText.optional(), idempotencyKey: shortText }).strict().parse(request.body)));
    api.post("/calls/:id/reconcile", async (request) => { const x = z.object({ amountUsd: usd, rationale: text }).strict().parse(request.body); if (!options.worker) throw new DomainError("Worker unavailable."); await options.worker.reconcile(id(request), x.amountUsd, x.rationale); return { ok: true }; });
    api.post('/notifications/:id/reconcile', async (request) => { const x = z.object({ amountUsd: usd, externalReference: shortText, rationale: text }).strict().parse(request.body); await svc().reconcileNotification(id(request), x); return { ok: true }; });
    api.get("/events", async (request) => { const x = z.object({ after: z.coerce.number().int().min(0).optional(), before: z.coerce.number().int().min(1).optional() }).parse(request.query); if (x.before) return (await svc().db.query("SELECT * FROM events WHERE sequence<$1 ORDER BY sequence DESC LIMIT 100", [x.before])).rows; return (await svc().db.query("SELECT * FROM events WHERE sequence>$1 ORDER BY sequence LIMIT 200", [x.after ?? 0])).rows; });
    api.get("/artifacts/:id/download", async (request, reply) => { const result = await svc().db.query<{ filename: string; content: string }>('SELECT filename,content FROM task_artifacts WHERE id=$1', [id(request)]); const file = result.rows[0]; if (!file) return reply.code(404).send({ error: 'Artifact not found.' }); return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="${file.filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}"`).send(file.content); });
    api.post("/company/records",async(request)=>svc().createRecord(request.body));
    api.put("/company/records/:id",async(request)=>{await svc().updateRecord(id(request),request.body);return{ok:true};});
    api.delete("/company/records/:id",async(request)=>{await svc().archiveRecord(id(request));return{ok:true};});
    api.get("/company/candidates",async request=>{
      const {taskId}=z.object({taskId:shortText.optional()}).parse(request.query);
      const taken=await svc().db.query<{candidate_id:string}>("SELECT candidate_id FROM employees WHERE candidate_id IS NOT NULL");
      const used=new Set(taken.rows.map(r=>r.candidate_id));
      const searches=await svc().db.query<{payload:{candidates:Candidate[]}}>("SELECT e.payload FROM events e JOIN tasks t ON t.id=e.entity_id WHERE e.type='recruitment.generated' AND (($1::text IS NOT NULL AND t.id=$1) OR ($1::text IS NULL AND t.status NOT IN ('COMPLETED','FAILED','CANCELLED','EXPIRED'))) ORDER BY e.sequence DESC LIMIT 12",[taskId??null]);
      const generated=searches.rows.flatMap(r=>r.payload.candidates);
      return generated.map(c=>({...c,hired:used.has(c.id)}));
    });
    api.get("/company/payment-info", async () => {
      let content = "";
      try {
        const p = options.paymentInfoPath ?? (options.dashboardRoot ? resolve(options.dashboardRoot, "../../../Payment_Info_Venmo_Crypto.txt") : resolve("Payment_Info_Venmo_Crypto.txt"));
        content = await readFile(p, "utf8");
      } catch { /* optional file */ }
      const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const items: { label: string; value: string; tag?: string; type: string }[] = [];
      for (const line of lines) {
        const match = line.match(/^([^:]+):\s*(.+)$/);
        if (!match) continue;
        let label = match[1].trim();
        const value = match[2].trim();
        let tag: string | undefined;
        const tagMatch = label.match(/\(([^)]+)\)/);
        if (tagMatch) {
          tag = tagMatch[1];
          label = label.replace(/\s*\([^)]+\)/, "").trim();
        }
        // Read only supported receiving identifiers; never return arbitrary notes or secrets.
        if (!['bitcoin', 'ethereum', 'solana', 'base', 'venmo'].includes(label.toLowerCase())) continue;
        if (/^(coming later|todo|pending)$/i.test(value)) continue;
        const isCrypto = ["bitcoin", "ethereum", "solana", "base"].some((c) => label.toLowerCase().includes(c));
        const isVenmo = label.toLowerCase().includes("venmo");
        const type = isCrypto ? "crypto" : isVenmo ? "venmo" : "other";
        items.push({ label, value, tag, type });
      }
      return { items };
    });
    api.get("/board-packet", async () => { const s = await svc().snapshot(); return { generatedAt: s.timestamp, metrics: s.metrics, activeExperiments: s.experiments.filter(e => !["KILLED", "ARCHIVED"].includes(e.status)), openRequests: s.requests.filter(r => r.status === "OPEN"), blockedTasks: s.tasks.filter(t => t.status.startsWith("BLOCKED") || t.status === "FAILED"), note: "Deterministic operating summary. Review evidence before allocating capital." }; });
  }, { prefix: "/v1" });
  if (options.dashboardRoot) app.register(staticFiles, { root: options.dashboardRoot, prefix: "/", index: "index.html" });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "Check the submitted fields.", issues: error.issues.map(i => ({ path: i.path, message: i.message })) });
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof Error && error.message === "Record not found.") return reply.code(404).send({ error: "Record not found." });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: "Invalid request." });
    request.log.error({ code: (error as { code?: string }).code ?? "INTERNAL" }, "Request failed");
    return reply.code(500).send({ error: "The operation could not be completed. No partial transaction was committed." });
  });
  return app;
}
