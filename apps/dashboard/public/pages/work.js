import {backlogPanel} from '../panels/backlog.js';
import {api,toast} from '../lib/api.js';
import {ctx} from '../lib/context.js';
import { state, ACTIVE_TASK, employeeName } from '../lib/state.js';
import { esc, money, micro, badge, ago, titleCase } from '../lib/format.js';
import { pageTitle, card, empty, table, button } from '../lib/ui.js';
import { taskTable } from '../panels/common.js';
import { taskTree } from '../panels/worktree.js';

export function work() {
  const d = state.data;
  const viewMode = state.workView || 'tree';
  const open = d.tasks.filter(ACTIVE_TASK);
  const done = d.tasks.filter((t) => !ACTIVE_TASK(t));
  const uncertain = d.calls.filter((c) => c.status === 'UNCERTAIN');

  const investigation=id=>(d.reconciliationTasks||[]).find(r=>r.call_id===id||r.task_id===d.calls.find(c=>c.id===id)?.task_id);
  const paidUncertain=uncertain.filter(c=>c.is_live||Number(c.reserved)>0);
  const callRows = d.calls.map((c) => `<tr>
    <td>${esc(c.model_id)}<div class="row-detail">${esc(titleCase(c.phase))}${c.is_live ? ' · paid' : ' · free'}</div></td>
    <td>${badge(c.status)}</td>
    <td class="numeric">${c.input_tokens != null ? Number(c.input_tokens).toLocaleString() : '—'} in<div class="row-detail">${c.output_tokens != null ? Number(c.output_tokens).toLocaleString() : '—'} out</div></td>
    <td class="numeric">${c.settled === null ? '<span class="muted">unsettled</span>' : micro(c.settled, 2)}<div class="row-detail">${micro(c.reserved, 2)} held</div></td>
    <td class="numeric">${ago(c.created_at)}</td>
    <td>${c.status === 'UNCERTAIN' ? `<div class="form-actions">${investigation(c.id)?`<button class="small" data-task="${investigation(c.id).task_id}">View investigation</button>`:'Investigation pending'}<button class="small quiet" data-reconcile="${c.id}">Record charge manually</button></div>` : c.task_id ? `<button class="small quiet" data-task="${c.task_id}">Objective</button>` : ''}</td>
  </tr>`);

  const viewToggle = `<div class="tabs">
    <button data-work-view="tree" class="${viewMode === 'tree' ? 'selected' : ''}">Tree view</button>
    <button data-work-view="table" class="${viewMode === 'table' ? 'selected' : ''}">Table view</button>
  </div>`;

  const openBody = viewMode === 'tree'
    ? (open.length ? taskTree(open) : empty('No active objectives', d.company.status === 'RUNNING' ? 'The CEO opens the next objective on its cycle.' : 'Start the company and the CEO decides what to work on first.', button('Assign objective', 'new-task', 'plus', false), 'work'))
    : taskTable(open, {
      emptyTitle: 'No active objectives',
      emptyBody: d.company.status === 'RUNNING'
        ? 'The CEO opens the next objective on its cycle. You can also assign one directly.'
        : 'Start the company and the CEO decides what to work on first.',
      emptyAction: button('Assign objective', 'new-task', 'plus', false),
    });

  const followUps=(d.followUps||[]);
  const followUpCard=followUps.length?card('Scheduled follow-ups',`<div class="card-body">${followUps.map(f=>`<div class="document-row"><span><strong>${esc(f.payload.title)}</strong><small>${esc(employeeName(f.payload.employeeId))} &middot; ${esc((d.tasks.find(t=>t.id===f.payload.dependencyId)?.status||'Waiting for task').replaceAll('_',' ').toLowerCase())}</small></span><div class="form-actions"><button class="small" data-task="${esc(f.payload.dependencyId)}">Prerequisite</button><button class="small quiet" data-cancel-followup="${esc(f.id)}">Cancel follow-up</button></div></div>`).join('')}</div>`,{subtitle:'Queues the next step when prerequisite work ends and the responsible employee is available.'}):'';
  return pageTitle('Work', 'Every objective the company has run, and every model call it cost.', button('Assign objective', 'new-task', 'plus', false))+backlogPanel()+followUpCard
    + (uncertain.length ? `<div class="notice amber">${uncertain.length} unconfirmed model call(s). Agent investigations are queued automatically and run when the company is running. ${paidUncertain.length?'Paid charges remain reserved until supported by evidence.':'These local calls have no reserved token charge; their output or usage is unconfirmed.'} ${uncertain.map(c=>investigation(c.id)?`<button class="text-link" data-task="${investigation(c.id).task_id}">View investigation</button>`:'').join(' ')}</div>` : '')
    + card('Open objectives', openBody, {
      subtitle: 'Delegated hierarchy and branches. Agents plan, work and check their own results.',
      aside: `${open.length ? viewToggle : ''} <span class="badge">${open.length}</span>`,
    })
    + card('Finished', viewMode === 'tree' && done.length ? taskTree(done) : taskTable(done, { emptyTitle: 'No completed work yet', emptyBody: 'Completed and failed objectives stay here permanently.' }), { aside: `<span class="badge">${done.length}</span>` })
    + card('Model calls', d.calls.length
      ? table([{ label: 'Model' }, { label: 'State' }, { label: 'Tokens', numeric: true }, { label: 'Cost', numeric: true }, { label: 'When', numeric: true }, { label: '' }], callRows)
      : empty('No model calls yet', 'Every call is reserved against a budget before it is sent and settled after it returns.', '', 'models'),
      { subtitle: 'Reserved before dispatch, settled after return' });
}

document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-cancel-followup]');if(!button)return;
 button.disabled=true;
 try{await api('/follow-ups/'+encodeURIComponent(button.dataset.cancelFollowup)+'/cancel','POST',{reason:'Cancelled by owner from Work.'});toast('Follow-up cancelled.');await ctx.refresh(true);}catch(error){toast(error.message);button.disabled=false;}
});
