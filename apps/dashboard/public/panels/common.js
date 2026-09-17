import { objectiveTitle } from '../lib/record-display.js';
import {failureDismissed} from '../lib/alerts.js';
import { state, employeeName, ACTIVE_TASK, pendingCount } from '../lib/state.js';
import { esc, money, micro, date, ago, until, badge, titleCase, truncate } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { empty, table, meter } from '../lib/ui.js';
import { describe, refAttribute } from '../lib/events.js';

export function taskTable(tasks, options = {}) {
  if (!tasks.length) {
    return empty(
      options.emptyTitle || 'No work yet',
      options.emptyBody || 'The CEO creates and delegates objectives once the company is running.',
      options.emptyAction || '',
      'work',
    );
  }
  const rows = tasks.map((t) => {
    const person = t.employee_id ? employeeName(t.employee_id) : null;
    const spend = Number(t.spentUsd) || 0;
    const budget = Number(t.budgetUsd) || 0;
    return `<tr>
      <td class="wrap"><button class="table-link" data-task="${t.id}">${truncate(objectiveTitle(t), 84)}</button>
        <div class="row-detail">${person ? `${esc(person)} · ` : ''}${esc(t.role)}${t.parent_id ? ' · delegated' : ''}</div></td>
      <td>${badge(t.status)}${t.phase && ACTIVE_TASK(t) ? `<div class="row-detail">${esc(titleCase(t.phase))} phase</div>` : ''}</td>
      <td class="numeric">${money(spend, spend < 1 ? 4 : 2)}<div class="row-detail">${money(budget)} estimate</div></td>
      <td class="numeric">${ACTIVE_TASK(t) ? `<span title="Time remaining">${until(t.expires_at)} left</span>` : date(t.created_at)}</td>
    </tr>`;
  });
  return table([{ label: 'Objective' }, { label: 'Status' }, { label: 'Spend', numeric: true }, { label: ACTIVE_TASK(tasks[0]) ? 'Time' : 'Date', numeric: true }], rows);
}

/** Proposal cards lead with the agent's reason, because that is what the decision turns on. */
export function proposalList(limit = 3) {
  const d = state.data;
  const actions = d.actions.filter((a) => a.status === 'PENDING');
  const requests = d.requests.filter((r) => r.status === 'OPEN');
  const shownActions = actions.slice(0, limit);
  const shownRequests = requests.slice(0, Math.max(0, limit - shownActions.length));
  if (!shownActions.length && !shownRequests.length) {
    return empty('No pending approvals', 'Spending and outside actions appear here before they happen. The team keeps working meanwhile.', '', 'shield');
  }
  const cards = shownActions.map((a) => {
    const cost = Number(a.max_cost);
    const asker = a.payload?.proposedBy ? employeeName(a.payload.proposedBy) : null;
    return `<div class="proposal">
      <div class="proposal-top">
        <div class="proposal-icon">${icon(a.action_type === 'PURCHASE' ? 'dollar' : a.action_type === 'SEND_MESSAGE' ? 'chat' : a.action_type === 'READ_PUBLIC_PAGE' ? 'arrow' : 'inbox')}</div>
        <div>
          <h3>${esc(titleCase(a.action_type))} · ${truncate(a.target, 48)}</h3>
          <p class="proposal-why">${truncate(a.rationale, 150)}</p>
        </div>
      </div>
      <div class="proposal-meta">
        <span class="${cost > 0 ? 'cost' : 'muted'}">${cost > 0 ? `Up to ${micro(a.max_cost)}` : 'No cost'}</span>
        ${asker ? `<span class="muted">from ${esc(asker)}</span>` : ''}
        <span class="muted">expires in ${until(a.expires_at)}</span>
      </div>
      <div class="proposal-actions">
        <button class="primary" data-proposal="${a.id}">Review</button>
        <button class="small" data-quick-decision="${a.id}" data-decision="APPROVE">Approve</button>
        <button class="small danger" data-quick-decision="${a.id}" data-decision="REJECT">Reject</button>
      </div>
    </div>`;
  });
  const asks = shownRequests.map((r) => `<div class="proposal">
      <div class="proposal-top">
        <div class="proposal-icon">${icon('chat')}</div>
        <div><h3>${esc(r.title)}</h3><p class="proposal-why">${truncate((()=>{try{const value=JSON.parse(r.details);return value.kind==='MISSION_COMPLETION'?'Review evidence and the submitted deliverable.':value.kind==='CAMPAIGN_APPROVAL'?'Review the exact campaign template and sending limits.':value.kind==='DEPARTMENT'?value.purpose:r.details;}catch{return r.details;}})(),150)}</p></div>
      </div>
      <div class="proposal-meta"><span class="muted">Needs you, not money</span><span class="muted">${ago(r.created_at)}</span></div>
      <div class="proposal-actions"><button data-request="${r.id}">Respond</button></div>
    </div>`);
  const more = actions.length + requests.length - shownActions.length - shownRequests.length;
  return cards.join('') + asks.join('') + (more > 0 ? `<div class="proposal-more"><button class="text-link" data-page="inbox">${more} more waiting ${icon('arrow')}</button></div>` : '');
}

export function moneyChart() {
  const period = state.period || 7;
  const rows = state.data.daily.filter((r) => r.account !== 'TEST' && r.kind !== 'FUNDING');
  const points = Array.from({ length: period }, (_, i) => {
    const dt = new Date();
    dt.setUTCDate(dt.getUTCDate() - (period - 1 - i));
    const day = dt.toISOString().slice(0, 10);
    const entries = rows.filter((r) => r.day === day);
    const sum = (kinds) => entries.filter((r) => kinds.includes(r.kind)).reduce((s, r) => s + Number(r.amount) / 1e6, 0);
    return { day, revenue: sum(['REVENUE']), cost: sum(['COST', 'REFUND']) };
  });
  const peak = Math.max(2, ...points.flatMap((p) => [p.revenue, p.cost]));
  const magnitude = 10 ** Math.floor(Math.log10(peak * 1.25 / 2));
  const interval = [1, 2, 5, 10].map(n=>n*magnitude).find(n=>n>=peak*1.25/2);
  const max = interval * 2;
  const denom = Math.max(1, points.length - 1);
  const x = i => points.length === 1 ? 300 : 12 + (i * 576) / denom;
  const y = value => 150 - (value * 145) / max;
  const line = (key) => points.map((p, i) => `${x(i)},${y(p[key])}`).join(' ');
  const has = points.some((p) => p.revenue || p.cost);
  const labels = period === 1 ? [0] : [0, Math.floor(period / 3), Math.floor((period * 2) / 3), period - 1];
  return `<div class="chart"><output class="chart-tooltip" hidden></output>
    <div class="chart-y"><span>${money(max, 0)}</span><span>${money(max / 2, 0)}</span><span>$0</span></div>
    <svg viewBox="0 0 600 160" preserveAspectRatio="none" role="img" aria-label="Revenue and costs over the last ${period} days">
      <path class="chart-line" d="M0 5H600M0 78H600M0 150H600"/>
      ${has ? `<polyline points="${line('revenue')}" fill="none" stroke="var(--chart-revenue)" stroke-width="2.2"/><polyline points="${line('cost')}" fill="none" stroke="var(--chart-cost)" stroke-width="2.2"/>${points.map((p,i) => `<g tabindex="0" class="chart-point" data-chart-value="${esc(p.day+' UTC | Revenue '+money(p.revenue)+' | Costs and refunds '+money(p.cost))}" aria-label="${esc(p.day+' UTC: revenue '+money(p.revenue)+', costs and refunds '+money(p.cost))}"><rect x="${points.length===1?0:Math.max(0,x(i)-288/denom)}" y="0" width="${points.length===1?600:576/denom}" height="160" fill="transparent"/><circle class="${p.revenue===0?'zero-point':''}" cx="${x(i)}" cy="${y(p.revenue)}" r="3" fill="var(--chart-revenue)"/><circle class="${p.cost===0?'zero-point':''}" cx="${x(i)}" cy="${y(p.cost)}" r="3" fill="var(--chart-cost)"/></g>`).join('')}` : ''}
    </svg>
    ${!has ? '<div class="chart-empty"><strong>No money has moved yet.</strong><span>Recorded revenue and costs appear here.</span></div>' : ''}
    <div class="chart-labels">${labels.map((i) => `<span>${date(points[i].day + 'T12:00:00Z')}</span>`).join('')}</div>
  </div>`;
}

export function activityFeed(limit = 6, events = state.data.events) {
  const rows = events.slice(0, limit).map((e) => {
    const d = describe(e);
    const ref = refAttribute(d.ref);
    const inner = `<div class="activity-bubble ${d.category}">${icon(d.icon)}</div>
      <div class="activity-copy"><span>${d.text}</span><div class="activity-time">${ago(e.created_at)}</div></div>`;
    return ref
      ? `<button class="activity-row link"${ref}>${inner}</button>`
      : `<div class="activity-row">${inner}</div>`;
  });
  if (!rows.length) return empty('No activity recorded', 'Every decision, call and dollar lands here as it happens.', '', 'log');
  return `<div class="activity">${rows.join('')}</div>`;
}

export function capitalPanel() {
  const m = state.data.metrics;
  const allocation = Number(state.data.company.capitalAllocationUsd);
  const funded = Number(m.fundedUsd);
  const dailyUsed = Number(m.dailyUsedUsd);
  const dailyCap = Number(state.data.company.dailyCapUsd);
  // Cash on hand is the business account only; model spend is an operating cost
  // and is tracked against the daily cap below rather than against capital.
  const parts = [`${money(funded)} funded`];
  if (Number(m.revenueUsd) > 0) parts.push(`${money(m.revenueUsd)} earned`);
  if (Number(m.businessCostsUsd) > 0) parts.push(`less ${money(m.businessCostsUsd)} costs`);
  if (Number(m.refundsUsd) > 0) parts.push(`less ${money(m.refundsUsd)} refunded`);
  return `<div class="card-body">
    <div class="budget-summary"><span>Business balance (excludes models)</span><strong>${money(m.availableCapitalUsd)}</strong></div>
    <p class="section-note">${funded > 0 || Number(m.revenueUsd) > 0
      ? `${parts.join(', ')}. Model spend is an operating cost and is capped separately.`
      : 'No funding recorded yet. The allocation below is a plan, not money in an account.'}</p>
    <div class="budget-block">
      <div class="budget-summary"><span>Funding against your ${money(allocation)} allocation</span><span>${money(funded)}</span></div>
      ${meter(funded, allocation, { progress: true })}
    </div>
    <div class="budget-block">
      <div class="budget-summary"><span>Model spend today</span><span>${money(dailyUsed)} of ${money(dailyCap)}</span></div>
      ${meter(dailyUsed, dailyCap)}
    </div>
    ${Number(m.reservedUsd) > 0 ? `<p class="section-note">${money(m.reservedUsd)} is held for calls in flight and released when they settle.</p>` : ''}
  </div>`;
}

export function attentionStrip() {
  const d = state.data;
  const alerts = [];
  if (d.company.status === 'KILLED') alerts.push(['red', 'All agent work is stopped. Nothing will progress until you start the company again.', null, null]);
  else if (d.company.status === 'PAUSED') alerts.push(['amber', 'The company is paused. Agents will not pick up new work.', null, null]);
  const uncertain = d.calls.filter((c) => c.status === 'UNCERTAIN').length;
  if (uncertain) alerts.push(['amber', `${uncertain} model ${uncertain === 1 ? 'call' : 'calls'} finished without confirmed usage. Reconcile before trusting today's spend.`, null, null, 'work']);
  const blocked = d.tasks.filter((t) => t.status.startsWith('BLOCKED')).length;
  if (blocked) alerts.push(['amber', `${blocked} ${blocked === 1 ? 'objective is' : 'objectives are'} blocked and waiting on you.`, null, null, 'inbox']);
  const failed = d.tasks.filter((t) => t.status === 'FAILED' && !failureDismissed(t)).length;
  if (failed) alerts.push(['red', `${failed} ${failed === 1 ? 'objective' : 'objectives'} failed. The CEO schedules a recovery cycle after a short delay unless work or unresolved charges are blocking it.`, 'dismiss-failures', 'Dismiss', 'work']);
  const ready = d.models.filter((m) => m.ready && m.provider !== 'mock').length;
  if (!ready) alerts.push(['red', 'No real model is available. Load a model in LM Studio or configure a provider before starting.', null, null, 'models']);
  if (!alerts.length) return '';
  return `<div class="attention">${alerts.map(([tone, text, action, label, page]) => `<div class="attention-row ${tone}">${icon('alert')}<span>${esc(text)}</span>${action ? `<button class="small" data-action="${action}">${esc(label)}</button>` : ''}${page ? `<button class="small" data-page="${page}">Open</button>` : ''}</div>`).join('')}</div>`;
}

export function pendingBadge() {
  const n = pendingCount();
  return n ? `<span class="badge amber">${n} waiting</span>` : '<span class="badge green">All clear</span>';
}

function chartValue(event){
 const point=event.target.closest?.('[data-chart-value]');if(!point)return;
 const output=point.closest('.chart').querySelector('.chart-tooltip');output.textContent=point.dataset.chartValue;output.hidden=false;
}
for(const type of ['pointerover','focusin','click'])document.addEventListener(type,chartValue);
for(const type of ['pointerout','focusout'])document.addEventListener(type,event=>{
 const point=event.target.closest?.('[data-chart-value]');if(!point||point.contains(event.relatedTarget))return;
 point.closest('.chart').querySelector('.chart-tooltip').hidden=true;
});
