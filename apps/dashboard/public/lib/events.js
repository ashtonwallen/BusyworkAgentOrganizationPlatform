import { state, employeeName, task } from './state.js';
import { esc, micro, money, titleCase, truncate } from './format.js';

/**
 * Events are the company's audit record. Rendered raw they all read the same, so each
 * type is given a sentence, a category for filtering, and — where one exists — the
 * record it refers to, so a line in the log opens the thing it describes.
 */

const CATEGORY = {
  money: 'Money', work: 'Work', people: 'People', approvals: 'Approvals',
  models: 'Models', external: 'External', direction: 'Direction', system: 'System',
};

const objective = (id) => {
  const t = task(id);
  return t ? truncate(t.objective, 70) : null;
};

const experimentTitle = (id) => {
  const e = (state.data?.experiments || []).find((x) => x.id === id);
  return e ? esc(e.title) : null;
};

const meetingTitle = (id) => {
  const m = (state.data?.meetings || []).find((x) => x.id === id);
  return m ? esc(m.title) : null;
};

const actionOf = (id) => (state.data?.actions || []).find((a) => a.id === id);

/** Structured operations read better as verbs than as their enum names. */
const OPERATION = {
  READ_ACTION_RESULT: 'inspected an original external action result',
  REQUEST_REPLY: 'requested an employee consultation', FIND_MESSAGES: 'searched prior correspondence', READ_MESSAGE: 'read an earlier message',
  WORKSPACE_WRITE: 'wrote a workspace file', WORKSPACE_READ: 'read a workspace file', WORKSPACE_LIST: 'listed workspace files',
  HIRE: 'hired someone', ASSIGN_TASK: 'delegated an objective', SET_MODEL: 'changed a model assignment',
  SET_REVIEW_MODEL: 'changed the company reviewer', SET_DIRECTION: 'set the company direction',
  MESSAGE: 'sent a message', ESCALATION: 'escalated a concern', MEETING: 'called a meeting',
  CREATE_EXPERIMENT: 'opened an opportunity', UPDATE_EXPERIMENT: 'updated an opportunity assessment', READ_PUBLIC_PAGE: 'requested a public page read',
  PROPOSE_EXTERNAL: 'proposed an outside action', REQUEST_OWNER: 'asked you for help', WAIT: 'decided to wait',
};
const operation = (type) => OPERATION[type] || `carried out ${titleCase(type || 'an operation')}`;

/** Each entry returns {text, category, icon, ref?} — ref becomes a clickable record. */
const DESCRIBE = {
  'company.ceo_cycle_acknowledged': (e) => ({ text: `You allowed CEO scheduling to continue: ${esc(e.payload?.reason || 'recovery reviewed')}`, category: 'work', icon: 'check', ref: { task: e.entity_id } }),
  'company.initialized': () => ({ text: 'Company record created. Everything starts paused.', category: 'system', icon: 'shield' }),
  'company.approval_defaults_enabled': () => ({ text: 'Approval gates switched on for every category.', category: 'approvals', icon: 'shield' }),
  'company.approval_policy_updated': (e) => ({ text: `You changed which actions need approval: ${Object.entries(e.payload || {}).map(([k, v]) => `${titleCase(k)} ${v ? 'on' : 'off'}`).join(', ') || 'no change'}.`, category: 'approvals', icon: 'shield' }),
  'company.budgets_updated': () => ({ text: 'You updated the capital allocation and operating caps.', category: 'money', icon: 'finance' }),
  'company.operating_mandate_updated': () => ({ text: 'You revised the company mandate and delegation limits.', category: 'direction', icon: 'compass' }),
  'company.direction_set': (e) => ({ text: `${e.payload?.setByRole === 'Owner' ? 'You set' : 'The CEO set'} a new operating direction: “${esc(e.payload?.headline || 'unnamed')}”.`, category: 'direction', icon: 'compass' }),
  'company.direction_cleared': () => ({ text: 'You cleared the operating direction. The CEO will choose a new one next cycle.', category: 'direction', icon: 'compass' }),
  'company.ceo_cycle_started': () => ({ text: 'The CEO started a new operating cycle.', category: 'work', icon: 'work' }),
  'company.reviewer_assigned': (e) => ({ text: `The CEO assigned ${esc(e.payload?.modelId || 'a model')} as the company reviewer.`, category: 'models', icon: 'models' }),
  'company.bound_exceeded': () => ({ text: 'A spending bound was exceeded. The company paused for review.', category: 'money', icon: 'alert' }),
  'company.sms_bound_exceeded': () => ({ text: 'A notification cost exceeded its bound. The company paused for review.', category: 'money', icon: 'alert' }),
  'company.tool_bound_exceeded': () => ({ text: 'An external tool exceeded its cost bound. The company paused for review.', category: 'external', icon: 'alert' }),
  'company.external_completion_variance': () => ({ text: 'A recorded external completion did not match its approved bound.', category: 'external', icon: 'alert' }),
  'worker.scheduler_failed': () => ({ text: 'The scheduler stopped and paused the company. Check model configuration.', category: 'system', icon: 'alert' }),

  'employee.ceo_created': (e) => ({ text: `${employeeName(e.entity_id)} was appointed CEO.`, category: 'people', icon: 'person', ref: { employee: e.entity_id } }),
  'employee.hired': (e) => ({ text: `${employeeName(e.actor)} hired ${employeeName(e.entity_id)} as ${esc(e.payload?.role || 'a new role')}.`, category: 'people', icon: 'person', ref: { employee: e.entity_id } }),
  'employee.model_assigned': (e) => ({ text: `${employeeName(e.actor)} moved ${employeeName(e.entity_id)} to ${esc(e.payload?.modelId || 'a different model')}.`, category: 'models', icon: 'models', ref: { employee: e.entity_id } }),

  'task.created': (e) => ({ text: `New objective: ${objective(e.entity_id) || truncate(e.payload?.objective, 70) || 'work assigned'}.`, category: 'work', icon: 'work', ref: { task: e.entity_id } }),
  'task.plan_accepted': (e) => ({ text: `Plan accepted for ${objective(e.entity_id) || 'an objective'}.`, category: 'work', icon: 'check', ref: { task: e.entity_id } }),
  'task.plan_rejected': (e) => ({ text: `Plan rejected for ${objective(e.entity_id) || 'an objective'}. The agent must replan.`, category: 'work', icon: 'alert', ref: { task: e.entity_id } }),
  'document.saved': (e) => ({ text: `Saved ${esc(e.payload?.path || 'a shared document')}, version ${e.payload?.version || 1}.`, category: 'work', icon: 'work' }),
  'task.self_reviewed': (e) => ({ text: `Agent self-check returned ${esc(titleCase(e.payload?.decision || 'a decision'))} on ${objective(e.entity_id) || 'an objective'}.`, category: 'work', icon: 'check', ref: { task: e.entity_id } }),
  'task.self_check_assigned': (e) => ({ text: `Assigned the self-check to the task's worker model.`, category: 'work', icon: 'check', ref: { task: e.entity_id } }),
  'task.reviewed': (e) => ({ text: `Review returned ${esc(titleCase(e.payload?.decision || 'a decision'))} on ${objective(e.entity_id) || 'an objective'}.`, category: 'work', icon: 'check', ref: { task: e.entity_id } }),
  'task.blocked_budget': (e) => ({ text: `Work stopped on budget: ${esc(e.payload?.reason || 'the next call would exceed its allocation')}.`, category: 'money', icon: 'alert', ref: { task: e.entity_id } }),
  'task.invalid_output': (e) => ({ text: `An agent returned output that failed validation on ${objective(e.entity_id) || 'an objective'}.`, category: 'work', icon: 'alert', ref: { task: e.entity_id } }),
  'task.cancelled': (e) => ({ text: `${employeeName(e.actor)} cancelled ${objective(e.entity_id) || 'an objective'}.`, category: 'work', icon: 'close', ref: { task: e.entity_id } }),
  'task.expired': (e) => ({ text: `${objective(e.entity_id) || 'An objective'} passed its time limit.`, category: 'work', icon: 'clock', ref: { task: e.entity_id } }),
  'task.retry_requested': (e) => ({ text: `You retried ${objective(e.entity_id) || 'an objective'}.`, category: 'work', icon: 'work', ref: { task: e.entity_id } }),
  'task.artifact_created': (e) => ({ text: `A deliverable was produced for ${objective(e.entity_id) || 'an objective'}.`, category: 'work', icon: 'download', ref: { task: e.entity_id } }),
  'artifact.created': (e) => ({ text: 'A downloadable file was saved to the record.', category: 'work', icon: 'download', ref: { task: e.payload?.taskId } }),

  'operation.applied': (e) => ({ text: `${employeeName(e.actor)} ${esc(operation(e.payload?.type))}.`, category: 'work', icon: 'branch' }),
  'operation.blocked': (e) => ({ text: `An attempt to ${esc(operation(e.payload?.type)).replace(/^(hired someone|decided to wait)$/, 'act')} was blocked: ${esc(e.payload?.reason || 'it failed validation')}`, category: 'work', icon: 'alert' }),

  'experiment.created': (e) => ({ text: `New opportunity opened: ${experimentTitle(e.entity_id) || esc(e.payload?.title || 'an experiment')}.`, category: 'work', icon: 'idea', ref: { experiment: e.entity_id } }),
  'experiment.updated': (e) => ({ text: `${experimentTitle(e.entity_id) || 'An opportunity'} moved to ${esc(titleCase(e.payload?.status || 'a new stage'))}.`, category: 'work', icon: 'idea', ref: { experiment: e.entity_id } }),

  'message.created': (e) => ({ text: `${employeeName(e.payload?.senderId)} → ${employeeName(e.payload?.recipientId)}: ${esc(e.payload?.subject || 'a message')}`, category: 'people', icon: 'chat' }),
  'meeting.scheduled': (e) => ({ text: `${employeeName(e.actor)} scheduled “${meetingTitle(e.entity_id) || esc(e.payload?.title || 'a meeting')}”.`, category: 'people', icon: 'team', ref: { meeting: e.entity_id } }),
  'meeting.started': (e) => ({ text: `“${meetingTitle(e.entity_id) || 'A meeting'}” began gathering contributions.`, category: 'people', icon: 'team', ref: { meeting: e.entity_id } }),
  'meeting.contributions_ready': (e) => ({ text: `All contributions are in for “${meetingTitle(e.entity_id) || 'a meeting'}”.`, category: 'people', icon: 'team', ref: { meeting: e.entity_id } }),
  'meeting.completed': (e) => ({ text: `“${meetingTitle(e.entity_id) || 'A meeting'}” reached a recorded decision.`, category: 'people', icon: 'check', ref: { meeting: e.entity_id } }),
  'meeting.cancelled': (e) => ({ text: `“${meetingTitle(e.entity_id) || 'A meeting'}” was cancelled: ${esc(e.payload?.reason || 'no reason recorded')}`, category: 'people', icon: 'close', ref: { meeting: e.entity_id } }),

  'action.proposed': (e) => ({ text: `${employeeName(e.actor)} proposed ${esc(titleCase(e.payload?.actionType || 'an action'))}${e.payload?.target ? ` on ${esc(e.payload.target)}` : ''}.`, category: 'approvals', icon: 'inbox', ref: { proposal: e.entity_id } }),
  'action.decided': (e) => ({ text: `You ${e.payload?.decision === 'APPROVE' ? 'approved' : 'rejected'} ${actionOf(e.entity_id) ? esc(titleCase(actionOf(e.entity_id).action_type)) : 'a proposal'}.`, category: 'approvals', icon: 'shield', ref: { proposal: e.entity_id } }),
  'action.cancelled': (e) => ({ text: 'An approved action was withdrawn before execution.', category: 'approvals', icon: 'close', ref: { proposal: e.entity_id } }),
  'action.expired': (e) => ({ text: 'A proposal expired before you decided on it.', category: 'approvals', icon: 'clock', ref: { proposal: e.entity_id } }),
  'action.owner_completed': (e) => ({ text: 'You recorded an external action as completed.', category: 'external', icon: 'check', ref: { proposal: e.entity_id } }),
  'action.sandbox_executed': (e) => ({ text: 'A sandbox action ran. No real money moved.', category: 'external', icon: 'check', ref: { proposal: e.entity_id } }),

  'grant.created': (e) => ({ text: `You granted standing authority for ${esc(titleCase(e.payload?.actionType || 'an action'))} on ${esc(e.payload?.target || 'a target')}.`, category: 'approvals', icon: 'shield' }),
  'grant.revoked': () => ({ text: 'You revoked a standing grant.', category: 'approvals', icon: 'shield' }),

  'ledger.recorded': (e) => ({ text: `${esc(titleCase(e.payload?.kind || 'Money'))} recorded: ${money(e.payload?.amountUsd)}${e.payload?.externalReference ? ` (reference: ${esc(e.payload.externalReference)})` : ''}.`, category: 'money', icon: 'dollar' }),

  'call.reserved': (e) => ({ text: `Budget held for ${esc(e.payload?.modelId || 'model')} call, up to ${micro(e.payload?.maximumMicroUsd)}.`, category: 'models', icon: 'models', ref: { task: e.payload?.taskId } }),
  'call.dispatched': (e) => ({ text: 'A model call was sent.', category: 'models', icon: 'models', ref: { task: e.payload?.taskId } }),
  'call.settled': (e) => ({ text: `Model call finished: ${micro(e.payload?.costMicroUsd, 4)} for ${Number(e.payload?.inputTokens || 0).toLocaleString()} in / ${Number(e.payload?.outputTokens || 0).toLocaleString()} out.`, category: 'models', icon: 'models', ref: { task: e.payload?.taskId } }),
  'call.uncertain': (e) => ({ text: `A model call finished without usable usage data: ${esc(e.payload?.reason || 'reason unrecorded')}. Reconcile it before trusting the cost.`, category: 'models', icon: 'alert' }),
  'call.reconciled': () => ({ text: 'You reconciled an uncertain model charge against the provider.', category: 'money', icon: 'check' }),
  'call.recovered': () => ({ text: 'An interrupted model call was recovered after restart.', category: 'system', icon: 'models' }),
  'call.dispatch_blocked': () => ({ text: 'A model call was blocked before dispatch.', category: 'models', icon: 'alert' }),

  'owner.requested': (e) => ({ text: `An agent asked you for help: ${esc(e.payload?.title || 'a request')}.`, category: 'approvals', icon: 'chat', ref: { request: e.entity_id } }),
  'owner.request_resolved': (e) => ({ text: `You marked a request ${esc(titleCase(e.payload?.status || 'resolved'))}${e.payload?.minutes ? ` after ${e.payload.minutes} minutes` : ''}.`, category: 'approvals', icon: 'check', ref: { request: e.entity_id } }),
  'owner.reminder_created': (e) => ({ text: `Setup reminder added: ${esc(e.payload?.title || 'a task for you')}.`, category: 'system', icon: 'bell', ref: { request: e.entity_id } }),

  'tool.dispatched': () => ({ text: 'An approved external read was sent.', category: 'external', icon: 'arrow' }),
  'tool.completed': () => ({ text: 'An approved external read returned.', category: 'external', icon: 'check' }),
  'tool.uncertain': () => ({ text: 'An external read did not confirm its outcome.', category: 'external', icon: 'alert' }),
  'tool.recovered_uncertain': () => ({ text: 'An interrupted external read was marked uncertain after restart.', category: 'external', icon: 'alert' }),

  'notification.dispatched': () => ({ text: 'A proposal alert was handed to the SMS provider.', category: 'external', icon: 'bell' }),
  'notification.sent': () => ({ text: 'A proposal alert was sent.', category: 'external', icon: 'bell' }),
  'notification.failed': () => ({ text: 'A proposal alert failed to send. The dashboard inbox still has it.', category: 'external', icon: 'alert' }),
  'notification.uncertain': () => ({ text: 'A proposal alert did not confirm. Reconcile its charge.', category: 'external', icon: 'alert' }),
  'notification.settled': () => ({ text: 'A notification charge settled.', category: 'money', icon: 'dollar' }),
  'notification.owner_reconciled': () => ({ text: 'You reconciled a notification charge.', category: 'money', icon: 'check' }),

  'sms.reply_applied': () => ({ text: 'A signed SMS reply recorded your decision.', category: 'approvals', icon: 'check' }),
  'sms.reply_stale': () => ({ text: 'An SMS reply arrived too late to apply.', category: 'approvals', icon: 'clock' }),
  'sms.reply_unrecognized': () => ({ text: 'An SMS reply did not match a pending proposal.', category: 'approvals', icon: 'alert' }),
};

export function describe(event) {
  const handler = DESCRIBE[event.type];
  if (handler) {
    try { return { ...handler(event), type: event.type }; } catch { /* fall through to the generic form */ }
  }
  return { text: esc(event.type.replaceAll('.', ' ').replaceAll('_', ' ').replace(/^./, c => c.toUpperCase()) + '.'), category: 'system', icon: 'log', type: event.type };
}

export const categories = CATEGORY;

export function refAttribute(ref) {
  if (!ref) return '';
  const [key, value] = Object.entries(ref)[0] || [];
  return value ? ` data-${key}="${esc(value)}"` : '';
}
