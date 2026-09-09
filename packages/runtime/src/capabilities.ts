import {one,type Tx,type Row} from './db.js';
import type {HiveService} from './service.js';
import {emailPermission} from './email.js';

/** Local configuration and permissions only; does not probe providers or expose credentials. */
export async function capabilityReport(tx:Pick<Tx,'query'>,service:HiveService,employeeId:string){
 await one(tx,"SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[employeeId]);
 const company=await one(tx,'SELECT status,approval_policy,max_depth,max_agents FROM company WHERE id=1');
 const mailbox=(await tx.query<Row>('SELECT enabled,credential_ciphertext IS NOT NULL AS connected FROM email_mailboxes LIMIT 1')).rows[0];
 return {
  runtimeStatus:company.status,approvalRequirements:company.approval_policy,
  modelConfigurations:{operations:['REGISTER_MODEL','CONFIGURE_MODEL','SET_MODEL'],connections:service.models.filter(m=>m.provider!=='mock'&&!m.connectionId).map(m=>({id:m.id,name:m.name,provider:m.provider})),models:service.models.filter(m=>m.provider!=='mock').map(m=>({id:m.id,name:m.name,model:m.model,connectionId:m.connectionId??m.id,ready:m.ready,live:m.live})),note:'Registration reuses an established connection and keeps credentials server-side. Pricing, approvals and spending caps apply; registration is not a provider test.'},
  internal:{
   planning:{available:true,operations:['CANCEL_ASSIGNED_WORK','SAVE_ORDER','READ_ORDER','SCHEDULE_BACKLOG_WORK','CANCEL_BACKLOG_SCHEDULE','READ_ACCOUNTING','READ_LEDGER_ENTRY','READ_BACKLOG','PLAN_WORK','START_BACKLOG_WORK','LINK_TASK_EXPERIMENT'],note:'Shared prioritized work with ownership, dependencies and explicit opportunity cost attribution. Planning does not execute work; scheduling uses normal task and authority controls.'},
   communication:{available:true,inTaskReads:['STAFF_FIND'],operations:['READ_CONSULTATIONS','MESSAGE','ESCALATION','REQUEST_REPLY','FIND_MESSAGES','READ_MESSAGE','MEETING'],note:'Any employee may communicate with another employee. STAFF_FIND searches active colleagues and workload counts beyond the roster preview. REQUEST_REPLY schedules work; MESSAGE alone does not.'},
   documents:{available:true,operations:['WRITE_DOCUMENT','READ_DOCUMENT','FIND_DOCUMENTS'],pdfExportAvailable:service.browserAvailable,note:'Shared versioned documents. PDF download in dashboard; BUSINESS_EMAIL_SEND documentAttachments with a .pdf filename renders and freezes that exact version. Text-only headings/lists/code; no images or external resources. Reads/exports do not grant send authority.'},
   python:{available:service.sandboxReady,operations:['RUN_PYTHON'],note:'Isolated Docker Python standard library, no network or host mounts. Copied workspace text inputs and bounded text outputs; no platform source access.'},
   workspace:{available:!!service.workspaces,operations:['WORKSPACE_COPY','WORKSPACE_WRITE','WORKSPACE_READ','WORKSPACE_LIST'],note:'Text files in private/shared business workspaces. Existing different content requires a new revision filename.'},
   records:{available:true,operations:['BUSINESS_ENTITY_SET','BUSINESS_ENTITY_FIND','READ_TASK_RESULT','READ_ACTION_RESULT']},
   delegation:{available:true,operations:['HIRE','ASSIGN_TASK','REQUEST_REPLY','FOLLOW_UP','CANCEL_FOLLOW_UP'],maxDepth:company.max_depth,maxEmployees:company.max_agents},
  },
  external:{
   publicPages:{adapterInstalled:true,operations:['READ_PUBLIC_PAGE'],note:'Public HTTPS text reads; exact action admission still checks authority and runtime. No login, cookies or arbitrary private-network access.'},
   renderedPages:{adapterInstalled:service.browserAvailable,operations:['READ_BROWSER_PAGE'],note:'Read-only rendered public pages. Not an interactive browser for clicking, forms, downloads or account login.'},
   email:{adapterInstalled:true,oauthConfigured:service.emailOAuthConfigured,mailboxConnected:!!mailbox?.connected,mailboxEnabled:!!mailbox?.enabled,canRead:await emailPermission(tx,employeeId,'can_read'),canSend:await emailPermission(tx,employeeId,'can_send'),operations:['BUSINESS_EMAIL_READ','IMPORT_EMAIL_ATTACHMENT','BUSINESS_EMAIL_SEND','BUSINESS_EMAIL_WITHDRAW','BUSINESS_EMAIL_ACCESS'],note:'Messages send through Hive from the business mailbox after policy and dispatch checks. Exact-hash workspaceAttachments can deliver own/shared text outputs, frozen before approval and downloadable for owner review. Do not contact Gmail or request provider secrets directly.'},
   publishing:{adapterConfigured:service.hosting.ready,enabled:service.hosting.enabled,siteId:service.hosting.siteId??null,missingConfiguration:service.hosting.missing,operations:['PREPARE_RELEASE','PROPOSE_EXTERNAL'],note:'Versioned static files to the configured Netlify site only; exact approval and hosting caps apply.'},
   otherActions:{proposalSupported:true,automaticExecutorInstalled:false,operations:['PROPOSE_EXTERNAL'],note:'Purchases, account creation, physical work and other unsupported actions may be proposed. Approval alone does not install an executor or prove execution.'},
  },
  unavailable:['General desktop/app control','Unrestricted host shell or code execution','Autonomous changes to platform source code'],
  note:'Configuration is not proof of provider reachability, current funds, commercial scope or authorization. No network checks were performed. Continue independent internal work while configuration or approvals are pending.',
 };
}
