import { state } from '../lib/state.js';
import { esc, money, micro, badge, ago } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { pageTitle, card, empty, table } from '../lib/ui.js';

/** Who is currently assigned to each model, so a paid model in use is obvious. */
function assignedTo(modelId) {
  const people = (state.data.employees || []).filter((e) => e.model_id === modelId && e.status === 'ACTIVE');
  const roles = [];
  if (state.data.company.ceo_model_id === modelId) roles.push('CEO cycles');
  return { people, roles };
}

function modelCard(m) {
  const { people, roles } = assignedTo(m.id);
  const stats = (state.data.modelStats || []).find(s => s.model_id === m.id);
  const total = stats?.total || 0;
  const settled = Number(stats?.settled || 0);
  const unsettled = Number(stats?.unsettled || 0);
  const test = (state.data.tasks || []).find(t => t.role === 'Provider connection test' && t.model_id === m.id);
  const testCall = test && (state.data.calls || []).find(c => c.task_id === test.id);
  const approval = test && (state.data.actions || []).find(a => a.task_id === test.id && a.status === 'PENDING');
  const status = m.ready ? 'Ready' : m.live && m.model && m.credentialsConfigured ? 'Pricing pending' : 'Setup required';
  return `<section class="card model-card ${m.ready ? '' : 'not-ready'}">
    <div class="model-head">
      <div class="model-logo ${m.live ? 'paid' : 'free'}">${esc(m.name[0])}</div>
      <div><h3>${esc(m.name)}</h3><span class="row-detail" title="${esc(m.model || '')} ${esc(m.baseUrl || '')}">${esc(m.model || 'Model not selected')}</span></div>
      ${badge(m.ready ? 'READY' : 'PENDING', status)}
    </div>
    <div class="model-prices">${m.live
      ? `<div><span>Input / 1M tokens</span><strong>${Number(m.inputPerMillionUsd) > 0 ? money(m.inputPerMillionUsd) : 'Not set'}</strong></div><div><span>Output / 1M tokens</span><strong>${Number(m.outputPerMillionUsd) > 0 ? money(m.outputPerMillionUsd) : 'Not set'}</strong></div>`
      : `<div><span>Inference cost</span><strong>No charge</strong></div><div><span>Connection</span><strong>${m.provider === 'mock' ? 'Test fixture' : m.baseUrl ? 'Local network' : 'Local'}</strong></div>`}
    </div>
    <div class="model-usage"><span>${total} calls</span><span>${micro(settled)} settled</span>${unsettled ? `<span class="warn">${unsettled} unsettled</span>` : ''}</div>
    <div class="model-assigned">${roles.map(role=>`<span class="chip static">${esc(role)}</span>`).join('')}${people.map(p=>`<button class="chip" data-employee="${p.id}">${esc(p.name)}</button>`).join('')}${!roles.length&&!people.length?'<span class="muted">No assignments</span>':''}</div>
    <div class="model-connection">${m.live ? `<span>${m.credentialsConfigured ? 'API key configured' : 'API key missing'}</span>` : `<span title="${esc(m.baseUrl || '')}">${esc(m.baseUrl || (m.provider === 'mock' ? 'Isolated test adapter' : 'Local inference server'))}</span>`}${m.pricingSource ? `<a href="${esc(m.pricingSource)}" target="_blank" rel="noopener" title="Published rates checked ${esc(m.pricingCheckedAt)}">Pricing source</a>` : ''}</div>
    <div class="model-card-controls">
      ${m.live ? `<div class="model-cap-control"><label for="model-cap-${esc(m.id)}">Spending caps <span>${m.spendingCapsEnabled === false ? 'Off' : 'On'}</span></label><label class="toggle" title="Apply company daily and lifetime caps to this model. Spending approvals are separate."><input id="model-cap-${esc(m.id)}" type="checkbox" data-model-caps="${esc(m.id)}" aria-label="Spending caps for ${esc(m.name)}"${m.spendingCapsEnabled !== false ? ' checked' : ''}><span></span></label></div>` : ''}
      <div class="model-card-actions">${m.live || m.provider==='lmstudio' ? `<button class="button" data-configure-model="${esc(m.id)}">${icon('settings')}Configure</button>` : ''}<button class="button" data-test-provider="${esc(m.id)}"${m.ready ? '' : ' disabled'}>${icon('play')}Test provider</button></div>
      ${test ? `<div class="model-test-result"><span>${test.status === 'COMPLETED' ? `Connection verified${testCall?.latency_ms ? ` ? ${(Number(testCall.latency_ms)/1000).toFixed(2)}s` : ''}` : esc(test.error || test.status.replaceAll('_',' ').toLowerCase())}</span><div><button class="text-link" data-task="${test.id}">Test details</button>${approval ? ` <button class="button small" data-proposal="${approval.id}">Review charge</button>` : ''}</div></div>` : ''}
    </div>
  </section>`;
}

function modelTelemetry(models, aggregates) {
  return models.map((m) => {
    const aggregate = aggregates.find(s => s.model_id === m.id) || {};
    const total = Number(aggregate.total || 0);
    const succeeded = Number(aggregate.succeeded || 0);
    const failed = Number(aggregate.failed || 0);
    const passRate = total > 0 ? Math.round((succeeded / total) * 100) : null;
    const tokensIn = Number(aggregate.input_tokens || 0);
    const tokensOut = Number(aggregate.output_tokens || 0);
    const avgLatencyMs = aggregate.latency_ms == null ? null : Number(aggregate.latency_ms);
    const avgLatencySec = avgLatencyMs !== null ? (avgLatencyMs / 1000).toFixed(1) + 's' : '—';
    const settled = Number(aggregate.settled || 0);

    return {
      model: m,
      total,
      succeeded,
      failed,
      passRate,
      tokensIn,
      tokensOut,
      avgLatencySec,
      settled,
      unsettled: Number(aggregate.unsettled || 0),
    };
  });
}

function telemetryTable(stats) {
  const activeStats = stats.filter((s) => s.total > 0 || s.model.ready);
  if (!activeStats.length) {
    return empty('No telemetry yet', 'Dispatch calls through local or LAN workers to see latency and reliability metrics.', '', 'terminal');
  }

  return table(
    [
      { label: 'Model' },
      { label: 'Type' },
      { label: 'Total calls', numeric: true },
      { label: 'Call success', numeric: true },
      { label: 'Avg latency', numeric: true },
      { label: 'Tokens (In / Out)', numeric: true },
      { label: 'Total spend', numeric: true },
    ],
    activeStats.map((s) => {
      const rateBadge = s.passRate !== null
        ? `<span class="badge ${s.passRate >= 95 ? 'green' : s.passRate >= 80 ? 'amber' : 'red'}">${s.passRate}%</span>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td class="wrap">
          <strong>${esc(s.model.name)}</strong>
          <div class="row-detail">${esc(s.model.model || 'auto')} ${s.model.baseUrl ? `· ${esc(s.model.baseUrl)}` : ''}</div>
        </td>
        <td><span class="chip static">${s.model.live ? 'Paid' : s.model.provider === 'mock' ? 'Mock' : s.model.baseUrl ? 'LAN' : 'Local'}</span></td>
        <td class="numeric"><strong>${s.total}</strong></td>
        <td class="numeric">${rateBadge}</td>
        <td class="numeric">${s.avgLatencySec}</td>
        <td class="numeric">${s.tokensIn.toLocaleString()} / ${s.tokensOut.toLocaleString()}</td>
        <td class="numeric">${micro(s.settled, 4)}${s.unsettled ? `<div class="row-detail">${s.unsettled} unsettled</div>` : ''}</td>
      </tr>`;
    }),
  );
}

function recentCalls(calls, models) {
  const modelMap = new Map((models || []).map((m) => [m.id, m]));
  const recent = [...(calls || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 10);
  if (!recent.length) {
    return empty('No dispatches yet', 'Recent inferences executed by workers and CEO cycles will show duration and token usage here.', '', 'terminal');
  }

  return table(
    [
      { label: 'Time' },
      { label: 'Model' },
      { label: 'Status' },
      { label: 'Duration', numeric: true },
      { label: 'Tokens (In / Out)', numeric: true },
      { label: 'Cost', numeric: true },
    ],
    recent.map((c) => {
      const m = modelMap.get(c.model_id);
      const name = m ? m.name : c.model_id;
      const durationMs = c.latency_ms == null ? null : Number(c.latency_ms);
      const durationSec = durationMs !== null ? (durationMs / 1000).toFixed(1) + 's' : '—';
      const cost = Number(c.settled ?? 0);
      return `<tr>
        <td>${ago(c.created_at)}</td>
        <td class="wrap"><strong>${esc(name)}</strong><div class="row-detail">${esc(c.model_id)}${m?.baseUrl ? ` · ${esc(m.baseUrl)}` : ''}</div></td>
        <td>${badge(c.status)}</td>
        <td class="numeric">${durationSec}</td>
        <td class="numeric">${Number(c.input_tokens || 0).toLocaleString()} / ${Number(c.output_tokens || 0).toLocaleString()}</td>
        <td class="numeric">${c.settled == null ? '<span class="warn">Unsettled</span>' : micro(cost, 4)}</td>
      </tr>`;
    }),
  );
}

export function models() {
  const all = state.data.models || [];
  const calls = state.data.calls || [];
  const free = all.filter((m) => !m.live);
  const paid = all.filter((m) => m.live);
  const ready = all.filter((m) => m.ready && m.provider !== 'mock');
  const stats = modelTelemetry(all, state.data.modelStats || []);

  return pageTitle('Models', 'Configured models, availability and inference metrics.','<button class="primary" data-action="add-model">Add model</button>')
    + (ready.length
      ? ''
      : '<div class="notice amber"><strong>No worker model is ready.</strong><p>For a local worker, load a model in LM Studio, start its API server at http://localhost:1234/v1, then use Refresh availability below. For a paid provider, add its API key to your private .env and restart Busywork, then use Configure model to select a model ID. Pricing can be filled later but must be established before paid inference. Test fixtures cannot run your business.</p></div>')
    + card('Free and local models', `<div class="grid-3">${free.map(modelCard).join('')}</div>`, {
      subtitle: 'Local and LAN models. These run without a bill, so agents can work continuously.',
    })
    + card('Paid models', `<div class="grid-3">${paid.map(modelCard).join('')}</div>`, {
      subtitle: 'Every call costs money and is reserved against the daily cap before it is sent. Keys stay on the server and never appear here.',
    })
    + card('Model telemetry and operations', telemetryTable(stats), {
      subtitle: 'Reliability, latency, token throughput, and settled spend across all configured models.',
    })
    + card('Work outcomes', table([
      {label:'Worker model'}, {label:'Completed',numeric:true}, {label:'Failed / expired',numeric:true}, {label:'Checks passed',numeric:true},
    ], (state.data.modelOutcomes || []).map(o => `<tr>
      <td>${esc(all.find(m => m.id === o.model_id)?.name || o.model_id)}</td>
      <td class="numeric">${o.completed_tasks}</td><td class="numeric">${o.failed_tasks} / ${o.expired_tasks}</td>
      <td class="numeric">${o.review_passed_tasks} / ${o.reviewed_tasks}</td></tr>`)) || empty('No work outcomes yet', 'Completed and failed objectives will appear here.', '', 'work'), {
        subtitle: 'Latest terminal task outcomes by primary worker. Checks passed includes self-checks and historical reviews; it is not independent quality validation. Different jobs are not a controlled benchmark. Mock outcomes are fixtures, not commercial evidence.',
      })
    + card('Recent dispatches', recentCalls(calls, all), {
      subtitle: 'The last 10 model inferences executed across the company.',
    })
    + card('Model configuration', `<div class="card-body">
      <p class="section-note">Use Configure model on a paid provider card to save its exact model ID. Pricing is optional at setup and must be established before a paid call. API keys remain in <code>.env</code>; restart the API after changing a key. Additional local workers use <code>config/models.json</code>.</p>
    </div>`);
}
