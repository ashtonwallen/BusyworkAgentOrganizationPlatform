import { actionOutcome } from '../lib/record-display.js';
import { state, pendingCount, employeeName } from '../lib/state.js';
import { esc, micro, date, ago, badge, titleCase, truncate } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { pageTitle, card, empty, button } from '../lib/ui.js';
import { proposalList } from '../panels/common.js';

export function inbox() {
  const d = state.data;
  const decided = d.actions.filter((a) => a.status !== 'PENDING');
  const closedRequests = d.requests.filter((r) => r.status !== 'OPEN');
  const pending = pendingCount();

  return pageTitle(
    'Approvals',
    pending ? `${pending} ${pending === 1 ? 'thing is' : 'things are'} blocked until you decide.` : 'No pending owner decisions.',
    button('Create request', 'new-request', 'chat', false),
  )
    + `<div class="${pending ? 'grid-2' : 'approval-stack'}">
      <div>
        ${card('Decisions', proposalList(100), {
          subtitle: 'Each one is bound to an exact action and a maximum cost. Changing it needs a new proposal.',
          aside: pending ? `<span class="badge amber">${pending}</span>` : badge('DONE', 'Clear'),
        })}
      </div>
      <div>
        ${card('Decision history', decided.length
          ? `<div class="card-body decided">${decided.slice(0, 20).map((a) => `<button class="mini-row" data-proposal="${a.id}">
              <div><strong>${esc(titleCase(a.action_type))}</strong><span class="row-detail">${truncate(a.target, 52)} · ${Number(a.max_cost) > 0 ? micro(a.max_cost) : 'no cost'} · ${date(a.created_at)}</span></div>
              <span class="action-outcome">${actionOutcome(a.status)}</span>
            </button>`).join('')}</div>`
          : empty('No decisions yet', 'Approvals and rejections stay here permanently, tied to the exact proposal you saw.', '', 'shield'),
          { footer: `<button class="text-link" data-action="new-action">Propose action ${icon('plus')}</button>` })}
        ${closedRequests.length ? card('Resolved requests', `<div class="card-body decided">${closedRequests.map((r) => `<div class="mini-row static">
            <div><strong>${esc(r.title)}</strong><span class="row-detail">${r.minutes ? `${r.minutes} min of your time · ` : ''}${truncate(r.response || 'No note', 70)}</span></div>
            ${badge(r.status,r.status==='DONE'?'Completed':undefined)}
          </div>`).join('')}</div>`, { subtitle: 'Physical and setup work only you can do' }) : ''}
      </div>
    </div>`;
}
