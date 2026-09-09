import { state } from '../lib/state.js';
import { esc, money, micro, date, dateTime, ago, badge, titleCase, usdInput } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { pageTitle, card, empty, table, button, helpTip } from '../lib/ui.js';
import { THEMES, currentTheme, currentMode } from '../lib/theme.js';

const GATES = [
  ['expenses', 'Other spending', 'Purchases and charges require approval. Paid model calls use their separate setting.'],
  ['modelCalls', 'Paid model calls', 'Require approval before each paid model call. When off, calls run automatically within enabled spending caps and per-call model limits.'],
  ['communications', 'Messages to outsiders', 'Anything sent to a customer, vendor or anyone outside the company.'],
  ['publishing', 'Publishing', 'Content going public, and changes to outside systems.'],
  ['accounts', 'Accounts & commitments', 'Signing up, agreeing to terms, committing the business.'],
  ['research', 'Reading public pages', 'Agents fetching a public web page. Costs nothing, but reaches outside.'],
  ['otherExternal', 'Anything else outside', 'Unfamiliar workflows arrive as a written proposal.'],
];

function grants() {
  const rows = state.data.grants || [];
  if (!rows.length) {
    return empty('No standing grants', 'Without a grant, every action needs its own approval. Add one only when you want to stop being asked about a specific repeated decision.', button('Add grant', 'new-grant', 'plus', false), 'shield');
  }
  return table(
    [{ label: 'Action / target' }, { label: 'Per action', numeric: true }, { label: 'Total', numeric: true }, { label: 'Expires' }, { label: '' }],
    rows.map((g) => `<tr>
      <td class="wrap">${esc(titleCase(g.action_type))}<div class="row-detail">${esc(g.target)}</div></td>
      <td class="numeric">${micro(g.max_transaction)}</td>
      <td class="numeric">${micro(g.total_cap)}</td>
      <td>${date(g.expires_at)}</td>
      <td>${g.revoked ? badge('REVOKED') : `<button class="small danger" data-revoke="${g.id}">Revoke</button>`}</td>
    </tr>`),
  );
}

function notifications() {
  const d=state.data, rows=d.notifications||[];
  if(!rows.length)return empty('No notifications','Proposal alerts appear here when there is a proposal to notify you about.','','bell');
  const obsolete=n=>n.status==='PENDING'&&(n.action_status!=='PENDING'||new Date(n.action_expires_at)<=new Date(d.timestamp));
  const active=rows.filter(n=>!obsolete(n)&&['PENDING','DISPATCHED','UNCERTAIN'].includes(n.status));
  const history=rows.filter(n=>!active.includes(n));
  const render=n=>{
    let label=n.status, reason=n.error||'';
    if(obsolete(n)){label='Not needed';reason='The proposal was resolved or expired before this alert was sent.';}
    else if(n.status==='PENDING'){
      if(!d.company.approval_policy.smsEnabled){label='Disabled';reason='Text alerts are off. Review the proposal in Approvals.';}
      else if(!d.smsSetup?.configured){label='Setup required';reason='SMS configuration is incomplete. Review the proposal in Approvals.';}
      else if(d.company.status==='KILLED'){label='Stopped';reason='The company is stopped.';}
      else{label='Queued';reason='Awaiting notification dispatch within the SMS and daily operating caps.';}
    }else if(n.status==='SENT'){label='Submitted';reason=reason||'Accepted by the SMS provider; this is not confirmation of handset delivery.';}
    const cost=n.settled!=null?micro(n.settled)+' charged':Number(n.reserved)>0?micro(n.reserved)+' reserved; charge unconfirmed':n.status==='PENDING'?'Not sent; no charge reserved':'Charge unconfirmed';
    return `<div class="notification-row"><div><strong>${esc(titleCase(n.action_type||'Proposal'))}</strong>
      ${n.target?`<p class="notification-target">${esc(n.target)}</p>`:''}
      <p>${esc(reason)}</p><span class="row-detail">${esc(dateTime(n.created_at))} &middot; ${esc(cost)}</span></div>
      <div class="notification-actions">${badge(n.status,label)}<button class="small quiet" data-proposal="${esc(n.action_id)}">View proposal</button>
      ${['UNCERTAIN','SENT'].includes(n.status)&&n.settled==null?`<button class="small quiet" data-sms-reconcile="${esc(n.id)}">Record charge</button>`:''}</div></div>`;
  };
  return `<div class="card-body">${active.length?active.map(render).join(''):'<p>No current proposal alerts.</p>'}
    ${history.length?`<details><summary>Notification history (${history.length})</summary>${history.map(render).join('')}</details>`:''}
    ${rows.length===100?'<p class="section-note">Showing the latest 100 notifications.</p>':''}</div>`;
}

const RECORD_TONE = { ASSET: 'green', ACCOUNT: 'blue', CONSTRAINT: 'amber', NOTE: '' };

/** Owner-entered context. Agents read it; only the owner writes it. */
function recordBody(record) {
  const body=String(record.body||'');
  if(record.id==='owner-profile'){
    const fields=[...body.matchAll(/(?:^|\n\n)(name|role|background|availability|preferences|constraints): /g)];
    if(fields.length&&fields[0].index===0)return '<dl class="owner-record-fields">'+fields.map((field,index)=>{
      const start=field.index+field[0].length,end=fields[index+1]?.index??body.length;
      return `<div><dt>${esc(titleCase(field[1]))}</dt><dd>${esc(body.slice(start,end).trim())}</dd></div>`;
    }).join('')+'</dl>';
  }
  return `<p>${esc(body)}</p>`;
}
function records() {
  const rows = state.data.records || [];
  if (!rows.length) {
    return empty('No company records',
      'Add a domain, an account, or a limit they must work within, and every agent will read it before planning.',
      button('Add record', 'new-record', 'plus', false), 'shield');
  }
  return `<div class="card-body records">${rows.map((r) => `<div class="record">
    <div class="record-head">
      <span class="badge ${RECORD_TONE[r.kind] || ''}">${esc(titleCase(r.kind))}</span>
      <strong>${esc(r.title)}</strong>
      <span class="record-actions">
        <button class="text-link" data-edit-record="${r.id}">Edit</button>
        <button class="text-link danger-link" data-archive-record="${r.id}">Remove</button>
      </span>
    </div>
    ${recordBody(r)}
  </div>`).join('')}</div>`;
}

export function controls() {
  const d = state.data;
  const p = d.company.approval_policy || {};
  const gatesOff = GATES.filter(([key]) => p[key] === false);
  const theme = currentTheme();

  return pageTitle('Controls', 'Approval policy, budgets, runtime limits and appearance.')
    + card('Company records', records(), {
      subtitle: 'Assets, accounts and constraints every agent reads before it plans',
      aside: button('Add record', 'new-record', 'plus', false),
    })
    + `<div class="grid-2">
      <div>
        ${card('Approval requirements', `<div class="card-body">
          <form id="policy-form">
            ${GATES.map(([key, label, desc]) => `<div class="setting-row">
              <div><h3>${esc(label)} ${helpTip(desc, label)}</h3></div>
              <label class="toggle"><input type="checkbox" name="${key}" ${p[key] !== false ? 'checked' : ''} aria-label="${esc(label)} requires approval"><span></span></label>
            </div>`).join('')}
            ${gatesOff.length ? `<div class="notice amber">${gatesOff.length} ${gatesOff.length === 1 ? 'gate is' : 'gates are'} off. That alone grants nothing: an agent still needs a matching grant, an installed integration and available budget to act without asking.</div>` : ''}
            <div class="form-actions"><button class="primary" type="submit">Save</button></div>
          </form>
        </div>`, { subtitle: 'On means the agent must ask you before it acts', aside: icon('shield') })}

        ${card('Standing grants', grants(), {
          subtitle: 'A narrow, expiring, capped exception to the gates above',
          aside: button('Add grant', 'new-grant', 'plus', false),
        })}
      </div>
      <div>
        ${card('Budget limits', `<div class="card-body">
          <form id="budget-form">
            <div class="field"><label for="capital">Capital allocation (USD)</label>
              <input id="capital" name="capitalAllocationUsd" value="${esc(usdInput(d.company.capitalAllocationUsd))}" required inputmode="decimal">
              ${helpTip('A plan, not a balance. Record money that actually arrives under Money.', 'Capital allocation')}</div>
            <div class="form-grid">
              <div class="field"><label for="daily-cap">Daily operating cap (USD)</label>
                <input id="daily-cap" name="dailyCapUsd" value="${esc(usdInput(d.company.dailyCapUsd))}" required inputmode="decimal">
                ${helpTip('Applies to paid model and notification costs. Unsettled charges retain their budget hold.', 'Daily operating cap')}</div>
              <div class="field"><label for="live-cap">Lifetime paid cap (USD)</label>
                <input id="live-cap" name="liveCapUsd" value="${esc(usdInput(d.company.liveCapUsd))}" required inputmode="decimal">
                <small>Separate from the daily cap. Zero blocks all paid model calls. Saving rechecks blocked objectives.</small>${helpTip('Total across all paid calls ever, including unsettled ones.', 'Lifetime paid cap')}</div>
            </div>
            <div class="form-actions"><button class="primary" type="submit">Save</button></div>
          </form>
        </div>`)}

        ${card('Appearance', `<div class="card-body">
          <div class="appearance-mode"><span>Mode</span><div class="segmented" role="group" aria-label="Appearance mode">${['light', 'dark'].map(mode => `<button type="button" data-mode-choice="${mode}" class="${currentMode() === mode ? 'active' : ''}" aria-pressed="${currentMode() === mode}">${mode === 'light' ? 'Light' : 'Dark'}</button>`).join('')}</div></div>
          <div class="theme-grid" role="group" aria-label="Color theme">${THEMES.map((t) => `<button class="theme-swatch ${theme === t.id ? 'selected' : ''}" data-theme-choice="${t.id}" aria-pressed="${theme === t.id}">
            <span class="theme-preview" data-preview="${t.id}"><i></i><i></i><i></i></span>
            <span>${esc(t.label)}</span>
          </button>`).join('')}</div>
          ${helpTip('Theme and mode are saved in this browser.')}
        </div>`)}

        ${card('Company runtime', `<div class="card-body">
          <button class="btn-icon" data-action="mandate">${icon('compass')}Mandate, CEO model & delegation limits</button>
          ${helpTip("The mandate is the boundary you set. Inside it, the CEO chooses the strategy — see the direction on your overview.")}
          <div class="danger-zone">
            ${d.company.status === 'RUNNING' ? button('Pause', 'pause', 'pause', false) : button('Start company', 'start', 'play', true)}
            <button class="danger btn-icon" data-action="kill">Stop everything</button>
          </div>
          ${helpTip("Stopping blocks new work. Calls already sent can still finish and still cost money; those results are recorded either way.")}
        </div>`, { aside: badge(d.company.status) })}

        ${card('Text alerts', `<div class="card-body">
          <div class="setting-row">
            <div><h3>Proposal notifications ${helpTip(d.smsSetup?.replyEnabled ? 'Reply APPROVE or DENY with the proposal code.' : 'Text notifications only. Approve or deny proposals in the dashboard.')}</h3></div>
            <label class="toggle"><input type="checkbox" id="sms-enabled" ${p.smsEnabled ? 'checked' : ''} aria-label="Send proposal text alerts"><span></span></label>
          </div>
          <p class="section-note">${esc(d.smsStatus || '')} ${d.smsLimits?.maxCostUsd ? `Capped at ${money(d.smsLimits.maxCostUsd)} per message and ${money(d.smsLimits.dailyCapUsd)} per day.` : ''}</p>
          ${d.smsSetup?.missingFields?.length ? '<div class="notice"><strong>Setup required</strong><ul>'+d.smsSetup.missingFields.map(key=>'<li><code>'+esc(key)+'</code></li>').join('')+'</ul></div>' : ''}${d.smsSetup?.invalidConfiguration ? '<div class="notice">Check the SMS account, phone numbers, callback URL and limits.</div>' : ''}
          ${notifications()}
        </div>`, { aside: badge(p.smsEnabled ? 'ACTIVE' : 'PAUSED', p.smsEnabled ? 'On' : 'Off') })}
      </div>
    </div>
    <section class="reset-danger-zone" aria-labelledby="reset-danger-title"><h2 id="reset-danger-title">Danger zone</h2>
      <p>Start a fresh business. Current records are archived locally; real charges and outside actions are not reversed.</p>
      <button class="destructive-button" data-action="reset-business">Reset business</button>
    </section>`;
}
