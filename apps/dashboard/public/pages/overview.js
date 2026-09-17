import {needsMission,missionPicker,missionCard} from './missions.js';
import {failureDismissed} from '../lib/alerts.js';
import { state, pendingCount, ACTIVE_TASK, employeeName } from '../lib/state.js';
import { esc, money, micro, date, ago, badge, truncate } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { pageTitle, metric, card, empty, link, button } from '../lib/ui.js';
import { directionCard, mandateStrip } from '../panels/direction.js';
import { taskTable, proposalList, moneyChart, activityFeed, capitalPanel, attentionStrip, pendingBadge } from '../panels/common.js';

function decisionMessage(message,data) {
  const who=message.sender_name||employeeName(data.tasks.find(t=>t.id===message.task_id)?.employee_id||message.sender_id);
  try {
    const payload=JSON.parse(message.body);
    if(payload?.type?.startsWith('WORKSPACE_')) {
      const result=payload.result, path=payload.target||result?.path||'workspace';
      const verbs={WORKSPACE_WRITE:'wrote',WORKSPACE_READ:'read',WORKSPACE_LIST:'listed'};
      return {who,title:'Workspace update',body:`${who} ${verbs[payload.type]||'updated'} ${path}${result?.bytes!=null?' ('+(result.bytes/1024).toFixed(1)+' KB)':''}.`,kind:'Work result'};
    }
    if(payload&&typeof payload==='object')return {who,title:message.subject,body:'Internal result recorded. Open the objective for details.',kind:'Work result'};
  }catch{}
  return {who,title:message.subject,body:message.body,kind:'Decision'};
}

/** The most recent thing the team decided, so a check-in starts with an answer. */
function latestDecisions() {
  const d = state.data;
  const items = [
    ...d.meetings.filter((m) => m.status === 'COMPLETED' && m.decisions).map((m) => ({
      when: m.scheduled_at, who: employeeName(m.organizer_id), title: m.title,
      body: m.decisions.summary || (Array.isArray(m.decisions.decisions) ? m.decisions.decisions.join('. ') : ''),
      ref: `data-meeting="${m.id}"`, kind: 'Meeting',
    })),
    ...d.messages.filter((m) => m.kind === 'DECISION').map((m) => ({
      when: m.created_at, ...decisionMessage(m,d),
      ref: m.task_id ? `data-task="${m.task_id}"` : '',
    })),
    ...d.experiments.filter((e) => e.status === 'KILLED').map((e) => ({
      when: e.created_at, who: 'The team', title: `Stopped: ${e.title}`, body: e.kill_criteria,
      ref: `data-experiment="${e.id}"`, kind: 'Stopped',
    })),
  ].sort((a, b) => new Date(b.when) - new Date(a.when)).slice(0, 3);
  if (!items.length) {
    return empty('No decisions recorded yet', 'Meetings and agent decisions land here so you can see what the team concluded without reading every task.', '', 'check');
  }
  return `<div class="decisions">${items.map((i) => `<button class="decision" ${i.ref}>
    <div class="decision-head"><span class="badge blue">${esc(i.kind)}</span><strong>${esc(i.title)}</strong></div>
    <p>${truncate(i.body, 190)}</p>
    <span class="row-detail">${esc(i.who)} · ${ago(i.when)}</span>
  </button>`).join('')}</div>`;
}

export function overview() {
  const d = state.data;
  if(needsMission())return missionPicker();
  const m = d.metrics;
  const active = d.tasks.filter(ACTIVE_TASK);
  const staff = (d.employees || []).filter((e) => e.status === 'ACTIVE');
  const running = d.company.status === 'RUNNING';
  const live = d.experiments.filter((e) => !['KILLED', 'ARCHIVED'].includes(e.status));

  const controls = running
    ? button('Pause agents', 'pause', 'pause', false)
    : button(d.mission?.capabilities.includes('commerce')?'Start company':'Start team', 'start', 'play', true);

  if(!d.mission?.capabilities.includes('commerce'))return pageTitle('Overview',running?'The team is running.':'The team is paused.',controls)+missionCard()+attentionStrip()+`<div class="grid-2"><div>${card('Active work',taskTable(active.slice(0,8),{emptyTitle:'No active tasks',emptyBody:'The CEO organizes work for the active mission.'}),{aside:link('All work','work')})}${card('Recent decisions',latestDecisions())}</div><div>${card('Pending decisions',proposalList(5),{footer:link('Approvals','inbox')})}${card('Recent activity',activityFeed(8),{footer:link('Activity log','log')})}</div></div>`;
  return pageTitle(
    'Overview',
    running ? `${staff.length} ${staff.length === 1 ? 'agent is' : 'agents are'} working. ` : 'The company is not running. ',
    controls,
  )
    + missionCard()
    + attentionStrip()
    + (d.ceoCycle && ['FAILED', 'EXPIRED'].includes(d.ceoCycle.status) && !d.ceoCycle.acknowledged && !failureDismissed(d.tasks.find(t=>t.id===d.ceoCycle.id))
      ? card('Previous CEO cycle failed', `<div class="card-body"><p>${esc(d.ceoCycle.error || 'The last CEO cycle did not complete.')}</p>
        ${d.ceoCycle.unresolved ? '<p>Reconcile unresolved model calls before continuing.</p>' : '<p>The next cycle is scheduled automatically. The failure remains in work history.</p><button class="quiet" data-action="dismiss-failures" title="Hide this notice in this browser without restarting work.">Dismiss notice</button>'}</div>`) : '')
    + `<div class="metrics">
      ${metric('Revenue', money(m.revenueUsd), Number(m.refundsUsd) > 0 ? `${money(m.refundsUsd)} refunded` : 'Recorded customer receipts', 'dollar')}
      ${metric('Net contribution', money(m.contributionUsd), 'After business and model costs', 'finance')}
      ${metric('Model spend today', money(m.dailyUsedUsd), `${money(m.dailyRemainingUsd)} left in today's cap`, 'models')}
      ${metric('Pending decisions', String(pendingCount()), pendingCount() ? 'Work is blocked until you decide' : 'No pending owner decisions', 'inbox')}
    </div>`
    + `<div class="grid-main">
      <div>
        ${directionCard()}
        ${card('Recent decisions', latestDecisions(), { subtitle: 'Conclusions from meetings and agents, newest first', aside: link('Team', 'team') })}
        ${card('Active work', taskTable(active.length ? active.slice(0, 6) : d.tasks.slice(0, 5), {
          emptyTitle: running ? 'No open objectives right now' : 'No work has started',
          emptyBody: running ? 'The CEO opens the next objectives on its cycle.' : 'Start the company and the CEO will open the first objective itself.',
          emptyAction: '',
        }), {
          subtitle: `${active.length} open · ${d.tasks.filter((t) => t.status === 'COMPLETED').length} completed`,
          aside: link('All work', 'work'),
        })}
        ${card('Money', `<div class="card-body"><div class="chart-legend"><span><i class="legend-dot revenue"></i>Revenue</span><span><i class="legend-dot cost"></i>Costs & refunds</span></div>${moneyChart()}</div>`, {
          subtitle: 'Recorded revenue and costs · USD',
          aside: `<div class="tabs">${[[1,'Today (UTC)'],[7,'7d'],[30,'30d'],[90,'90d']].map(([days,label])=>`<button data-period="${days}" class="${(state.period || 7) === days ? 'selected' : ''}">${label}</button>`).join('')}</div>`,
          footer: `<span>${money(m.businessCostsUsd)} business costs · ${money(m.operatingCostsUsd)} model costs</span>${link('Money', 'finance')}`,
        })}
      </div>
      <div>
        ${card('Pending decisions', proposalList(3), { aside: pendingBadge(), footer: link('Approvals', 'inbox') })}
        ${card('Opportunities', live.length ? `<div class="card-body opportunity-mini">${live.slice(0, 4).map((e) => `<button class="mini-row" data-experiment="${e.id}"><div><strong>${esc(e.title)}</strong><span class="row-detail">${truncate(e.customer, 60)}</span></div>${badge(e.status)}</button>`).join('')}</div>`
          : empty('No opportunities open', 'The CEO opens these from its own research. You can add one too.', button('Add opportunity', 'new-experiment', 'plus', false), 'idea'), {
          subtitle: live.length ? `${live.length} being worked · ${d.experiments.filter((e) => e.status === 'KILLED').length} stopped` : '',
          aside: link('All', 'experiments'),
        })}
        ${card('Cash & limits', capitalPanel(), { aside: icon('shield') })}
        ${card('Recent activity', activityFeed(7), { aside: `<span class="live-tag"><i class="live-dot ${state.connected ? '' : 'off'}"></i>Live</span>`, footer: link('Full company log', 'log') })}
      </div>
    </div>`
    + mandateStrip();
}
