import { actionOutcomeText } from '../lib/record-display.js';
import {showWorkspace} from './workspace.js';
import { modelLabel, taskProblem } from '../lib/task-status.js';
import { state, employeeName, ACTIVE_TASK } from '../lib/state.js';
import { api } from '../lib/api.js';
import { esc, money, micro, date, dateTime, ago, until, badge, titleCase, truncate } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { openModal, form, field, selectField, detail, handleModal } from '../lib/modal.js';
import { employeeLoad, employeeModelPicker } from '../panels/org.js';

function artifactDownloads(taskId, taskFiles) {
  const files = taskFiles || (state.data.artifacts || []).filter((a) => a.task_id === taskId);
  if (!files.length) return '';
  return `<div class="detail-section"><h3>Files</h3>
    <p class="muted">Every version is kept. Check the evidence before using a draft.</p>
    ${files.map((a) => `<a class="file-row" href="/v1/artifacts/${encodeURIComponent(a.id)}/download" download>${icon('download')}<span>${esc(a.filename)}</span><span class="muted">${ago(a.created_at)} · ${esc(a.sha256.slice(0, 12))}</span></a>`).join('')}
  </div>`;
}

export async function showTask(id) {
  const record=await api(`/tasks/${encodeURIComponent(id)}`);
  const t=record.task;
  const a = t.artifact;
  const {children,parent,calls,allocation}=record;
  const existing=state.data.tasks.findIndex(x=>x.id===id);
  if(existing<0)state.data.tasks.push(t);else state.data.tasks[existing]=t;

  const attribution=state.data.experimentEconomics?.taskAttributions.find(x=>x.taskId===id);
  openModal('Objective', `
    <div class="detail-meta">${badge(t.status)}<span class="badge">${esc(t.role)}</span>
      <span class="badge">${money(t.spentUsd, 4)} / ${money(t.budgetUsd)} estimate</span>
      ${ACTIVE_TASK(t) ? `<span class="badge">${until(t.expires_at)} left</span>` : ''}</div>
    <h3 class="detail-objective">${esc(t.objective)}</h3>
    <p class="muted">${t.employee_id ? `${esc(employeeName(t.employee_id))} · ` : ''}Worker: ${esc(modelLabel(t.model_id))} ? Checks its own work${parent ? ' · delegated from a parent objective' : ''}</p>
    ${t.error ? `<div class="notice amber">${esc(taskProblem(t))}${t.status === "BLOCKED_BUDGET" ? '<p><button class="text-link" data-page="settings">Open spending controls</button>. Saving spending limits automatically rechecks cost-cap blockers.</p>' : ""}</div>` : ''}
    <div class="detail-section"><h3>Estimate and execution limits</h3><p class="muted">Dollar estimates do not authorize spending or block work. Company caps and approval requirements govern actual charges.</p>${detail([
      ['Settled model costs',money(t.spentUsd,4)],['Unresolved model holds',money(t.reservedUsd,4)],
      ['Delegated to child tasks',money(allocation.delegatedUsd)],['Scheduled meetings',money(allocation.scheduledMeetingsUsd)],
      ['Estimate less costs and delegated estimates',money(allocation.remainingUsd,4)],['Tokens used or held',String(allocation.usedOrHeldTokens)],
      ['Tokens delegated / scheduled',`${allocation.delegatedTokens} / ${allocation.scheduledMeetingTokens}`],['Token estimate balance',String(allocation.remainingTokens)],
    ])}</div>
    ${parent ? `<p><button class="text-link" data-task="${parent.id}">${icon('arrow')}Parent objective</button></p>` : ''}

    <div class="detail-section"><h3>Opportunity attribution</h3><p class="muted">Associates costs with this opportunity, including delegated work unless it has its own tag. Changing attribution is audited and does not alter ledger entries or spending permissions.</p>${form(selectField('Opportunity', 'experimentId', [['','Unattributed'],...state.data.experiments.map(e=>[e.id,e.title])],attribution?.experimentId||''),'Save attribution')}${attribution?.experimentId&&!attribution.explicit?'<p class="muted">Currently inherited from a parent objective.</p>':''}</div>
    ${t.plan ? `<div class="detail-section"><h3>The plan it agreed to</h3><p>${esc(t.plan.understanding)}</p><ol>${t.plan.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>` : ''}

    ${a ? `<div class="detail-section"><h3>What it produced</h3>
      <h2>${esc(a.title)}</h2><p>${esc(a.summary)}</p>
      ${a.customer ? detail([['Customer', a.customer], ['Problem', a.problem], ['Offer', a.offer], ['Channel', a.channel], ['Price hypothesis', a.priceHypothesis], ['How to test it', a.validationTest], ['Continue if', a.successCriteria], ['Stop if', a.killCriteria]]) : ''}
      ${a.evidence?.length ? `<h3>Evidence</h3>${a.evidence.map((e) => `<p class="evidence">${badge(e.kind)} ${esc(e.observation)}<br><span class="muted">${esc(e.source)}</span></p>`).join('')}` : ''}
      ${a.limitations?.length ? `<h3>What it does not know</h3><ul>${a.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${a.ownerActions?.length ? `<h3>Needs you</h3><ul>${a.ownerActions.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${a.customer ? `<button class="primary" data-promote="${t.id}">Turn this into an opportunity</button>` : ''}
    </div>` : ''}

    ${artifactDownloads(t.id,record.artifacts)}

    ${t.review ? `<div class="detail-section"><h3>${t.review.kind === 'SELF' ? 'Self-check' : 'Historical review'}</h3>${badge(t.review.decision)}
      <ul>${t.review.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      <p>${esc(t.review.nextAction)}</p></div>` : ''}

    ${children.length ? `<div class="detail-section"><h3>Delegated from this</h3>${children.map((c) => `<button class="mini-row" data-task="${c.id}"><div><strong>${truncate(c.objective, 70)}</strong><span class="row-detail">${esc(employeeName(c.employee_id))}</span></div>${badge(c.status)}</button>`).join('')}</div>` : ''}

    ${calls.length ? `<div class="detail-section"><h3>Model calls</h3>${calls.map((c) => `<div class="mini-row static"><div><strong>${esc(titleCase(c.phase))}</strong><span class="row-detail">${esc(c.model_id)} · ${c.input_tokens ?? '—'} in / ${c.output_tokens ?? '—'} out</span></div><span>${c.settled === null ? 'unsettled' : micro(c.settled, 4)}</span></div>`).join('')}</div>` : ''}

    <div class="form-actions">
      ${record.counts.children>children.length||record.counts.calls>calls.length?'<p class="muted">Recent children and calls shown. Allocation totals include the full history.</p>':''}
      ${['FAILED', 'BLOCKED_BUDGET', 'BLOCKED_APPROVAL'].includes(t.status) ? `<button data-retry="${t.id}">Retry</button>` : ''}
      ${ACTIVE_TASK(t) ? `<button data-delegate="${t.id}">Delegate from this</button><button class="danger" data-cancel="${t.id}">Cancel this branch</button>` : ''}
    </div>`, { wide: true });
  handleModal(x=>api(`/tasks/${encodeURIComponent(id)}/experiment`,'PUT',{experimentId:x.experimentId||null}),'Opportunity attribution updated.');
}

const TRAIT_MEANING = {
  caution: 'How much they weigh a downside before acting',
  rigor: 'How much evidence they need before stating something',
  dissent: 'How hard they push back and escalate',
  initiative: 'How much they act without being told',
  thrift: 'How tightly they hold the budget',
};

/** Traits are only worth showing because they are written into the agent's prompt. */
function traitBars(traits) {
  if (!traits || typeof traits !== 'object') return '';
  const rows = Object.entries(traits).filter(([, v]) => typeof v === 'number');
  if (!rows.length) return '';
  return `<div class="detail-section"><h3>How they work</h3>
    <div class="traits">${rows.map(([key, value]) => `<div class="trait" title="${esc(TRAIT_MEANING[key] || '')}">
      <span class="trait-name">${esc(key)}</span>
      <span class="trait-scale" role="img" aria-label="${esc(key)} ${value} of 5">${
        Array.from({ length: 5 }, (_, i) => `<i class="${i < value ? 'on' : ''}"></i>`).join('')
      }</span>
    </div>`).join('')}</div>
    <p class="section-note">These are written into this agent's instructions, so they change how it actually works.</p>
  </div>`;
}

export function showEmployee(id) {
  const person = state.data.employees.find((e) => e.id === id);
  if (!person) return;
  const load = employeeLoad(id);
  const manager = state.data.employees.find((e) => e.id === person.manager_id);
  const reports = state.data.employees.filter((e) => e.manager_id === id);
  const department = state.data.departments.find((d) => d.id === person.department_id);
  const model = state.data.models.find((m) => m.id === person.model_id);
  const messages = state.data.messages.filter((m) => m.sender_id === id || m.recipient_id === id);

  openModal(person.name, `
    ${person.status === 'ACTIVE' ? employeeModelPicker(person) : ''}
    ${state.data.workspacesAvailable?'<button id="employee-workspace">Workspace files</button>':''}
    <div class="detail-meta">${badge(person.status)}<span class="badge">${esc(person.role)}</span><span class="badge">${esc(department?.name || person.department_id)}</span><span class="badge">Level ${person.depth}</span></div>
    <div class="employee-head">
      <span class="avatar large">${esc(person.name[0])}</span>
      <div>
        <p class="muted">${manager ? `Reports to <button class="text-link inline" data-employee="${manager.id}">${esc(manager.name)}</button>` : 'Reports to you'} · hired ${ago(person.created_at)}</p>
        <p class="muted">${icon('models')}${esc(model?.name || person.model_id)}${model?.live ? ' · paid per call' : ' · free'}</p>
      </div>
    </div>

    ${person.bio ? `<div class="detail-section"><h3>Who they are</h3><p>${esc(person.bio)}</p></div>` : ''}
    ${traitBars(person.traits)}
    <div class="detail-section"><h3>Charter</h3><p>${esc(person.charter)}</p></div>

    <div class="detail-stats">
      <div><strong>${load.active.length}</strong><span>open now</span></div>
      <div><strong>${load.tasks.length}</strong><span>total objectives</span></div>
      <div><strong>${money(load.spend, load.spend < 1 ? 4 : 2)}</strong><span>spent</span></div>
      <div><strong>${reports.length}</strong><span>${reports.length === 1 ? 'report' : 'reports'}</span></div>
    </div>

    ${reports.length ? `<div class="detail-section"><h3>Manages</h3>${reports.map((r) => `<button class="chip" data-employee="${r.id}">${esc(r.name)} · ${esc(r.role)}</button>`).join('')}</div>` : ''}

    ${load.tasks.length ? `<div class="detail-section"><h3>Its work</h3>${load.tasks.slice(0, 12).map((t) => `<button class="mini-row" data-task="${t.id}"><div><strong>${truncate(t.objective, 74)}</strong><span class="row-detail">${money(t.spentUsd, 4)} · ${date(t.created_at)}</span></div>${badge(t.status)}</button>`).join('')}</div>`
      : '<div class="detail-section"><h3>Its work</h3><p class="muted">Nothing assigned yet.</p></div>'}

    ${messages.length ? `<div class="detail-section"><h3>What it has said</h3>${messages.slice(0, 8).map((m) => `<div class="mini-row static"><div><strong>${esc(m.subject)}</strong><span class="row-detail">${esc(m.sender_id === id ? `to ${employeeName(m.recipient_id)}` : `from ${employeeName(m.sender_id)}`)} · ${ago(m.created_at)}</span></div>${badge(m.kind)}</div>`).join('')}</div>` : ''}
  `, { wide: true });
  document.querySelector('#employee-workspace')?.addEventListener('click',()=>showWorkspace(id));
}

export function showExperiment(id) {
  const e = state.data.experiments.find((x) => x.id === id);
  if (!e) return;
  const entries = (state.data.experimentTotals||[]).filter((l) => l.experiment_id === id);
  const economics=state.data.experimentEconomics?.experiments.find(x=>x.experimentId===id);
  const sum = (kind) => entries.filter((l) => l.kind === kind).reduce((s, l) => s + Number(l.amount), 0);
  const source = e.task_id ? state.data.tasks.find((t) => t.id === e.task_id) : null;

  openModal(e.title, `
    <div class="detail-meta">${badge(e.status)}<span class="badge">${esc(e.price)}</span><span class="badge">decide by ${date(e.deadline)}</span></div>
    <p class="detail-objective">${esc(e.hypothesis)}</p>
    ${detail([['Who buys it', e.customer], ['What they get', e.offer], ['How we reach them', e.channel], ['Continue if', e.success_criteria], ['Stop if', e.kill_criteria]])}
    <div class="detail-stats">
      <div><strong>${micro(economics?.revenueMicroUsd??sum('REVENUE'))}</strong><span>earned</span></div>
      <div><strong>${economics?micro(BigInt(economics.modelCostsMicroUsd)+BigInt(economics.otherCostsMicroUsd)):micro(sum('COST'))}</strong><span>settled costs</span></div>
      <div><strong>${micro(economics?.refundsMicroUsd??sum('REFUND'))}</strong><span>refunded</span></div>
      <div><strong>${micro(e.max_loss)}</strong><span>max allowed loss</span></div>
    </div>
    ${economics?`<div class="detail-section"><h3>Experiment economics</h3>${detail([['Model costs',micro(economics.modelCostsMicroUsd)],['Other costs',micro(economics.otherCostsMicroUsd)],['Net including model costs',micro(economics.netMicroUsd)],['Unresolved model holds',micro(economics.reservedModelCostsMicroUsd)],['Recorded owner time',`${economics.ownerMinutes} minutes`]])}<p class="muted">Explicit ledger and task attribution, including delegated work. Holds are not settled expenses. Owner time includes recorded requests only.</p></div>`:''}
    ${source ? `<p><button class="text-link" data-task="${source.id}">${icon('arrow')}The research this came from</button></p>` : ''}
    ${(e.evidence || []).map((v) => `<div class="notice"><span class="row-detail">${esc(v.kind==='SOURCE_RECORD'?'Retrieved source (unverified)':v.kind==='AGENT_ASSESSMENT'?'Agent assessment':'Owner note')} · ${esc(employeeName(v.source))} ${v.date?date(v.date):''}</span><p>${esc(v.note || JSON.stringify(v))}</p>${v.actionId?`<button class="text-link" data-proposal="${esc(v.actionId)}">View source record</button>`:''}${v.taskId?`<button class="text-link" data-task="${esc(v.taskId)}">Reviewed work</button>`:''}</div>`).join('')}
    <div class="detail-section"><h3>Move it along</h3>
    ${form(selectField('Stage', 'status', ['DRAFT', 'VALIDATING', 'DELIVERING', 'REPEATING', 'KILLED', 'ARCHIVED'].map((s) => [s, titleCase(s)]), e.status)
    + field('What changed and why', 'note', '', 'textarea'), 'Update stage')}</div>
  `, { wide: true });
  handleModal((x) => api(`/experiments/${id}`, 'PATCH', x));
}

export async function showProposal(id) {
  const a = await api(`/actions/${encodeURIComponent(id)}`);
  const index=state.data.actions.findIndex(x=>x.id===id);
  if(index<0)state.data.actions.push(a);else state.data.actions[index]=a;
  const task = a.task_id ? state.data.tasks.find((t) => t.id === a.task_id) : null;
  const asker = a.payload?.proposedBy ? employeeName(a.payload.proposedBy) : null;
  const cost = Number(a.max_cost);
  const description=[a.payload?.description,a.payload?.draft,a.payload?.body].find(value=>typeof value==='string' && value.trim());
  const businessEmail=a.payload?.integration==='business-email';
  const automaticPublish=a.action_type==='PUBLISH' && a.payload?.executionMode==='NETLIFY_AUTOMATIC';
  const ownerAssisted=!businessEmail && !automaticPublish && !['MODEL_CALL','READ_PUBLIC_PAGE','SANDBOX_PURCHASE'].includes(a.action_type);
  const experiment=(state.data.experiments || []).find(e=>e.id===a.experiment_id);

  openModal('Proposal', `
    ${actionOutcomeText[a.status]?'<p class="notice">'+esc(actionOutcomeText[a.status])+'</p>':''}
    <div class="detail-meta">${badge(a.status)}<span class="badge">${esc(titleCase(a.action_type))}</span>${cost > 0 ? `<span class="badge amber">up to ${micro(a.max_cost)}</span>` : businessEmail?'<span class="badge">Existing mailbox</span>':'<span class="badge">no cost</span>'}</div>
    <div class="detail-section"><h3>Why they want to</h3><p class="detail-objective">${esc(a.rationale)}</p></div>
    ${detail([['Exactly what happens', `${titleCase(a.action_type)} → ${a.target}`], ['Most it can cost', `${micro(a.max_cost)} USD`], ['Asked by', asker || 'the company'], ['Expires', dateTime(a.expires_at)]])}
    ${businessEmail&&a.payload.attachments?.length?`<div class="detail-section"><h3>Attachments</h3>${a.payload.attachments.map((file,i)=>`<p><button class="text-link" data-frozen-attachment="${i}" data-email-id="${esc(a.payload.emailMessageId)}" data-filename="${esc(file.filename)}">${esc(file.filename)}</button> &middot; ${Number(file.size).toLocaleString()} bytes &middot; ${file.source==='workspace'?'Workspace file':`Document version ${file.version}`}</p>`).join('')}<p class="section-note">Download the exact frozen attachment to review it. Later source edits will not change this email.</p></div>`:''}
    ${a.revision_request?`<div class="notice"><strong>Changes requested</strong><p>${esc(a.revision_request.feedback)}</p><button data-task="${esc(a.revision_request.task_id)}">View revision task</button></div>`:''}
    ${a.revises_action_id?`<p>Revised proposal. Fresh approval required. <button data-proposal="${esc(a.revises_action_id)}">View original and feedback</button></p>`:''}
    ${task ? `<p><button class="text-link" data-task="${task.id}">${icon('arrow')}The objective behind this</button></p>` : ''}
    ${experiment?`<p>Experiment: <button class="text-link" data-experiment="${esc(experiment.id)}">${esc(experiment.title)}</button></p>`:''}
    ${description?`<div class="detail-section"><h3>Proposed action</h3><p class="proposal-description">${esc(description)}</p></div>`:''}
    ${a.status==='PENDING'?`<div class="notice ${ownerAssisted?'amber':''}">${ownerAssisted?'Owner-assisted execution. No adapter is installed for this action. Approval authorizes the proposal; you will need to carry it out and record the result.':businessEmail?`Automatic email. After approval, Busywork sends the exact recipients and message shown here from ${esc(a.payload.from||'the configured mailbox')} when mailbox and runtime permissions allow it.`:automaticPublish?'Automatic publication. After approval, the configured publisher can upload these exact frozen files to the production site. Final charges remain reserved until reconciled.':a.action_type==='MODEL_CALL'?'Automatic execution. After approval, the assigned model can run within its applicable limits.':a.action_type==='READ_PUBLIC_PAGE'?'Automatic research. After approval, the gateway can retrieve this public page when the company is running.':'Test fixture only. This does not make a real purchase.'}</div>`:''}
    ${a.payload?.renderer==='browser'?'<p class="notice">Browser read: one public document, with scripts and further network requests blocked. No clicks or form submissions.</p>':''}
    ${businessEmail?`<p><button data-email="${esc(a.payload.emailMessageId)}">Review email recipients and content</button></p>`:''}
    ${a.action_type==='PUBLISH' && a.payload?.releaseId?`<div class="detail-section"><h3>Frozen release</h3><p>Production / ${esc(a.payload.provider)} / ${esc(a.payload.siteId)}</p><p class="section-note">SHA-256: ${esc(a.payload.releaseHash)}</p><button data-release="${esc(a.payload.releaseId)}">Review frozen files</button></div>`:''}
    <details class="detail-section"${description?'':' open'}><summary>Exact request data</summary><pre>${esc(JSON.stringify(a.payload, null, 2))}</pre><p>Action hash</p><code style="overflow-wrap:anywhere">${esc(a.action_hash)}</code></details>
    ${a.status === 'PENDING'
      ? `<p class="section-note">Your approval binds to this exact proposal and this maximum. If the agent changes anything, it has to ask again.</p>
         <div class="form-actions" style="margin-bottom: 14px;">
           <button class="primary" data-quick-decision="${a.id}" data-decision="APPROVE">Quick Approve</button>
           ${a.action_type!=='MODEL_CALL'?'<button id="request-proposal-changes" type="button">Request changes</button>':''}
           <button class="danger" data-quick-decision="${a.id}" data-decision="REJECT">Quick Reject</button>
         </div>`
      + form(selectField('Decision', 'decision', [['APPROVE', 'Approve — do it once'], ['REJECT', 'Reject — do not do it'], ...(a.action_type==='MODEL_CALL'?[]:[['REQUEST_CHANGES', 'Request changes - revise and resubmit']])])
        + field('Your reasoning', 'rationale', '', 'textarea', 'Recorded permanently, and the agents can read it.'), 'Record decision with notes')
      : ['SANDBOX_PURCHASE', 'READ_PUBLIC_PAGE'].includes(a.action_type) && a.status === 'APPROVED'
        ? `<button class="primary" data-execute="${a.id}">Run it now</button>`
        : automaticPublish && ['EXECUTING','AWAITING_COST','UNCERTAIN','FAILED','EXECUTED'].includes(a.status)
          ? `<button data-deployment="${esc(a.id)}">Deployment status and costs</button>`
        : businessEmail && a.status==='APPROVED'
          ? '<div class="notice">Approved. The business-email worker will send when mailbox, employee permissions and runtime policy allow it.</div>'
        : a.status === 'APPROVED' && automaticPublish
          ? '<div class="notice">Approved for automatic publication. The publisher will run when configuration, spending limits and runtime status permit.</div>'
        : a.status === 'APPROVED' && a.action_type === 'MODEL_CALL'
          ? `<div class="notice">Approved. The worker will dispatch the call when its applicable runtime and spending limits allow it.</div>`
        : a.status === 'APPROVED'
          ? `<div class="notice amber">Approved, but there is no integration that can carry this out. Approving did not make it happen.</div>
             <div class="form-actions"><button class="primary" data-complete-action="${a.id}">I did it — record what happened</button><button class="danger" data-cancel-action="${a.id}">Withdraw</button></div>`
          : ownerAssisted && a.has_matching_approval && ['EXPIRED','CANCELLED'].includes(a.status)
            ? `<div class="notice amber">This authorization is ${a.status==='EXPIRED'?'expired':'withdrawn'}. Do not execute it. If the action already occurred, record its actual receipt; the company will pause for review.</div><button data-complete-action="${a.id}">Record an existing receipt</button>`
          : a.result ? `<div class="detail-section"><h3>Result</h3><pre>${esc(JSON.stringify(a.result, null, 2))}</pre></div>` : ''}
  `, { wide: true });
  if (a.status === 'PENDING') {
    document.getElementById('request-proposal-changes')?.addEventListener('click',()=>{
      document.querySelector('#modal [name="decision"]').value='REQUEST_CHANGES';
      const feedback=document.querySelector('#modal [name="rationale"]');feedback.placeholder='Describe what needs to change before you can approve this proposal.';feedback.focus();
    });
    handleModal((x) => x.decision==='REQUEST_CHANGES'
      ? api(`/actions/${id}/request-changes`, 'POST', {hash:a.action_hash,feedback:x.rationale})
      : api(`/actions/${id}/decision`, 'POST', { ...x, hash: a.action_hash }), 'Decision recorded.');
  }
}

export function showRequest(id) {
  const r = state.data.requests.find((x) => x.id === id);
  if (!r) return;
  openModal(r.title, `<p class="detail-objective">${esc(r.details)}</p>
    <p class="muted">Asked ${ago(r.created_at)}. Only you can do this one — it needs something outside the software.</p>`
    + (r.status === 'OPEN'
      ? form(selectField('Outcome', 'status', [['DONE', 'Done'], ['DECLINED', 'Not doing this']])
        + field('What happened', 'response', '', 'textarea')
        + field('Your time (minutes)', 'minutes', '0', 'number'), 'Record response')
      : `<div class="notice">${badge(r.status)} ${esc(r.response || '')}</div>`));
  if (r.status === 'OPEN') handleModal((x) => api(`/requests/${id}/resolve`, 'POST', { ...x, minutes: Number(x.minutes) }));
}

export function showMeeting(id) {
  const m = state.data.meetings.find((x) => x.id === id);
  if (!m) return;
  const tasks = state.data.tasks.filter((t) => t.meeting_id === id);
  const contributions = tasks.filter((t) => t.meeting_phase === 'CONTRIBUTION');
  const summary = tasks.find((t) => t.meeting_phase === 'SUMMARY');
  openModal(m.title, `
    <div class="detail-meta">${badge(m.status)}<span class="badge">${esc(employeeName(m.organizer_id))} called it</span><span class="badge">${dateTime(m.scheduled_at)}</span></div>
    <p class="detail-objective">${esc(m.objective)}</p>
    ${m.decisions?.summary
      ? `<div class="detail-section"><h3>What they decided</h3><p>${esc(m.decisions.summary)}</p>
         ${Array.isArray(m.decisions.decisions) ? `<ul>${m.decisions.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}</div>`
      : m.decisions?.reason ? `<div class="notice amber">${esc(m.decisions.reason)}</div>`
        : '<p class="muted">The outcome appears once every contribution is in and the summary passes review.</p>'}
    ${contributions.length ? `<div class="detail-section"><h3>Who contributed</h3>${contributions.map((t) => `<button class="mini-row" data-task="${t.id}"><div><strong>${esc(employeeName(t.employee_id))}</strong><span class="row-detail">${esc(t.role)}</span></div>${badge(t.status)}</button>`).join('')}</div>` : ''}
    ${summary ? `<p><button class="text-link" data-task="${summary.id}">${icon('arrow')}The written summary</button></p>` : ''}
    ${['SCHEDULED', 'RUNNING'].includes(m.status) ? `<div class="form-actions"><button class="danger" data-cancel-meeting="${m.id}">Cancel this meeting</button></div>` : ''}
  `, { wide: true });
}
