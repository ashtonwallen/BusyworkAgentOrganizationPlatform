import {cancelAssignedWork} from './task-cancellation.js';
import {currentMission,proposeDepartment} from './missions.js';
import {missionAdmission,checkMissionStall,requestMissionCompletion} from './mission-lifecycle.js';
import {readBacklog} from './backlog.js';
import {withdrawOwnEmail} from './email-withdraw.js';
import {proposeOrderEmail} from './order-email.js';
import {saveOrder,readOrder} from './orders.js';
import {scheduleBacklog,cancelBacklogStart,runBacklogSchedules} from './backlog-scheduling.js';
import {consultations} from './consultations.js';
import {readAccounting,readLedgerEntry} from './accounting-history.js';
import {linkTaskExperiment} from './experiment-economics.js';
import {backlogItems,saveBacklog,startBacklog} from './backlog.js';
import {importEmailAttachment} from './email-attachments.js';
import {runSandbox} from './sandbox.js';
import {scheduleFollowUp,cancelFollowUp,runFollowUps} from './follow-ups.js';
import {readBusinessEmail} from './email-history.js';
import {capabilityReport} from './capabilities.js';
import {readActionResult} from './action-results.js';
import {findMessages,readMessage} from './message-history.js';
import {reconcileLocalCall} from './call-reconciliation.js';
import {saveBusinessEntity} from './business-entities.js';
import {readTaskResult} from './task-results.js';
import {emailPermission,setEmailPermission} from './email.js';
import {createStaticRelease} from './releases.js';
import { documentIndex, readDocument, writeDocument } from './documents.js';
import { createHash, randomUUID } from "node:crypto";
import { parseUsd } from "@hive/core";
import { z } from "zod";
import { artifactSchema, commercialArtifactSchema, conversationArtifactSchema, formatUsd, shortText, text, timestamp, usd } from "./contracts.js";
import { event, one, type Row, type Tx } from "./db.js";
import { actionHash, activeCalls, directionScorecard, DomainError, HiveService } from "./service.js";
import { availableCandidates, shortlist, recruitCandidates, recruitedForTask } from "./personas.js";

export const messageInput = z.object({ senderId: shortText.default("owner"), recipientId: shortText, subject: shortText, body: text, kind: z.enum(["MESSAGE", "ESCALATION", "REQUEST", "DECISION"]).default("MESSAGE") }).strict();
export const conversationInput = z.object({ requestId:z.uuid(), recipientId:shortText, subject:shortText,
  body:z.string().trim().min(1).max(10000), budgetUsd:usd,
  tokenBudget:z.number().int().min(1000).max(1000000) }).strict();
export const meetingInput = z.object({ organizerId: shortText.default("owner"), title: shortText, objective: text, participants: z.array(shortText).min(1).max(20), scheduledAt: timestamp, budgetUsd: usd, tokenBudget: z.number().int().min(1000).max(1000000).default(180000) }).strict();

export const ceoDelegationGuidance = 'Lead strategically and delegate execution. Normally maintain at least one useful subordinate: if the active roster has no subordinate and internal hiring is permitted, use HIRE for a bounded real assignment rather than doing every step yourself. Choose a capable ready local model first when it fits the work; local inference still consumes context, time and capacity. Reuse existing staff before expanding headcount. Give clear outcomes and acceptance criteria, then review delegated results when useful. Do not hire merely to fill a quota or duplicate completed work; explain a concrete reason when remaining solo. Respect current owner instructions, model availability, configured headcount/depth limits and approval policy. This preference does not authorize external activity.';

export class Organization {
  constructor(readonly service: HiveService) { }
  /** Owner-directed hot swap. Reserved calls retain their captured model and prices. */
  async setEmployeeModel(employeeId: string, modelId: string) {
    await this.service.db.transaction(async tx => {
      await one(tx, 'SELECT id FROM company WHERE id=1 FOR UPDATE');
      const employee = await one(tx, "SELECT * FROM employees WHERE id=$1 AND status='ACTIVE' FOR UPDATE", [employeeId]);
      const model = this.service.models.find(m => m.id === modelId && (m.ready || (m.live && m.model && m.credentialsConfigured)));
      if (!model) throw new DomainError('Configure the model ID and API key before assigning it.');
      if (employee.model_id === model.id) return;
      await tx.query('UPDATE employees SET model_id=$2 WHERE id=$1', [employeeId, model.id]);
      if (employee.role === 'CEO') await tx.query('UPDATE company SET ceo_model_id=$1,revision=revision+1 WHERE id=1', [model.id]);
      const tasks = await tx.query<Row>(`UPDATE tasks SET model_id=$2,updated_at=now() WHERE employee_id=$1
        AND (status NOT IN ('COMPLETED','CANCELLED','EXPIRED','FAILED') OR (status='FAILED' AND error LIKE 'Model context is too small%')) RETURNING id,phase,status`, [employeeId, model.id]);
      for (const task of tasks.rows) {
        // Self-checks use this employee's model too.
        const held = await tx.query(`SELECT id FROM calls WHERE task_id=$1 AND status IN ${activeCalls}`, [task.id]);
        if (held.rows.length) continue;
        const obsolete = await tx.query<Row>("UPDATE actions SET status='CANCELLED' WHERE task_id=$1 AND action_type='MODEL_CALL' AND status IN ('PENDING','APPROVED') RETURNING id", [task.id]);
        for (const action of obsolete.rows) await event(tx, 'action.cancelled', action.id, { reason:'Worker model changed before dispatch.' }, 'owner');
        if (['BLOCKED_BUDGET', 'BLOCKED_APPROVAL', 'FAILED'].includes(task.status)) {
          await tx.query("UPDATE tasks SET status=$2,error=NULL,finished_at=NULL WHERE id=$1", [task.id, task.phase === 'PLAN' ? 'PLAN_PENDING' : task.phase === 'REVIEW' ? 'REVIEW' : 'READY']);
        }
      }
      await event(tx, 'employee.model_changed', employeeId, { previousModelId:employee.model_id, modelId:model.id, queuedTasks:tasks.rows.length, effective:'next unreserved call' }, 'owner');
    });
  }
  async requestProposalChanges(id:string, hash:string, feedback:string) {
    feedback=z.string().trim().min(1,'Describe the changes you need.').max(10000).parse(feedback);
    return this.service.db.transaction(async tx=>{
      const company=await one(tx,'SELECT * FROM company WHERE id=1 FOR UPDATE');
      const action=await one(tx,'SELECT * FROM actions WHERE id=$1 FOR UPDATE',[id]);
      const previous=(await tx.query<Row>('SELECT * FROM proposal_revisions WHERE action_id=$1',[id])).rows[0];
      if(previous){if(previous.action_hash!==hash || previous.feedback!==feedback)throw new DomainError('Changes were already requested for this proposal.');return {taskId:previous.task_id};}
      if(action.status!=='PENDING' || action.action_hash!==hash || new Date(action.expires_at)<=this.service.now())throw new DomainError('Action changed, expired, or was already decided.');
      if(action.action_type==='MODEL_CALL')throw new DomainError('Change the worker model or task settings instead of revising a generated model call.');
      if(company.status==='KILLED')throw new DomainError('Reset the company status before requesting revision work.');
      const source=action.task_id?(await tx.query<Row>('SELECT * FROM tasks WHERE id=$1',[action.task_id])).rows[0]:null;
      const author=source?.employee_id ?? action.payload?.proposedBy;
      const employee=(author?(await tx.query<Row>("SELECT * FROM employees WHERE id=$1 AND status='ACTIVE'",[author])).rows[0]:null) ?? await this.ensureCEO(tx);
      const model=this.service.model(employee.role==='CEO'?company.ceo_model_id:employee.model_id);
      const taskId=randomUUID();
      const objective=`Revise proposal ${id} in response to the owner's feedback. Prepare and submit a NEW proposal using the appropriate structured proposal operation (BUSINESS_EMAIL_SEND for email). Do not execute the original. The revised external action requires fresh owner approval. Preserve its business associations and threading when applicable. This is internal revision work only; do not broaden scope or perform research/outreach to revise it. If the feedback cannot be satisfied, explain the obstacle to the owner.\nOwner feedback: ${feedback}\nOriginal proposal: ${JSON.stringify({type:action.action_type,target:action.target,rationale:action.rationale,payload:action.payload,experimentId:action.experiment_id})}`;
      await tx.query(`INSERT INTO tasks(id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id,employee_id)
        VALUES($1,$1,$2,$3,0,'PLAN_PENDING',$4,$5,$6,$7,NULL,$8)`,[taskId,objective,employee.role,company.cycle_budget,company.cycle_tokens,new Date(this.service.now().getTime()+86400000),model.id,employee.id]);
      await tx.query('INSERT INTO proposal_revisions(action_id,task_id,feedback,action_hash) VALUES($1,$2,$3,$4)',[id,taskId,feedback,hash]);
      await tx.query("UPDATE actions SET status='CANCELLED' WHERE id=$1",[id]);
      await tx.query("UPDATE notifications SET status='DISABLED' WHERE action_id=$1 AND status='PENDING'",[id]);
      await event(tx,'action.changes_requested',id,{taskId,feedback,hash,employeeId:employee.id},'owner');
      const messageId=randomUUID();
      await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'owner',$2,'REQUEST',$3,$4,$5)",[messageId,employee.id,'Changes requested: '+action.rationale,`Revise proposal ${id}. ${feedback}\nRevision task: ${taskId}. The original is withdrawn; submit a new proposal for approval.`,taskId]);
      await event(tx,'message.created',messageId,{senderId:'owner',recipientId:employee.id,subject:'Proposal changes requested',kind:'REQUEST'},'owner');
      return {taskId};
    });
  }
  async conversationDetail(recipientId:string) {
    const employee=(await this.service.db.query<Row>(recipientId==='ceo' ? "SELECT * FROM employees WHERE role='CEO' AND status='ACTIVE' LIMIT 1" : "SELECT * FROM employees WHERE id=$1",recipientId==='ceo'?[]:[recipientId])).rows[0];
    if(!employee){if(recipientId==='ceo')return {employee:null,messages:[]};throw new DomainError('Employee not found.');}
    const messages=(await this.service.db.query<Row>(`SELECT m.*,t.status AS task_status,t.error AS task_error FROM messages m LEFT JOIN tasks t ON t.id=m.task_id WHERE (m.sender_id='owner' AND m.recipient_id=$1) OR (m.sender_id=$1 AND m.recipient_id='owner') ORDER BY m.created_at DESC,m.id DESC LIMIT 200`,[employee.id])).rows.reverse();
    return {employee,messages};
  }
  async requestReply(raw:unknown) {
    const x=conversationInput.parse(raw);
    return this.service.db.transaction(async tx=>{
      const company=await one(tx,'SELECT * FROM company WHERE id=1 FOR UPDATE');
      const prior=(await tx.query<Row>("SELECT payload FROM events WHERE entity_id=$1 AND type='conversation.reply_requested'",[x.requestId])).rows[0];
      if(prior){if(prior.payload.fingerprint!==actionHash(x))throw new DomainError('This conversation request ID was already used with different content.');return {taskId:x.requestId};}
      if(company.status==='KILLED')throw new DomainError('The company is killed. Reset its status before requesting work.');
      const employee=x.recipientId==='ceo'?await this.ensureCEO(tx):await one(tx,"SELECT * FROM employees WHERE id=$1 AND status='ACTIVE'",[x.recipientId]);
      const model=this.service.model(employee.role==='CEO'?company.ceo_model_id:employee.model_id);
      const objective=`Reply directly to the owner about: ${x.subject}\n${x.body}\nPut your answer in the artifact summary. Address the question, distinguish evidence from uncertainty, and avoid inventing commercial details that are irrelevant. Any operating steps remain subject to normal authority. Keep the response concise.`;
      await tx.query(`INSERT INTO tasks(id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id,employee_id)
        VALUES($1,$1,$2,$3,0,'PLAN_PENDING',$4,$5,$6,$7,$8,$9)`,[x.requestId,objective,employee.role,parseUsd(x.budgetUsd).toString(),x.tokenBudget,new Date(this.service.now().getTime()+24*3600000),model.id,null,employee.id]);
      const messageId=randomUUID();
      await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'owner',$2,'REQUEST',$3,$4,$5)",[messageId,employee.id,x.subject,x.body,x.requestId]);
      await event(tx,'conversation.reply_requested',x.requestId,{fingerprint:actionHash(x),employeeId:employee.id,messageId},'owner');
      await event(tx,'message.created',messageId,{senderId:'owner',recipientId:employee.id,subject:x.subject,kind:'REQUEST'},'owner');
      return {taskId:x.requestId};
    });
  }
  async acknowledgeCycleFailure(id: string, reason: string) {
    reason = text.parse(reason).trim();
    if (!reason) throw new DomainError('Record a recovery reason.');
    await this.service.db.transaction(async tx => {
      await one(tx, 'SELECT id FROM company WHERE id=1 FOR UPDATE');
      const task = await one(tx, `SELECT t.* FROM tasks t
        JOIN employees p ON p.id=t.employee_id AND p.role='CEO' AND p.status='ACTIVE'
        WHERE t.id=$1 AND EXISTS(SELECT 1 FROM events e WHERE e.entity_id=t.id AND e.type='company.ceo_cycle_started')
        FOR UPDATE OF t`, [id]);
      if (!['FAILED', 'EXPIRED'].includes(task.status)) throw new DomainError('Only failed or expired CEO cycles can be acknowledged.');
      const held = await tx.query(`SELECT id FROM calls WHERE task_id=$1 AND status IN ${activeCalls}`, [id]);
      if (held.rows.length) throw new DomainError('Reconcile unresolved calls before acknowledging this cycle.');
      const prior = await tx.query(`SELECT sequence FROM events WHERE entity_id=$1 AND type='company.ceo_cycle_acknowledged' AND created_at >= (SELECT finished_at FROM tasks WHERE id=$1)`, [id]);
      if (prior.rows.length) return;
      await event(tx, 'company.ceo_cycle_acknowledged', id, { reason, status: task.status }, 'owner');
    });
  }
  async ensureCEO(tx: Tx) {
    const company = await one(tx, "SELECT * FROM company WHERE id=1 FOR UPDATE");
    const existing = await tx.query<Row>("SELECT * FROM employees WHERE role='CEO' AND status='ACTIVE'");
    if (existing.rows.length) return existing.rows[0];
    this.service.model(company.ceo_model_id);
    const id = randomUUID();
    const available = await availableCandidates(tx, this.service.candidates);
    const chief = available.find((c) => /chief executive/i.test(c.archetype)) ?? available[0];
    await tx.query(
      "INSERT INTO employees(id,name,role,department_id,depth,charter,model_id,candidate_id,bio,traits) VALUES($1,$2,'CEO','executive',0,$3,$4,$5,$6,$7)",
      [id, chief?.name ?? 'Chief Executive', company.mandate, company.ceo_model_id,
        chief?.id ?? null, chief?.bio ?? null, chief ? JSON.stringify(chief.traits) : null]);
    await event(tx, "employee.ceo_created", id, { modelId: company.ceo_model_id, name: chief?.name, candidateId: chief?.id });
    return one(tx, "SELECT * FROM employees WHERE id=$1", [id]);
  }
  async notifyConsultationOutcomes() {
    await this.service.db.transaction(async tx=>{
      const company=await one(tx,'SELECT status FROM company WHERE id=1 FOR UPDATE');
      if(company.status==='KILLED')return;
      const rows=(await tx.query<Row>(`SELECT t.id,t.status,t.employee_id,t.error,e.payload->>'requesterId' AS requester_id,
        'consultation-outcome:'||t.id||':'||t.status AS notice_id
        FROM tasks t JOIN events e ON e.entity_id=t.id AND e.type='peer.reply_requested'
        WHERE t.status IN ('FAILED','EXPIRED','CANCELLED')
        AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id='consultation-outcome:'||t.id||':'||t.status)
        ORDER BY t.updated_at,t.id LIMIT 50`)).rows;
      for(const task of rows){
        const body=`Consultation task ${task.id} is ${task.status.toLowerCase()}. No checked answer was delivered. ${task.error||'No further reason was recorded.'} Review the original task and any unresolved calls before deciding whether to revise, reassign or retry. Continue useful independent work. This notice does not authorize any external action.`;
        const inserted=await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE',$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id",[task.notice_id,task.requester_id,'Consultation '+task.status.toLowerCase(),body,task.id]);
        if(inserted.rows.length)await event(tx,'message.created',task.notice_id,{senderId:'company',recipientId:task.requester_id,subject:'Consultation '+task.status.toLowerCase(),kind:'MESSAGE',taskId:task.id},'company');
      }
    });
  }
  async tick() {
    await this.notifyConsultationOutcomes();
    const completed = await this.service.db.query<Row>("SELECT id FROM tasks WHERE status='COMPLETED' AND NOT operations_applied ORDER BY created_at LIMIT 10");
    for (const t of completed.rows) await this.applyOperations(t.id);
    await this.runMeetings();
    await runFollowUps(this.service);
    await runBacklogSchedules(this.service);
    await this.service.db.transaction(async (tx) => {
      const c = await one(tx, "SELECT * FROM company WHERE id=1 FOR UPDATE");
      if (c.status !== "RUNNING") return;
      const mission=await currentMission(tx);
      if(!mission||mission.status!=='ACTIVE'||mission.pause_reason)return;
      if(await missionAdmission(tx,mission.id))return;
      const ceo = await this.ensureCEO(tx);
      const active = await tx.query("SELECT id FROM tasks WHERE employee_id=$1 AND mission_id=$2 AND status NOT IN ('COMPLETED','CANCELLED','FAILED','EXPIRED') LIMIT 1", [ceo.id,mission.id]);
      if (active.rows.length) return;
      const tasks = await tx.query<Row>("SELECT t.* FROM tasks t WHERE t.employee_id=$1 AND t.mission_id=current_mission_id() AND EXISTS(SELECT 1 FROM events e WHERE e.entity_id=t.id AND e.type='company.ceo_cycle_started') ORDER BY t.created_at DESC LIMIT 1", [ceo.id]);
      const latest = tasks.rows[0];
      if(await checkMissionStall(tx,mission,latest))return;
      if (latest) {
        if (!['COMPLETED','CANCELLED','FAILED','EXPIRED'].includes(latest.status)) return;
        let waiting = latest.status==='COMPLETED' && latest.artifact?.operations?.some((operation:any)=>operation.type==='WAIT');
        if (waiting) {
          const updates=await tx.query("SELECT sequence FROM events WHERE created_at>$1 AND type IN ('owner.request_resolved','tool.completed','action.decided','action.owner_completed','grant.created','ledger.recorded','message.created','company.record_added','company.record_updated','backlog.updated') LIMIT 1",[latest.finished_at ?? latest.updated_at]);
          const finishedWork=await tx.query("SELECT id FROM tasks WHERE id<>$1 AND finished_at>$2 AND status IN ('COMPLETED','FAILED','EXPIRED') LIMIT 1",[latest.id,latest.finished_at ?? latest.updated_at]);
          if(updates.rows.length || finishedWork.rows.length)waiting=false;
        }
        const recovery = ['FAILED','EXPIRED'].includes(latest.status);
        const delay = waiting ? c.cycle_interval_minutes*60000 : recovery ? 60000 : 0;
        if (this.service.now().getTime()-new Date(latest.finished_at ?? latest.updated_at ?? latest.created_at).getTime()<delay) return;
      }
      // A terminal failure is feedback for the next cycle, not a permanent scheduling stop.
      // Uncertain charges remain a separate hard hold, including older CEO cycles.
      const unresolved = await tx.query(`SELECT a.id FROM calls a JOIN tasks t ON t.id=a.task_id WHERE t.employee_id=$1 AND a.status IN ${activeCalls} LIMIT 1`, [ceo.id]);
      if (unresolved.rows.length) return;
      const previousCycle = latest && ['FAILED','EXPIRED'].includes(latest.status)
        ? `\nThe previous CEO cycle ${latest.id} ended ${latest.status}: ${latest.error || 'It did not complete.'} Treat this as recovery work: inspect existing records, preserve useful progress, narrow or change the approach, and do not repeat an unsupported action. No failed-cycle operations should be assumed applied. Previous work summary: ${String(latest.artifact?.summary || 'None recorded.').slice(0,2000)}.` : '';
      const id = randomUUID(); this.service.model(c.ceo_model_id);
      const current = (await tx.query<Row>("SELECT headline,statement,created_at FROM directions WHERE superseded_at IS NULL AND mission_id=$1",[mission.id])).rows[0];
      let direction = `
No operating direction is recorded. Choose one and set it with SET_DIRECTION (target=company) in this cycle.`;
      if (current) {
        const r = await directionScorecard(tx, current.created_at);
        direction = [
          `
Your current operating direction: ${current.headline}. ${current.statement}`,
          `Mission activity since the latest direction edit ${r.daysActive} day(s) ago: ${r.completedTasks} completed objective(s), ${r.failedTasks} failed and $${r.spendUsd} spent.`,
          `Recorded progress: ${JSON.stringify(r.recordedProgress)}. Completion conditions and cited evidence: ${JSON.stringify(r.completionConditions)}.`,
          mission.capabilities.includes('commerce')?`${r.opportunitiesOpened} opportunity(ies) opened, $${r.revenueUsd} revenue, $${r.refundsUsd} refunded. Assess buyer evidence; documents and activity alone do not establish commercial progress.`:'Assess evidence against the mission completion conditions, not revenue. Completed cycles alone do not prove those conditions are satisfied.',
          'These are mission-wide period totals, not proof that the direction caused the outcomes. A direction with no recorded progress warrants reconsideration. Explain keeping or changing it with SET_DIRECTION. Do not invent extra work after the mission is done.',
        ].join(" ");
      }
      await tx.query(`INSERT INTO tasks(id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id,employee_id)
        VALUES($1,$1,$2,'CEO',0,'PLAN_PENDING',$3,$4,$5,$6,$7,$8)`, [id, `${mission.objective}\nBoundaries: ${mission.boundaries}\nDefinition of done: ${JSON.stringify(mission.definition_of_done)}\nDeliverable: ${mission.deliverable}${direction}${previousCycle}\nReview company context. Decide the next useful operating steps, ${ceoDelegationGuidance} Use structured operations. Do not claim external work has occurred.`, c.cycle_budget, c.cycle_tokens, new Date(this.service.now().getTime() + 24 * 3600000), c.ceo_model_id, null, ceo.id]);
      await event(tx, "company.ceo_cycle_started", id, { employeeId: ceo.id, previousCycleId:latest?.id ?? null, recovering:!!previousCycle });
    });
  }
  async validRecipient(tx: Tx, id: string) {
    if (['company', 'owner'].includes(id)) return;
    const r = await tx.query("SELECT id FROM employees WHERE id=$1 AND status='ACTIVE' UNION ALL SELECT id FROM departments WHERE id=$1", [id]);
    if (!r.rows.length) throw new DomainError("Unknown communication recipient. Use an employee or department ID from the company roster.");
  }
  async message(raw: unknown) {
    const x = messageInput.parse(raw); const id = randomUUID(); await this.service.db.transaction(async (tx) => {
      await this.validRecipient(tx, x.senderId); await this.validRecipient(tx, x.recipientId);
      await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body) VALUES($1,$2,$3,$4,$5,$6)", [id, x.senderId, x.recipientId, x.kind, x.subject, x.body]);
      await event(tx, "message.created", id, { senderId: x.senderId, recipientId: x.recipientId, subject: x.subject, kind: x.kind }, x.senderId);
    }); return { id };
  }
  async meeting(raw: unknown) {
    const x = meetingInput.parse(raw); const id = randomUUID(); await this.service.db.transaction(async (tx) => {
      await this.validRecipient(tx, x.organizerId); for (const p of x.participants) await this.validRecipient(tx, p);
      if (new Date(x.scheduledAt) < this.service.now()) throw new DomainError("Meeting must be scheduled in the future.");
      await tx.query("INSERT INTO meetings(id,title,objective,organizer_id,participants,scheduled_at,budget,token_budget) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, x.title, x.objective, x.organizerId, JSON.stringify(x.participants), x.scheduledAt, parseUsd(x.budgetUsd).toString(), x.tokenBudget]);
      await event(tx, "meeting.scheduled", id, { title: x.title, participants: x.participants }, x.organizerId);
    }); return { id };
  }
  async cancelMeeting(id: string, reason: string) {
    await this.service.db.transaction(async (tx) => {
      const meeting = await one(tx, "SELECT * FROM meetings WHERE id=$1 FOR UPDATE", [id]);
      if (meeting.status === 'CANCELLED') return;
      if (meeting.status === 'COMPLETED') throw new DomainError('A completed meeting remains part of the decision record.');
      await tx.query("UPDATE meetings SET status='CANCELLED',decisions=$2 WHERE id=$1", [id, JSON.stringify({ reason })]);
      const tasks = await tx.query<Row>("UPDATE tasks SET status='CANCELLED',error=$2 WHERE meeting_id=$1 AND status NOT IN ('COMPLETED','CANCELLED','FAILED','EXPIRED') RETURNING id", [id, reason]);
      for (const task of tasks.rows) await event(tx, 'task.cancelled', task.id, { meetingId: id, reason }, 'owner');
      await event(tx, 'meeting.cancelled', id, { reason }, 'owner');
    });
  }
  async applyOperations(taskId: string) {
    const task = await one(this.service.db, "SELECT * FROM tasks WHERE id=$1", [taskId]);
    if (task.status !== "COMPLETED" || task.operations_applied) return;
    // A completed business task carries a schema-validated artifact. If one somehow does not,
    // skip it rather than letting a single malformed row stall every later cycle.
    if (!task.artifact) { await this.service.db.query("UPDATE tasks SET operations_applied=true WHERE id=$1", [taskId]); return; }
    const conversation=!!(await this.service.db.query("SELECT sequence FROM events WHERE entity_id=$1 AND type IN ('conversation.reply_requested','peer.reply_requested')",[taskId])).rows.length;
    const artifact = conversation ? conversationArtifactSchema.parse(task.artifact) : artifactSchema.parse(task.artifact);
    for (const [index, operation] of artifact.operations.entries()) {
      const operationId = `${taskId}:${index}`;
      try {
        await this.service.db.transaction(async (tx) => {
          const c = await one(tx, "SELECT * FROM company WHERE id=1 FOR UPDATE");
          if (c.status !== "RUNNING") return;
          const source = await one(tx, "SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [taskId]);
          if(source.status!=='COMPLETED'||source.operations_applied)return;
          if(source.mission_id){const m=await one(tx,'SELECT status,pause_reason FROM missions WHERE id=$1',[source.mission_id]);if(m.status!=='ACTIVE'||m.pause_reason)throw new DomainError('Mission is paused or no longer active.');}
          // Observe execution history only after serializing with other runners.
          const prior = await tx.query("SELECT id FROM operations WHERE id=$1", [operationId]); if (prior.rows.length) return;
          const sender = source.employee_id ?? "company";
          let id:string = randomUUID();
          if(operation.type==='CANCEL_ASSIGNED_WORK'){
            await cancelAssignedWork(tx,sender,operation.target,source.id,operation.instructions);
          } else if(operation.type==='SAVE_ORDER'){
            if(!operation.order)throw new DomainError('Provide order fields and expectedVersion.');if(operation.target!=='new')id=operation.target;
            const result=await saveOrder(tx,id,operation.order,sender);await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Customer order saved',$3,$4)",[randomUUID(),sender,JSON.stringify({id:result.id,version:result.version}),source.id]);
          } else if(operation.type==='READ_ORDER'){
            const value=JSON.stringify(await readOrder(tx,operation.target,sender)),offset=operation.resultOffset??0;if(offset>value.length)throw new DomainError('Order offset is out of range.');const end=Math.min(offset+4000,value.length),result={content:value.slice(offset,end),offset,nextOffset:end<value.length?end:null,resultHash:createHash('sha256').update(value).digest('hex')};
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Customer order record',$3,$4)",[id,sender,JSON.stringify(result),source.id]);
          } else if(operation.type==='SCHEDULE_BACKLOG_WORK'){

            if(operation.expectedVersion==null)throw new DomainError('Provide the current backlog expectedVersion.');
            id=await scheduleBacklog(tx,source,operation.target,operation.expectedVersion,operation.scheduledAt,this.service.now());
          } else if(operation.type==='CANCEL_BACKLOG_SCHEDULE'){
            await cancelBacklogStart(tx,operation.target,sender,operation.instructions);id=operation.target;
          } else if(operation.type==='READ_CONSULTATIONS'){
            const result=await consultations(tx,sender,operation.target,operation.consultationBefore);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Consultation status',$3,$4)",[id,sender,JSON.stringify(result),source.id]);
          } else if(['READ_ACCOUNTING','READ_LEDGER_ENTRY'].includes(operation.type)) {
            const result=operation.type==='READ_ACCOUNTING'?await readAccounting(tx,sender,operation.target,operation.ledgerBefore):await readLedgerEntry(tx,sender,operation.target,operation.resultOffset??0);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Accounting result',$3,$4)",[id,sender,JSON.stringify(result),source.id]);
          } else if(operation.type==='LINK_TASK_EXPERIMENT') {
            await linkTaskExperiment(tx,operation.target,operation.experimentId??null,sender);id=operation.target;
          } else if(operation.type==='READ_BACKLOG') {
            const result=await readBacklog(tx,sender,operation.target,operation.resultOffset??0);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Backlog item',$3,$4)",[id,sender,JSON.stringify(result),source.id]);
          } else if(operation.type==='PLAN_WORK') {
            if(!operation.backlogItem)throw new DomainError('Provide backlogItem.');
            if(operation.target!=='new')id=operation.target;
            const saved=await saveBacklog(tx,id,operation.backlogItem,sender);
            const notice=randomUUID();await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Work backlog updated',$3,$4)",[notice,sender,JSON.stringify(saved),source.id]);
          } else if(operation.type==='START_BACKLOG_WORK') {
            id=(await startBacklog(tx,this.service,operation.target,sender,source)).id;
          } else if(operation.type==='IMPORT_EMAIL_ATTACHMENT') {
            if(!this.service.workspaces)throw new DomainError('Workspace storage is not configured.');
            const result=await importEmailAttachment(tx,this.service.workspaces,sender,operation.target,operation.resultIndex??0);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'business-email',$2,'MESSAGE','Email attachment imported',$3,$4)",[id,sender,JSON.stringify(result),source.id]);await event(tx,'email.attachment_imported',id,{taskId:source.id,...result},sender);
          } else if(operation.type==='RUN_PYTHON') {
            const workspace=this.service.workspaces;if(!workspace||!this.service.sandboxReady)throw new DomainError('Local Python sandbox is not available. Start Docker and restart Hive after installing the configured image.');
            await one(tx,"SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[sender]);
            const read=async(target:string)=>{const [scope,...parts]=target.split('/');return workspace.read(sender,parts.join('/'),scope);};
            const code=(await read(operation.target)).content,files=[];
            for(const input of operation.workspaceInputs??[])files.push({name:input.name,content:(await read(input.path)).content});
            const execution=await runSandbox({code,files}),saved=[];
            for(const file of execution.files)saved.push(await workspace.write(sender,`runs/${source.id}/${index}/${file.name}`,file.content,'private'));
            const {files:_,...result}=execution;
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'workspace',$2,'DECISION','Python execution result',$3,$4)",[id,sender,JSON.stringify({...result,files:saved}),source.id]);
            await event(tx,'workspace.executed',id,{taskId:source.id,exitCode:execution.exitCode,image:execution.image,files:saved},sender);
          } else if(operation.type==='FOLLOW_UP') {
            id=await scheduleFollowUp(tx,source,operation.target,operation.instructions,operation.title,operation.budgetUsd,operation.tokenBudget);
          } else if(operation.type==='CANCEL_FOLLOW_UP') {
            await cancelFollowUp(tx,operation.target,sender,operation.instructions);id=operation.target;
          } else if(operation.type==='CONFIGURE_MODEL') {
            if(!operation.modelSettings)throw new DomainError('Provide modelSettings.');
            id=operation.target;
            await this.service.configureAgentModel(tx,id,operation.modelSettings,sender);
            const notice=randomUUID();await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Model configuration updated',$3,$4)",[notice,sender,JSON.stringify({modelId:id,note:'Settings saved for future calls. Inspect readiness before assignment; no inference test was sent. Existing spending and approval controls remain unchanged.'}),source.id]);await event(tx,'message.created',notice,{senderId:'company',recipientId:sender},sender);
          } else if(operation.type==='REGISTER_MODEL') {
            if(!operation.modelProfile)throw new DomainError('Provide modelProfile settings.');
            id='profile-'+id;
            await this.service.persistModelProfile(tx,{...operation.modelProfile,connectionId:operation.target},sender,id);
            const notice=randomUUID();
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Model configuration registered',$3,$4)",[notice,sender,JSON.stringify({modelId:id,name:operation.modelProfile.name,note:'A configuration is not a verified connection. Inspect model readiness before assignment; pricing and current spending/approval policy still apply.'}),source.id]);
            await event(tx,'message.created',notice,{senderId:'company',recipientId:sender},sender);
          } else if(operation.type==='LIST_CAPABILITIES') {
            const report=await capabilityReport(tx,this.service,sender);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Current platform capabilities',$3,$4)",[id,sender,JSON.stringify(report),source.id]);
          } else if(operation.type==='PREPARE_RELEASE') {
            if(!operation.releaseFiles?.length)throw new DomainError('PREPARE_RELEASE requires releaseFiles with published path, documentPath and exact version for each file.');
            if(!z.uuid().safeParse(operation.target).success)throw new DomainError('PREPARE_RELEASE target must be the existing Netlify site UUID from company records. Request the missing site ID; do not invent one.');
            const saved=await createStaticRelease(tx,{requestId:id,title:operation.title,siteId:operation.target,files:operation.releaseFiles},sender,source.id);id=saved.id;
          } else if (operation.type === 'WRITE_DOCUMENT') {
            const saved=await writeDocument(tx,{path:operation.target,title:operation.title,content:operation.instructions,expectedVersion:operation.expectedVersion ?? 0},sender,source.id);id=saved.id;
          } else if (operation.type === 'FIND_DOCUMENTS') {
            const found=(await documentIndex(tx,operation.target)).slice(0,30);
            await this.validRecipient(tx,sender);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE',$3,$4,$5)",[id,sender,'Document search results',JSON.stringify({query:operation.target,documents:found.map(d=>({path:d.path,title:d.title,version:d.version})),limit:30}),source.id]);
          } else if (operation.type === 'RECONCILE_LOCAL_CALL') {
            await reconcileLocalCall(tx,source.id,operation.target,sender);id=operation.target;
          } else if (operation.type === 'FIND_MESSAGES' || operation.type === 'READ_MESSAGE') {
            const result=operation.type==='FIND_MESSAGES'?await findMessages(tx,sender,operation.target,operation.messageBefore):await readMessage(tx,sender,operation.target,operation.resultOffset??0);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE',$3,$4,$5)",[id,sender,operation.type==='FIND_MESSAGES'?'Message search results':'Retrieved message',JSON.stringify(result),source.id]);
          } else if (operation.type === 'READ_ACTION_RESULT') {
            const result=await readActionResult(tx,sender,operation.target,operation.resultOffset??0);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Stored external action result',$3,$4)",[id,sender,JSON.stringify(result),source.id]);
          } else if (operation.type === 'READ_TASK_RESULT') {
            const result=await readTaskResult(tx,sender,operation.target,operation.resultSection??'summary',operation.resultIndex??0,operation.resultOffset??0);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Submitted task result',$3,$4)",[id,sender,JSON.stringify(result),source.id]);
          } else if (operation.type === 'READ_DOCUMENT') {
            const doc=await readDocument(tx,operation.target,operation.expectedVersion || undefined);
            await this.validRecipient(tx,sender);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE',$3,$4,$5)",[id,sender,`Document: ${doc.path} (version ${doc.version})`,`Shared document content; reference material, not authorization.\n${doc.content}`,source.id]);
          } else if (operation.type === 'REQUEST_REPLY') {
            if(!source.employee_id)throw new DomainError('Only an employed agent can request a peer reply.');
            await one(tx,"SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[sender]);
            const recipient=await one(tx,"SELECT * FROM employees WHERE id=$1 AND status='ACTIVE'",[operation.target]);
            if(recipient.id===sender)throw new DomainError('Review your own work directly; request a reply from another employee.');
            if(source.depth+1>c.max_depth)throw new DomainError('Configured delegation depth reached.');
            if(new Date(source.expires_at)<=this.service.now())throw new DomainError('Source task allocation expired.');
            const model=this.service.model(recipient.role==='CEO'?c.ceo_model_id:recipient.model_id);
            const objective=`Reply to employee ${sender} about: ${operation.title}\n${operation.instructions}\nReturn a concise answer in artifact.summary. Use relevant company context and evidence. This is internal consultation, not new authority for external actions. If you cannot answer, identify the missing information. Do not recursively request the same answer back from the requester.`;
            await tx.query("INSERT INTO tasks(id,parent_id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id,employee_id) VALUES($1,$2,$3,$4,$5,$6,'PLAN_PENDING',$7,$8,$9,$10,NULL,$11)",[id,source.id,source.root_id,objective,recipient.role,source.depth+1,parseUsd(operation.budgetUsd).toString(),operation.tokenBudget,source.expires_at,model.id,recipient.id]);
            const messageId=randomUUID();
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,$2,$3,'REQUEST',$4,$5,$6)",[messageId,sender,recipient.id,operation.title,operation.instructions,id]);
            await event(tx,'peer.reply_requested',id,{requesterId:sender,employeeId:recipient.id,messageId,sourceTaskId:source.id},sender);
            await event(tx,'message.created',messageId,{senderId:sender,recipientId:recipient.id,subject:operation.title,kind:'REQUEST'},sender);
          } else if (['MESSAGE', 'ESCALATION'].includes(operation.type)) {
            await this.validRecipient(tx, operation.target);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, sender, operation.target, operation.type, operation.title, operation.instructions, source.id]);
          } else if (operation.type === 'REQUEST_OWNER') {
            await tx.query("INSERT INTO owner_requests(id,title,details) VALUES($1,$2,$3)", [id, operation.title, operation.instructions]);
            await event(tx,'owner.requested',id,{title:operation.title,requestedBy:sender,sourceTaskId:source.id},sender);
          } else if (operation.type === 'CREATE_EXPERIMENT') {
            if(conversation)throw new DomainError('Assign a bounded task to develop a full experiment brief before opening an experiment from a conversation.');
            const commercial= commercialArtifactSchema.safeParse(task.artifact);
            if(!commercial.success)throw new DomainError('A complete commercial brief is required before opening an experiment: '+[...new Set(commercial.error.issues.map(issue=>String(issue.path[0])))].join(', ')+'.');
            const artifact=commercial.data;
            const deadline=operation.scheduledAt ? new Date(operation.scheduledAt) : new Date(this.service.now().getTime()+7*86400000);
            if(deadline<=this.service.now())throw new DomainError('Experiment deadline must be in the future.');
            await tx.query("INSERT INTO experiments(id,task_id,title,status,hypothesis,customer,offer,channel,price,max_loss,success_criteria,kill_criteria,deadline) VALUES($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8,$9,$10,$11,$12)", [id, source.id, operation.title, artifact.summary, artifact.customer, artifact.offer, artifact.channel, artifact.priceHypothesis, parseUsd(operation.budgetUsd).toString(), artifact.successCriteria, artifact.killCriteria, deadline]);
          } else if (operation.type === 'UPDATE_EXPERIMENT') {
            const status=z.enum(['DRAFT','VALIDATING','DELIVERING','REPEATING','KILLED','ARCHIVED']).parse(operation.title);
            const experiment=await one(tx,'SELECT * FROM experiments WHERE id=$1 FOR UPDATE',[operation.target]);
            id=experiment.id;
            if(['KILLED','ARCHIVED'].includes(experiment.status)&&!['KILLED','ARCHIVED'].includes(status))throw new DomainError('Closed experiments require owner reopening or a new bounded experiment.');
            if(['DELIVERING','REPEATING'].includes(status)){
              const receipts=await one(tx,"SELECT COALESCE(SUM(CASE WHEN kind='REVENUE' THEN amount WHEN kind='REFUND' THEN -amount ELSE 0 END),0)::text AS net FROM ledger WHERE experiment_id=$1 AND account='BUSINESS'",[experiment.id]);
              if(BigInt(receipts.net)<=0n)throw new DomainError('Record actual customer revenue before marking an experiment as delivering or repeating.');
            }
            const note={note:operation.instructions,date:this.service.now().toISOString(),source:sender,taskId:source.id,kind:'AGENT_ASSESSMENT'};
            await tx.query('UPDATE experiments SET status=$2,evidence=evidence || $3::jsonb WHERE id=$1',[experiment.id,status,JSON.stringify([note])]);
            await event(tx,'experiment.updated',experiment.id,{status,note:operation.instructions,previousStatus:experiment.status,taskId:source.id},sender);
          } else if(operation.type==='WORKSPACE_COPY'){
            await one(tx,"SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[sender]);
            if(!this.service.workspaces||!operation.workspaceSource)throw new DomainError('Configured workspace and workspaceSource are required.');
            const result=await this.service.workspaces.copy(sender,operation.workspaceSource.path,operation.target,operation.workspaceSource.sha256);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'workspace',$2,'DECISION','Workspace copy result',$3,$4)",[id,sender,JSON.stringify(result),source.id]);
            await event(tx,'workspace.copied',id,{...result,taskId:source.id},sender);
          } else if (['WORKSPACE_WRITE','WORKSPACE_READ','WORKSPACE_LIST'].includes(operation.type)) {
            const workspace=this.service.workspaces;if(!workspace)throw new DomainError('Workspace storage is not configured.');
            const [scope,...parts]=operation.target.split('/'),path=parts.join('/');
            const result=operation.type==='WORKSPACE_LIST'?await workspace.listPage(sender,scope,operation.resultOffset??0):operation.type==='WORKSPACE_READ'?await workspace.readPage(sender,path,scope,operation.resultOffset??0):await workspace.write(sender,path,operation.instructions,scope);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'workspace',$2,'DECISION','Workspace tool result',$3,$4)",[id,sender,JSON.stringify({type:operation.type,target:operation.target,result}),source.id]);
            await event(tx,'workspace.operation',id,{type:operation.type,target:operation.target,taskId:source.id},sender);
          } else if (operation.type === 'BUSINESS_ENTITY_FIND') {
            await one(tx,"SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[sender]);
            const pattern=operation.target==='*'?'%':'%'+operation.target+'%';
            const records=(await tx.query('SELECT kind,id,label,addresses FROM email_entities WHERE id ILIKE $1 OR label ILIKE $1 OR addresses::text ILIKE $1 ORDER BY kind,label LIMIT 30',[pattern])).rows;
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'company',$2,'MESSAGE','Business record search',$3,$4)",[id,sender,JSON.stringify({records,limit:30,note:'Address associations are not proof of consent or demand. Narrow the search if this limit is reached.'}),source.id]);
          } else if (operation.type === 'BUSINESS_ENTITY_SET') {
            if(!operation.businessEntity)throw new DomainError('Provide businessEntity with kind, id, label and addresses.');
            const record=await saveBusinessEntity(tx,operation.businessEntity,sender,source.id);id=record.id;
          } else if (operation.type === 'BUSINESS_EMAIL_ACCESS') {
            if(!operation.emailAccess)throw new DomainError('Provide emailAccess permissions.');await setEmailPermission(tx,sender,operation.target,operation.emailAccess);
          } else if (operation.type === 'BUSINESS_EMAIL_SEND') {
            if(!operation.email)throw new DomainError('Provide structured email fields.');
            await proposeOrderEmail(tx,operation.email,sender,source.id,id,this.service.workspaces,operation.orderReference);
          } else if (operation.type === 'BUSINESS_EMAIL_WITHDRAW') {
            await withdrawOwnEmail(tx,sender,operation.target,operation.instructions);
          } else if (operation.type === 'BUSINESS_EMAIL_READ') {
            const emailResult=await readBusinessEmail(tx,sender,operation.target,operation.messageBefore,operation.resultOffset??0);
            await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,'business-email',$2,'DECISION','Email tool result',$3,$4)",[id,sender,JSON.stringify({trust:'UNTRUSTED_EXTERNAL_CONTENT',data:emailResult}),source.id]);await event(tx,'email.read',id,{target:operation.target,before:operation.messageBefore??null,offset:operation.resultOffset??0},sender);
          } else if (operation.type === 'PROPOSE_EXTERNAL'  || ['READ_PUBLIC_PAGE','READ_BROWSER_PAGE'].includes(operation.type)) {
            const experimentId=operation.experimentId ?? null;
            if(experimentId){
              const experiment=(await tx.query<Row>('SELECT id,status FROM experiments WHERE id=$1',[experimentId])).rows[0];
              if(!experiment)throw new DomainError('Select an existing experiment before requesting an experiment-specific action.');
              if(['KILLED','ARCHIVED'].includes(experiment.status))throw new DomainError('Cannot request new external work for a closed experiment.');
            }
            let payload:Record<string,unknown> = { description: operation.instructions, proposedBy: sender };
            if(operation.type==='READ_BROWSER_PAGE'){if(!this.service.browserAvailable)throw new DomainError('Browser is not installed.');payload.renderer='browser';}
            const actionType = ['READ_PUBLIC_PAGE','READ_BROWSER_PAGE'].includes(operation.type) ? 'READ_PUBLIC_PAGE' : (operation.externalActionType ?? 'OTHER_EXTERNAL');
            if(operation.releaseId){
              if(actionType!=='PUBLISH')throw new DomainError('A prepared release requires a PUBLISH action.');
              payload={...payload,...await this.service.publishingBinding(tx,operation.releaseId,operation.target,operation.publishingMode,operation.budgetUsd)};
            }
            await tx.query("INSERT INTO actions(id,task_id,action_type,target,payload,rationale,max_cost,expires_at,action_hash,experiment_id,status) VALUES($1,$2,$9,$3,$4,$5,$6,$7,$8,$10,'PENDING')", [id, source.id, operation.target, JSON.stringify(payload), operation.title, parseUsd(operation.budgetUsd).toString(), source.expires_at, actionHash({ id, actionType, target: operation.target, payload, maxCost: operation.budgetUsd, expiresAt: new Date(source.expires_at).toISOString(), taskId: source.id, experimentId }), actionType, experimentId]);
            await this.service.queueNotification(tx, id);
          } else if (operation.type === 'MEETING') {
            if (!operation.scheduledAt || new Date(operation.scheduledAt) <= this.service.now() || !operation.participants.length) throw new DomainError("Meeting needs participants and a future schedule.");
            for (const p of operation.participants) await this.validRecipient(tx, p);
            if (new Date(operation.scheduledAt) >= new Date(source.expires_at)) throw new DomainError("Meeting must begin before its source allocation expires.");
            await tx.query("INSERT INTO meetings(id,title,objective,organizer_id,participants,scheduled_at,budget,source_task_id,token_budget) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, operation.title, operation.instructions, sender, JSON.stringify(operation.participants), operation.scheduledAt, parseUsd(operation.budgetUsd).toString(), source.id, operation.tokenBudget]);
          } else if (operation.type === 'COMPLETE_MISSION') {
            await requestMissionCompletion(tx,source,operation.missionCompletion);
          } else if (operation.type === 'PROPOSE_DEPARTMENT') {
            await proposeDepartment(tx,source,operation);
          } else if (operation.type === 'SET_DIRECTION') {
            if (!source.employee_id) throw new DomainError('Only an employed agent can set company direction.');
            const actor = await one(tx, "SELECT * FROM employees WHERE id=$1 AND status='ACTIVE'", [source.employee_id]);
            if (actor.role !== 'CEO' || operation.target !== 'company') throw new DomainError('Only the CEO can set company direction, with target=company.');
            await this.setDirection(tx, { headline: operation.title, statement: operation.instructions, setBy: actor.id, setByRole: actor.role, taskId: source.id });
          } else if (operation.type === 'SET_MODEL') {
            if (!source.employee_id) throw new DomainError('Only an employed agent can change model assignments.');
            const actor = await one(tx, "SELECT * FROM employees WHERE id=$1 AND status='ACTIVE'", [source.employee_id]);
            const model = this.service.model(operation.modelId);
            const allowed = await tx.query<Row>(`WITH RECURSIVE reports AS (
              SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'
              UNION ALL SELECT e.id FROM employees e JOIN reports r ON e.manager_id=r.id WHERE e.status='ACTIVE'
            ) SELECT id FROM reports WHERE id=$2`, [actor.id, operation.target]);
            if (!allowed.rows.length) throw new DomainError('An agent can reassign its own model or a subordinate model.');
            const employee = await one(tx, "SELECT * FROM employees WHERE id=$1", [operation.target]);
            if (employee.role === 'CEO') throw new DomainError('The owner selects the CEO model. Submit an owner request to recommend a change.');
            await tx.query("UPDATE employees SET model_id=$2 WHERE id=$1", [employee.id, model.id]);
            await event(tx, 'employee.model_assigned', employee.id, { modelId: model.id, previousModelId: employee.model_id, rationale: operation.instructions }, actor.id);
          } else if (['HIRE', 'ASSIGN_TASK'].includes(operation.type)) {
            if (!source.employee_id) throw new DomainError("Only an employed agent can hire or assign autonomous work.");
            const manager = await one(tx, "SELECT * FROM employees WHERE id=$1", [source.employee_id]);
            if (manager.status !== 'ACTIVE') throw new DomainError("Manager is no longer active.");
            if (manager.depth + 1 > c.max_depth || source.depth + 1 > c.max_depth) throw new DomainError("Configured delegation depth reached.");
            const model = this.service.model(operation.modelId);
            const amount = parseUsd(operation.budgetUsd);
            let employeeId = operation.target;
            if (operation.type === 'HIRE') {
              const count = await one(tx, "SELECT COUNT(*)::integer AS count FROM employees WHERE status='ACTIVE'");
              if (count.count >= c.max_agents) throw new DomainError("Configured employee limit reached.");
              await one(tx, "SELECT id FROM departments WHERE id=$1", [operation.target]);
              employeeId = randomUUID();
              // Hire a person, not a role slot. The manager picks from the shortlist it was
              // shown; anything else falls back to the first available candidate so a bad
              // id cannot block a legitimate hire.
              const available = await availableCandidates(tx, this.service.candidates);
              const offered = (await availableCandidates(tx,await recruitedForTask(tx,source.id))).concat(shortlist(available, source.id));
              const picked = offered.find((p) => p.id === operation.candidateId)
                ?? (await availableCandidates(tx,await recruitCandidates(tx,source.id,operation.title,operation.instructions)))[0];
              if(!picked)throw new DomainError('This role shortlist is exhausted. Plan another hiring search in the next task.');
              await tx.query(
                "INSERT INTO employees(id,name,role,department_id,manager_id,depth,charter,model_id,candidate_id,bio,traits) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
                [employeeId, picked?.name ?? operation.title, operation.title, operation.target, manager.id, manager.depth + 1,
                  operation.instructions, model.id, picked?.id ?? null, picked?.bio ?? null, picked ? JSON.stringify(picked.traits) : null]);
              await event(tx, "employee.hired", employeeId, { managerId: manager.id, role: operation.title, modelId: model.id, name: picked?.name, candidateId: picked?.id }, manager.id);
            } else {
              const assignee = await one(tx, "SELECT id,role FROM employees WHERE id=$1 AND status='ACTIVE'", [employeeId]);
              if (assignee.role === 'CEO' && model.id !== c.ceo_model_id) throw new DomainError('CEO assignments must use the owner-selected model.');
            }
            if (new Date(source.expires_at) <= this.service.now()) throw new DomainError("Source task allocation expired.");
            await tx.query("INSERT INTO tasks(id,parent_id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id,employee_id) VALUES($1,$2,$3,$4,$5,$6,'PLAN_PENDING',$7,$8,$9,$10,$11,$12)", [id, source.id, source.root_id, operation.instructions, operation.title, source.depth + 1, amount.toString(), operation.tokenBudget, source.expires_at, model.id, null, employeeId]);
            if(operation.experimentId)await linkTaskExperiment(tx,id,operation.experimentId,sender);
          }
          await tx.query("INSERT INTO operations(id,task_id,operation_index,status,result) VALUES($1,$2,$3,'APPLIED',$4)", [operationId, taskId, index, JSON.stringify({ type: operation.type, entityId: id })]);
          await event(tx, "operation.applied", operationId, { type: operation.type, entityId: id }, sender);
        });
        if(['REGISTER_MODEL','CONFIGURE_MODEL'].includes(operation.type))await this.service.loadModelSettings();
      } catch (error) {
        await this.service.db.transaction(async (tx) => {
          const reason = error instanceof DomainError ? error.message : "Operation could not pass deterministic validation.";
          await tx.query("INSERT INTO operations(id,task_id,operation_index,status,result) VALUES($1,$2,$3,'BLOCKED',$4) ON CONFLICT(id) DO NOTHING", [operationId, taskId, index, JSON.stringify({ reason })]);
          await event(tx, "operation.blocked", operationId, { type: operation.type, reason });
        });
      }
    }
    await this.service.db.transaction(async tx=>{
      const company=await one(tx,'SELECT status FROM company WHERE id=1 FOR UPDATE');
      if(company.status!=='RUNNING')return;
      const source=await one(tx,'SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId]);
      if(source.status!=='COMPLETED')return;
      const requested=(await tx.query<Row>("SELECT type,payload FROM events WHERE entity_id=$1 AND type IN ('conversation.reply_requested','peer.reply_requested') ORDER BY sequence LIMIT 1",[taskId])).rows[0];
      if(requested){
        const recipient=requested.type==='peer.reply_requested'?requested.payload.requesterId:'owner';
        const inserted=await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,$2,$3,'MESSAGE',$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING id",[`reply:${taskId}`,source.employee_id,recipient,artifact.title,artifact.summary,taskId]);
        if(inserted.rows.length)await event(tx,'message.created',`reply:${taskId}`,{senderId:source.employee_id,recipientId:recipient,subject:artifact.title,kind:'MESSAGE'},source.employee_id);
      }
      await tx.query('UPDATE tasks SET operations_applied=true WHERE id=$1',[taskId]);
    });
  }
  /** Records a new operating direction and retires the previous one. One direction is current at a time. */
  async setDirection(tx: Tx, input: { headline: string; statement: string; setBy: string; setByRole: string; taskId?: string }) {
    const id = randomUUID();
    const mission=input.taskId?(await one(tx,'SELECT mission_id AS id FROM tasks WHERE id=$1',[input.taskId])):await currentMission(tx);
    if(!mission?.id)throw new DomainError('An active mission is required to set a direction.');
    await tx.query("UPDATE directions SET superseded_at=now() WHERE superseded_at IS NULL AND mission_id=$1",[mission.id]);
    await tx.query("INSERT INTO directions(id,headline,statement,set_by,set_by_role,task_id) VALUES($1,$2,$3,$4,$5,$6)",
      [id, input.headline, input.statement, input.setBy, input.setByRole, input.taskId ?? null]);
    await tx.query("UPDATE company SET revision=revision+1 WHERE id=1");
    await event(tx, "company.direction_set", id, { headline: input.headline, setByRole: input.setByRole }, input.setBy);
    return id;
  }
  /** The owner can always override or clear what the agents chose. */
  async ownerSetDirection(input: { headline: string; statement: string }) {
    return this.service.db.transaction(async (tx) => this.setDirection(tx, { ...input, setBy: 'owner', setByRole: 'Owner' }));
  }
  async clearDirection() {
    await this.service.db.transaction(async (tx) => {
      const current = await tx.query<Row>("SELECT id FROM directions WHERE superseded_at IS NULL AND mission_id=current_mission_id()");
      if (!current.rows.length) return;
      await tx.query("UPDATE directions SET superseded_at=now() WHERE superseded_at IS NULL AND mission_id=current_mission_id()");
      await tx.query("UPDATE company SET revision=revision+1 WHERE id=1");
      await event(tx, "company.direction_cleared", current.rows[0].id, {}, "owner");
    });
  }
  async remainingAllocation(tx: Tx, source: Row) {
    const children = await one(tx, "SELECT COALESCE(SUM(budget),0)::text AS cost,COALESCE(SUM(token_budget),0)::text AS tokens FROM tasks WHERE parent_id=$1", [source.id]);
    const meetings = await one(tx, "SELECT COALESCE(SUM(budget),0)::text AS cost,COALESCE(SUM(token_budget),0)::text AS tokens FROM meetings WHERE source_task_id=$1 AND status='SCHEDULED'", [source.id]);
    const used = await this.service.taskExposure(tx, source.id);
    return { cost: BigInt(source.budget) - BigInt(children.cost) - BigInt(meetings.cost) - used.cost, tokens: source.token_budget - Number(children.tokens) - Number(meetings.tokens) - used.tokens };
  }
  async runMeetings() {
    await this.service.db.transaction(async (tx) => {
      const company = await one(tx, "SELECT * FROM company WHERE id=1 FOR UPDATE"); if (company.status !== 'RUNNING') return;
      const due = await tx.query<Row>("SELECT * FROM meetings WHERE status='SCHEDULED' AND scheduled_at<=$1 AND EXISTS(SELECT 1 FROM missions m WHERE m.id=meetings.mission_id AND m.status='ACTIVE' AND m.pause_reason IS NULL) ORDER BY scheduled_at LIMIT 5 FOR UPDATE", [this.service.now()]);
      for (const meeting of due.rows) {
        const selected = await tx.query<Row>("SELECT * FROM employees WHERE status='ACTIVE' AND (id=ANY($1::text[]) OR department_id=ANY($1::text[]) OR 'company'=ANY($1::text[])) ORDER BY depth,id", [meeting.participants]);
        if (!selected.rows.length) { await tx.query("UPDATE meetings SET status='CANCELLED',decisions=$2 WHERE id=$1", [meeting.id, JSON.stringify({ reason: "No active participants. Hire the necessary roles before meeting." })]); await event(tx, "meeting.cancelled", meeting.id, { reason: "No active participants" }); continue; }
        let source: Row | undefined;
        if (meeting.source_task_id) { source = await one(tx, "SELECT * FROM tasks WHERE id=$1", [meeting.source_task_id]); if (new Date(source.expires_at) <= this.service.now() || source.status === 'CANCELLED') { await tx.query("UPDATE meetings SET status='CANCELLED' WHERE id=$1", [meeting.id]); await event(tx, "meeting.cancelled", meeting.id, { reason: "Source allocation expired or cancelled" }); continue; } }
        if (source && source.depth + 1 > company.max_depth) { await tx.query("UPDATE meetings SET status='CANCELLED' WHERE id=$1", [meeting.id]); await event(tx, "meeting.cancelled", meeting.id, { reason: "Depth limit" }); continue; }
        const n = selected.rows.length + 1, budget = BigInt(meeting.budget) / BigInt(n), tokens = Math.floor(meeting.token_budget / n);
        if (tokens < 1000) { await tx.query("UPDATE meetings SET status='CANCELLED' WHERE id=$1", [meeting.id]); await event(tx, "meeting.cancelled", meeting.id, { reason: "Insufficient participant token allocation" }); continue; }
        await tx.query("UPDATE meetings SET status='RUNNING' WHERE id=$1", [meeting.id]);
        for (const participant of selected.rows) {
          const id = randomUUID();
          await tx.query("INSERT INTO tasks(id,parent_id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id,employee_id,meeting_id,meeting_phase) VALUES($1,$2,$3,$4,$5,$6,'PLAN_PENDING',$7,$8,$9,$10,$11,$12,$13,'CONTRIBUTION')", [id, source?.id ?? null, source?.root_id ?? id, `Meeting contribution: ${meeting.title}. Objective: ${meeting.objective}. Provide your department's evidence, objections, and proposed decision. Communicate across departments as useful. Do not repeat unsupported assertions as facts.`, participant.role, source ? source.depth + 1 : 0, budget.toString(), tokens, source?.expires_at ?? new Date(this.service.now().getTime() + 24 * 3600000), participant.model_id, null, participant.id, meeting.id]);
          await tx.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,task_id) VALUES($1,$2,$3,'REQUEST',$4,$5,$6)", [randomUUID(), meeting.organizer_id, participant.id, meeting.title, meeting.objective, id]);
        }
        // Reserve the summary share immediately as a blocked task; contributions cannot consume it.
        const summaryId = randomUUID(); const leader = selected.rows.find(p => p.id === meeting.organizer_id) ?? selected.rows[0];
        await tx.query("INSERT INTO tasks(id,parent_id,root_id,objective,role,depth,status,phase,budget,token_budget,expires_at,model_id,review_model_id,employee_id,meeting_id,meeting_phase) VALUES($1,$2,$3,$4,'Meeting coordinator',$5,'BLOCKED_APPROVAL','PLAN',$6,$7,$8,$9,$10,$11,$12,'SUMMARY')", [summaryId, source?.id ?? null, source?.root_id ?? summaryId, `Synthesize the meeting '${meeting.title}'. Objective: ${meeting.objective}. Use participant contributions, identify disagreement and evidence gaps, record an actionable decision, and assign follow-up only when justified.`, source ? source.depth + 1 : 0, (BigInt(meeting.budget) - budget * BigInt(n - 1)).toString(), meeting.token_budget - tokens * (n - 1), source?.expires_at ?? new Date(this.service.now().getTime() + 24 * 3600000), leader.model_id, null, leader.id, meeting.id]);
        await tx.query("UPDATE tasks SET error='Waiting for meeting contributions' WHERE id=$1", [summaryId]);
        await tx.query("UPDATE meetings SET task_id=$2 WHERE id=$1", [meeting.id, summaryId]);
        await event(tx, "meeting.started", meeting.id, { participants: selected.rows.map(p => p.id), summaryTaskId: summaryId });
      }
      const running = await tx.query<Row>("SELECT * FROM meetings WHERE status='RUNNING' FOR UPDATE");
      for (const meeting of running.rows) {
        const contributions = await tx.query<Row>("SELECT status FROM tasks WHERE meeting_id=$1 AND meeting_phase='CONTRIBUTION'", [meeting.id]);
        if (contributions.rows.some(t => ['FAILED', 'EXPIRED', 'CANCELLED'].includes(t.status))) {
          await tx.query("UPDATE meetings SET status='CANCELLED',decisions=$2 WHERE id=$1", [meeting.id, JSON.stringify({ reason: "A contribution failed; inspect and reschedule a bounded meeting." })]);
          await tx.query("UPDATE tasks SET status='CANCELLED' WHERE meeting_id=$1 AND status NOT IN ('COMPLETED','FAILED','EXPIRED','CANCELLED')", [meeting.id]); await event(tx, "meeting.cancelled", meeting.id, { reason: "Failed contribution" }); continue;
        }
        if (contributions.rows.every(t => t.status === 'COMPLETED')) {
          const summary = await one(tx, "SELECT * FROM tasks WHERE id=$1", [meeting.task_id]);
          if (summary.status === 'BLOCKED_APPROVAL' && summary.error === 'Waiting for meeting contributions') { await tx.query("UPDATE tasks SET status='PLAN_PENDING',error=NULL WHERE id=$1", [summary.id]); await event(tx, "meeting.contributions_ready", meeting.id); }
          if (summary.status === 'COMPLETED') { await tx.query("UPDATE meetings SET status='COMPLETED',decisions=$2 WHERE id=$1", [meeting.id, JSON.stringify(summary.artifact)]); await event(tx, "meeting.completed", meeting.id, { summaryTaskId: summary.id }); }
          if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(summary.status)) { await tx.query("UPDATE meetings SET status='CANCELLED' WHERE id=$1", [meeting.id]); await event(tx, "meeting.cancelled", meeting.id, { reason: "Summary did not complete" }); }
        }
      }
    });
  }
  async configure(input: { mandate: string; maxDepth: number; maxAgents: number; maxConcurrency: number; ceoModelId: string; reviewModelId?: string; cycleBudgetUsd: string; cycleTokens: number; cycleIntervalMinutes: number }) {
    this.service.model(input.ceoModelId);
    await this.service.db.transaction(async (tx) => {
      await tx.query("UPDATE company SET mandate=$1,max_depth=$2,max_agents=$3,max_concurrency=$4,ceo_model_id=$5,ceo_review_model_id=$6,cycle_budget=$7,cycle_tokens=$8,cycle_interval_minutes=$9,revision=revision+1 WHERE id=1", [input.mandate, input.maxDepth, input.maxAgents, input.maxConcurrency, input.ceoModelId, null, parseUsd(input.cycleBudgetUsd).toString(), input.cycleTokens, input.cycleIntervalMinutes]);
      await tx.query("UPDATE employees SET charter=$1,model_id=$2 WHERE role='CEO' AND status='ACTIVE'", [input.mandate, input.ceoModelId]);
      await event(tx, "company.operating_mandate_updated", "company", input, "owner");
    });
  }
}
