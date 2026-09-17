import { state } from '../lib/state.js';
import { api } from '../lib/api.js';
import { esc, titleCase, localDateTime, usdInput } from '../lib/format.js';
import { openModal, form, field, selectField, handleModal } from '../lib/modal.js';

const ACTION_TYPES = ['PURCHASE', 'SEND_MESSAGE', 'PUBLISH', 'CREATE_ACCOUNT', 'OTHER_EXTERNAL', 'READ_PUBLIC_PAGE', 'SANDBOX_PURCHASE'];
export function ownerProfile() {
  const p = state.data.ownerProfile || {};
  openModal('Owner profile', '<p class="modal-lede">Agents read this as company context. Include only information relevant to their work; do not enter passwords, API keys, or payment credentials.</p>'
    + form(field('Name','name',p.name || '')
      + field('Role','role',p.role || 'Owner')
      + field('Background and expertise','background',p.background || '', 'textarea')
      + field('Availability and time zone','availability',p.availability || '', 'textarea')
      + field('Contact and working preferences','preferences',p.preferences || '', 'textarea')
      + field('Constraints and relevant details','constraints',p.constraints || '', 'textarea'), 'Save profile'));
  for (const input of document.querySelectorAll('#modal-form input,#modal-form textarea')) if (input.name !== 'name') {
    input.required = false; input.closest('.field').querySelector('label small').textContent = 'Optional';
  }
  handleModal(x => api('/company/owner-profile','PUT',x), 'Owner profile saved. Agents can read it.');
}
export function testProvider(id) {
  const m = state.data.models.find(m => m.id === id);
  if (!m?.ready) return;
  const bound = (Math.min(1024,m.maxInputTokens)*Number(m.inputPerMillionUsd)+Math.min(1024,m.maxOutputTokens)*Number(m.outputPerMillionUsd))/1e6;
  const shown = (Math.ceil(bound*100)/100).toFixed(2);
  openModal(`Test ${m.name}`, `<p>Send one short structured request to <strong>${esc(m.model)}</strong>.</p><p>Maximum charge: <strong>$${shown}</strong>. Company spending caps and approval requirements apply. Tests can run while business operations are paused.</p>` + form('', 'Queue test'));
  handleModal(() => api(`/models/${encodeURIComponent(id)}/test`, 'POST', {}), 'Provider test queued. Its status and any approval request appear on the model card.');
}
export function addModelProfile(){
 const connections=state.data.models.filter(m=>m.provider!=='mock'&&!m.connectionId);
 openModal('Add model',form(selectField('Provider connection','connectionId',connections.map(m=>[m.id,m.name]),connections[0]?.id)
   +field('Display name','name','')+field('Model ID','model','')
   +'<p>Uses the selected connection and its existing credentials. Existing model cards and worker assignments stay independent.</p>'
   +'<details><summary>Advanced settings</summary>'+field('Input price per 1M tokens (USD)','inputPerMillionUsd','','number')+field('Output price per 1M tokens (USD)','outputPerMillionUsd','','number')
   +field('Input context allocation','maxInputTokens','16000','number')+field('Output token allocation','maxOutputTokens','3000','number')+'</details>','Add model'));
 for(const input of document.querySelectorAll('#modal-form [name$="PerMillionUsd"]')){input.required=false;input.step='0.000001';input.min='0';input.closest('.field').querySelector('label small').textContent='Optional';}
 handleModal(x=>api('/models','POST',{...x,inputPerMillionUsd:x.inputPerMillionUsd||'0',outputPerMillionUsd:x.outputPerMillionUsd||'0',maxInputTokens:Number(x.maxInputTokens),maxOutputTokens:Number(x.maxOutputTokens)}),'Model added. Configure any missing pricing before paid use.');
}

export function configureModel(id) {
  const m = state.data.models.find(model => model.id === id);
  if(m?.provider==='lmstudio'){
    openModal(`Configure ${m.name}`, '<p>Load the model in LM Studio, then enter its exact model ID. Changes apply to future calls. Local inference has no provider token charge.</p>'
      +form(field('LM Studio model ID','model',m.model)
      +'<details><summary>Advanced context settings</summary>'+field('Input token allocation','maxInputTokens',16000,'number')+field('Output token allocation','maxOutputTokens',3000,'number')+'<p>Hive checks the loaded context and reduces these limits when necessary.</p></details>','Save model'));
    handleModal(x=>api(`/models/${encodeURIComponent(id)}`,'PUT',{model:x.model,maxInputTokens:Number(x.maxInputTokens),maxOutputTokens:Number(x.maxOutputTokens)}),'Local model updated.');return;
  }
  if (!m?.live) return;
  openModal(`Configure ${m.name}`, '<p class="modal-lede">Enter the provider’s exact model ID. Pricing can be configured separately before the first paid call.</p>'
    + (m.credentialsConfigured ? '<p>API key is configured on the server.</p>' : '<div class="notice amber">API key is missing. Add the provider key to .env and restart the API.</div>')
    + form(field('Provider model ID', 'model', m.model)
      + '<details><summary>Advanced settings (optional)</summary><div class="form-grid">'
      + field('Input price per 1M tokens (USD)', 'inputPerMillionUsd', Number(m.inputPerMillionUsd) > 0 ? m.inputPerMillionUsd : '')
      + field('Output price per 1M tokens (USD)', 'outputPerMillionUsd', Number(m.outputPerMillionUsd) > 0 ? m.outputPerMillionUsd : '')
      + field('Input context allocation', 'maxInputTokens', m.maxInputTokens, 'number')
      + field('Initial output token allocation', 'maxOutputTokens', m.maxOutputTokens, 'number') + '</div><p class="muted">Workers can shift input capacity toward output after repeated cut-off replies. The combined context allocation stays fixed; spending controls apply to each adjusted request.</p></details>', 'Save model'));
  for (const input of document.querySelectorAll('#modal-form [name$="PerMillionUsd"]')) {
    input.step = '0.000001'; input.required = false;
    input.closest('.field').querySelector('label small').textContent = 'Optional';
  }
  for (const name of ['maxInputTokens','maxOutputTokens']) {
    const input=document.querySelector(`#modal-form [name="${name}"]`);
    input.required=false;input.placeholder=String(m[name]);
    input.min=name==='maxInputTokens'?'1000':'100';input.max=name==='maxInputTokens'?'1000000':'100000';
    input.closest('.field').querySelector('label small').textContent='Optional';
  }
  handleModal(x => {
    for (const key of ['inputPerMillionUsd', 'outputPerMillionUsd']) {
      const input = document.querySelector(`[name="${key}"]`);
      // A different model must not silently inherit the old model's rates.
      if (!x[key] || (x.model !== m.model && x[key] === input.defaultValue)) delete x[key];
    }
    for (const key of ['maxInputTokens','maxOutputTokens']) x[key]=x[key]?.trim() ? Number(x[key]) : m[key];
    return api(`/models/${encodeURIComponent(id)}`, 'PUT', x);
  }, 'Model saved. Unpriced models show pricing pending.');
}
export function requestReply() {
  const company=state.data.company;
  const requestId=crypto.randomUUID();
  const recipients=[['ceo','CEO'],...(state.data.employees || []).filter(e=>e.status==='ACTIVE'&&e.role!=='CEO').map(e=>[e.id,`${e.name} · ${e.role}`])];
  openModal('Ask an agent',form(selectField('To','recipientId',recipients,'ceo')
    +field('Subject','subject')+field('Message','body','','textarea')
    +field('Estimated cost (USD)','budgetUsd',usdInput((Number(company.cycle_budget)/1e6).toFixed(6)))
    +field('Token limit','tokenBudget',company.cycle_tokens,'number'),'Request reply'));
  handleModal(x=>{
    if(x.budgetUsd===document.querySelector('[name=budgetUsd]').defaultValue)x.budgetUsd=(Number(company.cycle_budget)/1e6).toFixed(6);
    return api('/conversations','POST',{...x,requestId,tokenBudget:Number(x.tokenBudget)});
  },'Reply queued. It will run under the company’s current controls.');
}
export function recoverCeoCycle() {
  const cycle = state.data.ceoCycle;
  if (!cycle) return;
  openModal('Recover CEO scheduling', '<p>The failed cycle stays in the record. A new cycle can start on the normal schedule when the company is running, using current limits and approval rules.</p>'
    + form(field('What changed or why continue?', 'reason', '', 'textarea'), 'Allow next cycle'));
  handleModal(x => api(`/company/cycles/${cycle.id}/acknowledge`, 'POST', x), 'Recovery recorded.');
}
const readyModels = () => state.data.models.filter((m) => m.ready);
const soon = (ms) => localDateTime(new Date(Date.now() + ms));

export function companyMandate() {
  const c = state.data.company;
  const choices = readyModels().map((m) => [m.id, `${m.name}${m.live ? ' (paid)' : ''}`]);
  openModal('Mission boundaries and team limits',
    '<p class="modal-lede">The mandate is the boundary you set for the company. Inside it the CEO chooses the strategy itself — you do not need to describe a business here, only what it must and must not do.</p>'
    + form(
      field('What the team must and must not do', 'mandate', state.data.mission?.boundaries||c.mandate, 'textarea')
      + `<div class="form-grid">
        ${selectField('CEO runs on', 'ceoModelId', choices, c.ceo_model_id)}
        ${field('Deepest hierarchy', 'maxDepth', c.max_depth, 'number', 'How many levels below the CEO')}
        ${field('Most agents at once', 'maxAgents', c.max_agents, 'number')}
        ${field('Calls in parallel', 'maxConcurrency', c.max_concurrency, 'number')}
        ${field('CEO wait interval (minutes)', 'cycleIntervalMinutes', c.cycle_interval_minutes, 'number')}
        ${field('Estimated cost per cycle (USD)', 'cycleBudgetUsd', usdInput((Number(c.cycle_budget) / 1e6).toFixed(6)))}
        ${field('Per cycle (tokens)', 'cycleTokens', c.cycle_tokens, 'number')}
      </div>
      <p class="section-note">Dollar amounts are estimates; token allocations bound the work tree. Actual spending follows company caps and approval requirements. Work already running keeps the limits it started with.</p>`,
      'Save',
    ));
  handleModal((x) => {
    if (x.cycleBudgetUsd === document.querySelector('[name=cycleBudgetUsd]').defaultValue) x.cycleBudgetUsd = (Number(c.cycle_budget) / 1e6).toFixed(6);
    for (const key of ['maxDepth', 'maxAgents', 'maxConcurrency', 'cycleIntervalMinutes', 'cycleTokens']) x[key] = Number(x[key]);
    return api('/company/mandate', 'PUT', x);
  }, 'Mandate updated.');
}

export function newTask(parent) {
  const ready = readyModels();
  if (!ready.length) return openModal('No model available', '<p>Load a model in LM Studio or configure a provider first.</p>');
  const preferred = ready.find((m) => !m.live && m.provider !== 'mock')?.id || ready[0].id;
  const choices = ready.map((m) => [m.id, `${m.name}${m.live ? ' (paid)' : ''}`]);
  openModal(parent ? 'Delegate from this objective' : 'Assign objective',
    `<p class="modal-lede">${parent
      ? 'Dollar budgets are estimates. Company spending controls still apply; the child shares its parent?s token allocation and deadline.'
      : 'Normally the CEO decides what to work on. Use this when you want something specific done.'}</p>`
    + form(
      field('Objective', 'objective', '', 'textarea', 'Name the decision or the deliverable, not the method.')
      + selectField('Opportunity attribution', 'experimentId', [['',parent?'Inherit from parent':'Unattributed'],...state.data.experiments.map(e=>[e.id,e.title])])
      + `<div class="form-grid">
        ${selectField('Worker model', 'modelId', choices, preferred)}
        ${field('Estimated cost (USD)', 'budgetUsd', parent ? '0.25' : '1.00')}
        ${field('Estimated tokens', 'tokenBudget', parent ? '30000' : '60000', 'number')}
        ${field('Time limit (minutes)', 'ttlMinutes', parent ? '30' : '120', 'number')}
        ${field('Job title', 'role', parent ? 'Analyst' : 'CEO')}
      </div>`,
      'Assign objective',
    ));
  handleModal((x) => api('/tasks', 'POST', {
    ...x, experimentId:x.experimentId||undefined, tokenBudget: Number(x.tokenBudget), ttlMinutes: Number(x.ttlMinutes), ...(parent ? { parentId: parent.id } : {}),
  }), 'Objective assigned.');
}

export function newExperiment(task) {
  const a = task?.artifact || {};
  openModal(task ? 'Turn this into an opportunity' : 'Open an opportunity',
    `<p class="modal-lede">${task ? 'Pre-filled from the agent brief. Change anything that is not supported by its evidence.' : 'The CEO normally opens these itself. Add one when you want to point the company at something specific.'}</p>`
    + form(
      field('Opportunity name', 'title', a.title || '')
      + field('Hypothesis', 'hypothesis', a.summary || '', 'textarea', 'Who pays, for what, and why now.')
      + field('Target customer', 'customer', a.customer || '')
      + field('Offer', 'offer', a.offer || '', 'textarea')
      + `<div class="form-grid">
        ${field('Acquisition channel', 'channel', a.channel || '')}
        ${field('Price', 'price', a.priceHypothesis || '')}
        ${field('Maximum test loss (USD)', 'maxLossUsd', Number(a.estimatedTestCostUsd || 0) === 0 ? '10.00' : usdInput(a.estimatedTestCostUsd) || '10.00')}
        ${field('Decision deadline', 'deadline', soon(7 * 86400000), 'datetime-local')}
      </div>`
      + field('Success criteria', 'successCriteria', a.successCriteria || '', 'textarea')
      + field('Stop criteria', 'killCriteria', a.killCriteria || '', 'textarea'),
      'Create opportunity',
    ));
  handleModal((x) => api('/experiments', 'POST', { ...x, deadline: new Date(x.deadline).toISOString(), ...(task ? { taskId: task.id } : {}) }));
}

export function newAction() {
  openModal('Propose an action',
    '<p class="modal-lede">Agents normally raise these. Use it to record an outside action you want held to the same approval trail.</p>'
    + form(
      selectField('Type', 'actionType', ACTION_TYPES.map((x) => [x, titleCase(x)]))
      + field('Target', 'target', '', 'text', 'The exact recipient, URL, vendor or system.')
      + field('Why', 'rationale', '', 'textarea')
      + field('What should happen', 'description', '', 'textarea')
      + '<details><summary>Advanced details (JSON)</summary><div class="field"><label for="f-payload">Additional fields (optional)</label><textarea id="f-payload" name="payload" placeholder=\'{"subject": "Example"}\'></textarea><small>Use a JSON object. These fields accompany the description and target.</small></div></details>'
      + `<div class="form-grid">${field('Maximum cost (USD)', 'maxCostUsd', '0.00')}${field('Expires', 'expiresAt', soon(86400000), 'datetime-local')}</div>`,
      'Propose action',
    ));
  handleModal(({ description, payload, ...x }) => {
    let extra = {};
    try {
      extra = payload.trim() ? JSON.parse(payload) : {};
      if (!extra || Array.isArray(extra) || typeof extra !== 'object') throw new SyntaxError();
    } catch {
      const input = document.querySelector('#f-payload');
      input.closest('details').open = true;
      input.setAttribute('aria-invalid', 'true');
      const error = document.createElement('small');
      error.className = 'field-error error-message';
      error.id = 'payload-error';
      error.textContent = 'Enter a JSON object with quoted field names. Check for a missing quote or brace.';
      input.after(error);
      input.setAttribute('aria-describedby', error.id);
      input.focus();
      return false;
    }
    return api('/actions', 'POST', { ...x, payload: { ...extra, description }, expiresAt: new Date(x.expiresAt).toISOString() });
  });
}

export function newGrant() {
  openModal('Grant standing authority',
    '<p class="modal-lede">A grant only applies where you have already turned the matching gate off. It never overrides your spending gate, an expired proposal, or an empty budget.</p>'
    + form(
      selectField('Type', 'actionType', ACTION_TYPES.map((x) => [x, titleCase(x)]))
      + field('Exactly what it covers', 'target', '', 'text', 'One vendor, one domain, one recipient. Narrow beats convenient.')
      + `<div class="form-grid">${field('Per action (USD)', 'maxTransactionUsd', '0.00')}${field('Total (USD)', 'totalCapUsd', '0.00')}${field('Expires', 'expiresAt', soon(86400000), 'datetime-local')}</div>`
      + field('What this is for', 'rationale', '', 'textarea'),
      'Create grant',
    ));
  handleModal((x) => api('/grants', 'POST', { ...x, expiresAt: new Date(x.expiresAt).toISOString() }));
}

export function newRequest() {
  openModal('Create request',
    '<p class="modal-lede">This becomes a tracked input the CEO reads, not a hidden instruction.</p>'
    + form(field('Subject', 'title') + field('What you want and why', 'details', '', 'textarea'), 'Create request'));
  handleModal((x) => api('/requests', 'POST', x));
}

export function newLedger() {
  openModal('Record a transaction',
    '<div class="notice amber">Record only money that actually moved. Entries cannot be edited or deleted afterwards.</div>'
    + form(
      selectField('Type', 'kind', [['FUNDING', 'Money you put in'], ['REVENUE', 'A customer paid'], ['COST', 'A business expense'], ['REFUND', 'You refunded a customer']])
      + `<div class="form-grid">${field('Amount (USD)', 'amountUsd')}<div class="field"><label for="f-externalReference">Receipt or reference (optional)</label><input id="f-externalReference" name="externalReference"><small>If omitted, a unique manual reference is recorded.</small></div></div>`
      + field('Description', 'description')
      + selectField('Opportunity', 'experimentId', [['', 'Company-wide'], ...state.data.experiments.map((e) => [e.id, e.title])]),
      'Record transaction',
    ));
  const key = crypto.randomUUID();
  handleModal((x) => {
    if (!window.confirm(`Record ${x.kind.toLowerCase()} of $${Number(x.amountUsd).toFixed(2)} for "${x.description}"? This ledger entry cannot be edited or deleted.`)) return false;
    if (!x.experimentId) delete x.experimentId;
    if (!x.externalReference.trim()) x.externalReference = `manual:${key}`;
    return api('/ledger', 'POST', { ...x, idempotencyKey: key });
  });
}

export function newMessage() {
  const recipients = [['company', 'Everyone'], ...(state.data.departments || []).map((d) => [d.id, `${d.name} department`]), ...(state.data.employees || []).filter((e) => e.status === 'ACTIVE').map((e) => [e.id, `${e.name} · ${e.role}`])];
  openModal('Message the team',
    form(field('Subject', 'subject') + field('What you want to say', 'body', '', 'textarea')
      + selectField('To', 'recipientId', recipients)
      + selectField('Kind', 'kind', [['MESSAGE', 'Just telling them'], ['REQUEST', 'Asking for something'], ['ESCALATION', 'Raising a concern']]), 'Send'));
  handleModal((x) => api('/messages', 'POST', { ...x, senderId: 'owner' }), 'Sent internally.');
}

export function newMeeting() {
  const choices = [...(state.data.departments || []).map((d) => [d.id, `${d.name} department`]), ...(state.data.employees || []).filter((e) => e.status === 'ACTIVE').map((e) => [e.id, `${e.name} · ${e.role}`])];
  openModal('Schedule meeting',
    '<p class="modal-lede">Every participant spends part of the budget writing a contribution, then one of them writes the decision. Keep it to a decision that genuinely needs more than one department.</p>'
    + form(
      field('Title', 'title') + field('The decision to reach', 'objective', '', 'textarea')
      + `<div class="field"><label for="f-participants">Who attends</label><select id="f-participants" name="participants" multiple required size="6">${choices.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('')}</select><small>Hold Ctrl or Command to pick several.</small></div>`
      + `<div class="form-grid">${field('When', 'scheduledAt', soon(3600000), 'datetime-local')}${field('Total budget (USD)', 'budgetUsd', '0.00')}${field('Total tokens', 'tokenBudget', '180000', 'number')}</div>`,
      'Schedule meeting',
    ));
  handleModal((x) => api('/meetings', 'POST', {
    ...x,
    participants: Array.from(document.querySelector('#f-participants').selectedOptions, (o) => o.value),
    tokenBudget: Number(x.tokenBudget),
    scheduledAt: new Date(x.scheduledAt).toISOString(),
    organizerId: 'owner',
  }));
}

export function reconcileCall(id) {
  openModal('Reconcile an uncertain charge',
    '<div class="notice amber">Confirm the real usage with the provider before releasing the hold. A timed-out call is not a free call.</div>'
    + form(field('What it actually cost (USD)', 'amountUsd') + field('Where you checked', 'rationale', '', 'textarea'), 'Record transaction'));
  handleModal((x) => api(`/calls/${id}/reconcile`, 'POST', x));
}

export function reconcileNotification(id) {
  openModal('Reconcile a notification charge',
    '<div class="notice amber">This releases the budget hold. It does not resend the message or assume it was delivered.</div>'
    + form(field('Confirmed cost (USD)', 'amountUsd') + field('Provider reference', 'externalReference') + field('Where you checked', 'rationale', '', 'textarea'), 'Record transaction'));
  handleModal((x) => api(`/notifications/${id}/reconcile`, 'POST', x));
}

export function recordCompletion(id) {
  openModal('Record what actually happened',
    '<div class="notice">This does not carry out the action. Record it only after you have done it yourself. An overrun, expired approval, or withdrawn approval pauses the company for review. Recording a receipt does not grant permission to act again.</div>'
    + form(field('What it actually cost (USD)', 'actualCostUsd', '0.00') + field('Receipt or reference', 'externalReference') + field('What happened', 'resultNote', '', 'textarea'), 'Record transaction'));
  handleModal((x) => {
    if (!window.confirm(`Record this completed action at $${x.actualCostUsd}, reference ${x.externalReference}? This receipt cannot be edited afterwards.`)) return false;
    return api(`/actions/${id}/record-completion`, 'POST', x);
  }, 'Receipt recorded.');
}

export function cancelMeeting(id) {
  openModal('Cancel this meeting', form(field('Why', 'reason', '', 'textarea'), 'Cancel meeting'));
  handleModal((x) => api(`/meetings/${id}/cancel`, 'POST', x));
}

export function confirmStop() {
  openModal('Stop everything?',
    '<p>No new model calls or outside actions will start. Calls already sent can still finish and still cost money — those charges are recorded either way.</p>'
    + form('', 'Stop all agents'));
  handleModal(() => api('/company/status', 'POST', { status: 'KILLED' }), 'All agent work stopped.');
}

const RECORD_KINDS = [
  ['ASSET', 'Something the company owns or can use'],
  ['ACCOUNT', 'An account or service it has'],
  ['CONSTRAINT', 'A limit it must operate within'],
  ['NOTE', 'Anything else worth the team knowing'],
];

export function newRecord(existing) {
  openModal(existing ? 'Edit company record' : 'Add company record',
    '<div class="notice">Every agent reads these. Never put a password, key or account number here — agents cannot use one, and it would end up in model prompts.</div>'
    + form(
      selectField('Kind', 'kind', RECORD_KINDS, existing?.kind || 'ASSET')
      + field('Title', 'title', existing?.title || '', 'text', 'What it is, in one line.')
      + field('What they should know', 'body', existing?.body || '', 'textarea',
        'Include what they may and may not do with it, and how to ask you for access.'),
      existing ? 'Save' : 'Add record',
    ));
  handleModal((x) => (existing ? api(`/company/records/${existing.id}`, 'PUT', x) : api('/company/records', 'POST', x)),
    'The team can see this now.');
}


export function confirmReset() {
  openModal('Reset business', form(`<div class="notice warning">
    <p>This clears the active organization, tasks, proposals, chats, documents, workspace, ledger and business records. The previous run is retained in a local archive.</p>
    <p>Provider credentials, model settings and spending/approval controls remain. Mailbox ingestion and SMS alerts are disabled. The new business starts paused.</p>
    <p>This cannot undo real emails, charges or commitments. Uncertain outside actions remain recorded as a constraint against accidental repeats.</p>
    <p>Reviewing the reset pauses the company. Active calls must finish first. Cancelling leaves it paused.</p>
  </div>`, 'Pause and review reset'));
  handleModal(async()=>{
    await api('/company/status','POST',{status:'PAUSED'});
    const preview=await api('/company/reset/preview','POST',{});
    if(preview.active)throw new Error(`${preview.active} call(s) or outside action(s) still active. The company is paused. Wait for completion, then review again.`);
    openModal('Confirm business reset',form(`<div class="notice warning"><p>Archive and clear ${preview.counts.tasks} tasks, ${preview.counts.employees} employees, ${preview.counts.ledger} ledger entries, ${preview.counts.emails} email records and ${preview.counts.documents} documents.</p></div>`
      +field('Type RESET BUSYWORK','phrase','','text')
      +'<label><input type="checkbox" name="acknowledge" required> I understand this clears the active business, preserves a local archive, and does not reverse real-world actions or charges.</label>', 'Reset business'));
    document.querySelector('#modal-form button[type="submit"]').classList.add('danger');
    handleModal(async x=>{
      if(x.phrase!=='RESET BUSYWORK'||x.acknowledge!=='on')throw new Error('Enter the exact confirmation phrase and check the acknowledgement.');
      await api('/company/reset','POST',{token:preview.token,phrase:x.phrase,acknowledge:true});
    },'Business reset. The new company is paused.');
    return false;
  });
}
