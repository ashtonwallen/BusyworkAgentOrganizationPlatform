import { ctx } from '../lib/context.js';
import { state, employeeName } from '../lib/state.js';
import { esc, date, ago, badge, truncate, titleCase } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { pageTitle, card, empty, table, button } from '../lib/ui.js';
import { orgChart, departmentSummary } from '../panels/org.js';

const KIND_TONE = { ESCALATION: 'amber', DECISION: 'green', REQUEST: 'blue', MESSAGE: '' };

function conversations() {
  const messages = state.data.messages || [];
  if (!messages.length) {
    return empty('No conversations yet', 'Agents message each other, escalate past their manager, and write to you. Everything they say is kept.', '', 'chat');
  }
  return `<div class="card-body messages">${messages.slice(0, 25).map((m) => `<div class="message ${KIND_TONE[m.kind] || ''}">
    <div class="message-head">
      <span class="badge ${KIND_TONE[m.kind] || 'blue'}">${esc(titleCase(m.kind))}</span>
      <strong>${esc(m.subject)}</strong>
    </div>
    <p>${truncate(m.body, 320)}</p>
    <div class="message-foot">
      <span>${esc(m.sender_name || employeeName(m.sender_id))} → ${esc(m.recipient_name || employeeName(m.recipient_id))}</span>
      <span>${ago(m.created_at)}${m.task_id ? ` · <button class="text-link inline" data-task="${m.task_id}">the objective</button>` : ''}</span>
    </div>
  </div>`).join('')}</div>`;
}

function meetings() {
  const rows = state.data.meetings || [];
  if (!rows.length) {
    return empty('No meetings', 'Agents call a meeting when a decision needs more than one department. Each one is bounded by a budget and produces a recorded outcome.', button('Schedule meeting', 'new-meeting', 'plus', false), 'team');
  }
  return table(
    [{ label: 'Meeting' }, { label: 'Called by' }, { label: 'When' }, { label: 'Outcome' }],
    rows.map((m) => `<tr>
      <td class="wrap"><button class="table-link" data-meeting="${m.id}">${esc(m.title)}</button><div class="row-detail">${truncate(m.objective, 90)}</div></td>
      <td>${esc(employeeName(m.organizer_id))}</td>
      <td>${date(m.scheduled_at)}<div class="row-detail">${ago(m.scheduled_at)}</div></td>
      <td>${badge(m.status)}${m.decisions?.summary ? `<div class="row-detail">${truncate(m.decisions.summary, 60)}</div>` : ''}</td>
    </tr>`),
  );
}

const recruitmentHiddenKey='busywork.recruitment.dismissed';
let hiddenPostings=new Set();try{const saved=JSON.parse(localStorage.getItem(recruitmentHiddenKey)||'[]');if(Array.isArray(saved))hiddenPostings=new Set(saved.filter(x=>typeof x==='string'));}catch{}
let showDismissed=false;
const postingKey=r=>r.task_id+':'+r.created_at;
function recruitment() {
  const postings=state.data.recruitmentSearches || [];
  if(!postings.length)return '<div class="card-body"><p>No recruitment postings.</p></div>';
  const hiddenCount=postings.filter(r=>hiddenPostings.has(postingKey(r))).length;
  const visible=postings.filter(r=>showDismissed||!hiddenPostings.has(postingKey(r)));
  const labels={OPEN:'Open',IN_PROGRESS:'In progress',ON_HOLD:'On hold',FILLED:'Filled',CLOSED:'Closed'};
  return `<div class="card-body"><div class="recruitment-toolbar">${postings.some(r=>r.posting_status==='CLOSED'&&!hiddenPostings.has(postingKey(r)))?'<button class="small quiet" data-recruitment-clear-closed>Dismiss closed unfilled roles</button>':''}${hiddenCount?`<button class="small quiet" data-recruitment-toggle>${showDismissed?'Hide dismissed':'Show dismissed'} (${hiddenCount})</button>`:''}</div>${!visible.length?'<p>No visible recruitment postings.</p>':''}<div class="recruitment-grid">${visible.map(r=>{
    const filled=r.posting_status==='FILLED',closed=r.posting_status==='CLOSED';
    return `<article class="recruitment-posting ${filled?'filled':''}">
      <header><h3>${esc(r.role)}</h3><span class="badge ${filled?'green':closed?'':'blue'}">${esc(labels[r.posting_status]||'Open')}</span></header>
      <dl><div><dt>Hiring manager</dt><dd>${esc(employeeName(r.employee_id))}</dd></div>
      <div><dt>Candidates</dt><dd>${r.candidate_count}</dd></div></dl>
      ${filled?`<div class="recruitment-hires"><span>Filled by</span>${r.hires.map(p=>`<button class="text-link" data-employee="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>`:closed?'<p class="section-note">Closed without a hire.</p>':`<p class="section-note">${esc(titleCase(r.status))}</p>`}
      ${r.requirements?`<details><summary>Role requirements</summary><p>${esc(r.requirements)}</p></details>`:''}
      <footer><span>${ago(r.created_at)}</span><button class="text-link" data-recruitment-dismiss="${esc(postingKey(r))}" title="Changes visibility in this browser; does not cancel hiring or delete history.">${hiddenPostings.has(postingKey(r))?'Restore':'Dismiss'}</button><button class="text-link" data-task="${esc(r.task_id)}">View hiring task</button></footer>
    </article>`;
  }).join('')}</div>${postings.length===24?'<p class="section-note">Showing active and recent postings (up to 24).</p>':''}</div>`;
}

export function team() {
  const people = (state.data.employees || []).filter((e) => e.status === 'ACTIVE');
  const c = state.data.company;
  return pageTitle('Team', `${people.length} ${people.length === 1 ? 'agent' : 'agents'} of a possible ${c.max_agents}, up to ${c.max_depth} levels deep. The CEO does the hiring.`,
    button('Message the team', 'new-message', 'chat', false) + button('Schedule meeting', 'new-meeting', 'team', false))
    + card('Org Chart', orgChart(), { subtitle: 'Click anyone to see what they are doing and what they have cost' })
    + card('Recruitment', recruitment())
    + `<div class="grid-2">
      ${card('Conversations', conversations(), { subtitle: 'Escalation goes past a manager without their permission' })}
      <div>
        ${card('Departments', departmentSummary())}
        ${card('Meetings', meetings(), { subtitle: 'Bounded, and only when a decision needs more than one department' })}
      </div>
    </div>`;
}

document.addEventListener('click',event=>{
 const button=event.target.closest('[data-recruitment-dismiss],[data-recruitment-clear-closed],[data-recruitment-toggle]');if(!button)return;
 if(button.hasAttribute('data-recruitment-toggle'))showDismissed=!showDismissed;
 else {
   if(button.hasAttribute('data-recruitment-clear-closed'))for(const r of state.data.recruitmentSearches||[])if(r.posting_status==='CLOSED')hiddenPostings.add(postingKey(r));
   if(button.hasAttribute('data-recruitment-dismiss')){const id=button.dataset.recruitmentDismiss;if(hiddenPostings.has(id))hiddenPostings.delete(id);else hiddenPostings.add(id);}
   try{localStorage.setItem(recruitmentHiddenKey,JSON.stringify([...hiddenPostings]));}catch{}
 }
 ctx.renderPage();
});
