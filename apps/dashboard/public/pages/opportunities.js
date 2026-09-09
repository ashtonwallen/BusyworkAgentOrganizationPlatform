import { opportunityTitle, namedText } from '../lib/record-display.js';
import { state } from '../lib/state.js';
import { esc, money, micro, date, until, badge, truncate } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { pageTitle, card, empty, button } from '../lib/ui.js';

const STAGES = [
  ['DRAFT', 'Drafted', 'Written up, not yet being tested'],
  ['VALIDATING', 'Validating', 'Finding out whether anyone pays'],
  ['DELIVERING', 'Delivering', 'Someone paid; the work is being done'],
  ['REPEATING', 'Repeating', 'It works more than once'],
];

function opportunityCard(e) {
  const economics=state.data.experimentEconomics?.experiments.find(x=>x.experimentId===e.id);
  const revenue = economics?Number(economics.revenueMicroUsd): (state.data.experimentTotals || [])
    .filter((l) => l.experiment_id === e.id && l.kind === 'REVENUE')
    .reduce((s, l) => s + Number(l.amount), 0);
  const refunds = economics?Number(economics.refundsMicroUsd): (state.data.experimentTotals || [])
    .filter((l) => l.experiment_id === e.id && l.kind === 'REFUND')
    .reduce((s, l) => s + Number(l.amount), 0);
  const directSpend = (state.data.experimentTotals || [])
    .filter((l) => l.experiment_id === e.id && l.kind === 'COST')
    .reduce((s, l) => s + Number(l.amount), 0);
  const spend=economics?BigInt(economics.modelCostsMicroUsd)+BigInt(economics.otherCostsMicroUsd):directSpend;
  const overdue = new Date(e.deadline) < new Date() && !['KILLED', 'ARCHIVED'].includes(e.status);
  return `<button class="opportunity" data-experiment="${e.id}">
    <h3>${esc(opportunityTitle(e))}</h3>
    <p>${truncate(namedText(e.hypothesis), 160)}</p>
    <div class="opportunity-who">${icon('person')}${truncate(e.customer, 70)}</div>
    <div class="opportunity-meta">
      <span title="Price">${esc(e.price)}</span>
      <span class="${overdue ? 'overdue' : ''}" title="Decision deadline">${overdue ? 'Decision overdue' : `Decide in ${until(e.deadline)}`}</span>
    </div>
    <div class="opportunity-money">
      <span class="${revenue > 0 ? 'earned' : 'muted'}">${revenue > 0 ? `${micro(revenue)} in` : 'No revenue yet'}</span>
      <span class="muted">${micro(spend)} settled costs</span><span class="muted">${Number(e.max_loss)>0?micro(e.max_loss)+' maximum test loss':'Maximum test loss: $0.00'}</span>
      ${economics?`<span class="muted">${micro(economics.netMicroUsd)} net including model costs</span>`:''}
      ${refunds > 0 ? `<span class="refunded">${micro(refunds)} refunded</span>` : ''}
    </div>
  </button>`;
}

export function opportunities() {
  const all = state.data.experiments;
  const stopped = all.filter((e) => ['KILLED', 'ARCHIVED'].includes(e.status));

  if (!all.length) {
    return pageTitle('Opportunities', 'What the company is trying to sell, and to whom.', button('Add opportunity', 'new-experiment', 'plus', false))
      + card('', empty(
        'The CEO has not opened one yet',
        state.data.company.status === 'RUNNING'
          ? 'Opportunities come out of the research the agents do. One appears here when the CEO decides a buyer and offer are worth testing.'
          : 'Start the company and the CEO will find and open its own opportunities. You can also add one to steer the first move.',
        button('Add opportunity', 'new-experiment', 'plus', false),
        'idea',
      ));
  }

  return pageTitle('Opportunities', 'What the company is trying to sell, and to whom. The CEO opens these; you can too.', button('Add opportunity', 'new-experiment', 'plus', false))
    + `<p class="section-note">${micro(state.data.experimentEconomics?.unattributedModelCostsMicroUsd||0)} model costs remain unattributed. Link relevant objectives to an opportunity to include their costs.</p><div class="pipeline">${STAGES.map(([key, label, hint]) => {
      const column = all.filter((e) => e.status === key);
      return `<div class="pipeline-column">
        <div class="pipeline-head"><h2>${esc(label)}</h2><span class="badge">${column.length}</span></div>
        <p class="pipeline-hint">${esc(hint)}</p>
        <div class="pipeline-cards">${column.length ? column.map(opportunityCard).join('') : '<div class="pipeline-empty">Nothing here</div>'}</div>
      </div>`;
    }).join('')}</div>`
    + (stopped.length ? card('Stopped', `<div class="stopped-grid">${stopped.map((e) => `<button class="stopped" data-experiment="${e.id}">
        ${badge(e.status)}<strong>${esc(opportunityTitle(e))}</strong>
        <p>${truncate(e.kill_criteria, 130)}</p>
      </button>`).join('')}</div>`, {
      subtitle: 'Killed and archived. Kept because knowing what failed is worth as much as knowing what worked.',
    }) : '');
}
