import { ledgerPanel } from '../panels/ledger.js';
import { state } from '../lib/state.js';
import { esc, money, micro, date, badge, titleCase, truncate } from '../lib/format.js';
import { pageTitle, card, empty, metric, table, button, meter } from '../lib/ui.js';
import { moneyChart, capitalPanel } from '../panels/common.js';

/** Model spend grouped by the model that incurred it, so an expensive habit is visible. */
function spendByModel() {
  const totals = new Map((state.data.modelStats || []).filter(s => Number(s.total) > 0).map(s => [s.model_id, {
    settled: Number(s.settled || 0), held: Number(s.held || 0), calls: Number(s.total), live: state.data.models.find(m => m.id === s.model_id)?.live,
  }]));
  const rows = [...totals.entries()].sort((a, b) => b[1].settled - a[1].settled);
  if (!rows.length) return empty('No model spend yet', 'Every call is priced from the model registry and recorded here.', '', 'models');
  return table(
    [{ label: 'Model' }, { label: 'Calls', numeric: true }, { label: 'Settled', numeric: true }, { label: 'Held', numeric: true }],
    rows.map(([id, t]) => `<tr>
      <td>${esc(id)}<div class="row-detail">${t.live ? 'paid provider' : 'free · local or test'}</div></td>
      <td class="numeric">${t.calls}</td>
      <td class="numeric">${micro(t.settled)}</td>
      <td class="numeric">${t.held ? micro(t.held) : '—'}</td>
    </tr>`),
  );
}

function byOpportunity() {
  const rows = state.data.experiments.map((e) => {
    const entries = (state.data.experimentTotals || []).filter((l) => l.experiment_id === e.id);
    const sum = (kind) => entries.filter((l) => l.kind === kind).reduce((s, l) => s + Number(l.amount), 0);
    return { e, revenue: sum('REVENUE'), refund: sum('REFUND'), cost: sum('COST') };
  }).filter((r) => r.revenue || r.refund || r.cost);
  if (!rows.length) return '';
  return card('By opportunity', table(
    [{ label: 'Opportunity' }, { label: 'Revenue', numeric: true }, { label: 'Refunds', numeric: true }, { label: 'Costs', numeric: true }, { label: 'Net', numeric: true }],
    rows.map(({ e, revenue, refund, cost }) => `<tr>
      <td class="wrap"><button class="table-link" data-experiment="${e.id}">${esc(e.title)}</button><div class="row-detail">${badge(e.status)}</div></td>
      <td class="numeric">${micro(revenue)}</td>
      <td class="numeric">${refund ? micro(refund) : '—'}</td>
      <td class="numeric">${micro(cost)}</td>
      <td class="numeric ${revenue - refund - cost >= 0 ? 'positive' : 'negative'}">${micro(revenue - refund - cost)}</td>
    </tr>`),
  ), { subtitle: 'Only money that actually moved, attributed to the test that earned or spent it' });
}

function paymentDestinationsPanel() {
  // Destinations come from the git-ignored Payment_Info file via the API. They are
  // deliberately not hardcoded here: receiving addresses are financial identifiers and
  // this file is in version control.
  const items = state.paymentInfo?.items || [];
  if (!items.length) {
    return card('Payment destinations', empty(
      'No payment destinations configured',
      'Copy Payment_Info_Venmo_Crypto.example.txt to Payment_Info_Venmo_Crypto.txt, add your receiving addresses and handles, and restart the API. Receiving details only — never a private key or seed phrase.',
      '', 'dollar',
    ), { subtitle: 'Where customers can send money' });
  }
  return card('Payment destinations', `
    <div class="card-body">
      <p class="section-note">Receiving destinations only. Nothing in this system can move money — recording a receipt under “Record a transaction” is what makes it real.</p>
      <div class="payment-destinations-list">
        ${items.map((item) => `
          <div class="destination-row">
            <div class="destination-info">
              <div class="destination-head">
                <strong>${esc(item.label)}</strong>
                ${item.tag ? `<span class="badge green">${esc(item.tag)}</span>` : ''}
              </div>
              <code class="destination-value" title="${esc(item.value)}">${esc(item.value)}</code>
            </div>
            ${item.value && !/^coming later$/i.test(item.value)
      ? `<button class="small quiet copy-btn" data-copy="${esc(item.value)}" title="Copy to clipboard">Copy</button>`
      : '<span class="muted">not set up yet</span>'}
          </div>
        `).join('')}
      </div>
      <p class="section-note">Edit <code>Payment_Info_Venmo_Crypto.txt</code> and restart the API to change these. Stripe, Shopify and direct deposit can be added as lines in the same file.</p>
    </div>
  `, { subtitle: 'Where customers can send money', aside: '<span class="badge">Receiving only</span>' });
}

export function moneyPage() {
  const d = state.data;
  const m = d.metrics;
  const currentPeriod = state.period || 7;

  return pageTitle('Money', 'Only recorded transactions. Nothing here is projected or estimated.',
    button('Record a transaction', 'new-ledger', 'plus', false) + '<button data-action="export-ledger">Export CSV</button>')
    + `<div class="metrics">
      ${metric('Customer revenue', money(m.revenueUsd), Number(m.refundsUsd) > 0 ? `less ${money(m.refundsUsd)} refunded` : 'Receipts recorded by you', 'dollar')}
      ${metric('Business costs', money(m.businessCostsUsd), 'Recorded business expenses', 'finance')}
      ${metric('Model costs', money(m.operatingCostsUsd), 'Paid inference only; local models are free', 'models')}
      ${metric('Net including model costs', money(m.contributionUsd), Number(m.contributionUsd) >= 0 ? 'Revenue less costs and refunds' : 'Revenue less costs and refunds', 'shield')}
    </div>`
    + `<div class="grid-main">
      <div>
        ${card('Revenue and costs', `<div class="card-body"><div class="chart-legend"><span><i class="legend-dot revenue"></i>Revenue</span><span><i class="legend-dot cost"></i>Costs & refunds</span></div>${moneyChart()}</div>`, {
      aside: `<div class="tabs">
            <button data-period="1" class="${currentPeriod === 1 ? 'selected' : ''}">Today (UTC)</button>
            <button data-period="7" class="${currentPeriod === 7 ? 'selected' : ''}">7d</button>
            <button data-period="30" class="${currentPeriod === 30 ? 'selected' : ''}">30d</button>
            <button data-period="90" class="${currentPeriod === 90 ? 'selected' : ''}">90d</button>
          </div>`,
    })}
        ${byOpportunity()}
        ${ledgerPanel()}
      </div>
      <div>
        ${card('Cash & limits', capitalPanel())}
        ${card('Recorded owner time',`<div class="card-body"><strong>${Number(d.ownerEffort?.minutes||0).toLocaleString()} minutes</strong><p>${Number(d.ownerEffort?.requestsWithTime||0)} requests with time recorded</p>${(d.ownerEffort?.byOpportunity||[]).filter(g=>g.minutes>0).map(g=>`<div class="mini-row static"><span>${esc(g.experimentId?(d.experiments.find(e=>e.id===g.experimentId)?.title||'Opportunity'):'Company-wide requests')}</span><strong>${g.minutes.toLocaleString()} min</strong></div>`).join('')}<p class="section-note">Owner-request time only. Zero may mean no time was entered. No hourly rate or cash cost is inferred.</p></div>`)}
        ${paymentDestinationsPanel()}
        ${card('Model spend', spendByModel(), { subtitle: 'Where inference money goes' })}
      </div>
    </div>`;
}
