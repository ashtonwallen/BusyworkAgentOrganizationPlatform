import { taskProblem } from '../lib/task-status.js';
import { state, ACTIVE_TASK } from '../lib/state.js';
import { esc, money, badge } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { empty } from '../lib/ui.js';

/** Work and spend attributed to one employee across all their objectives. */
export function employeeLoad(id) {
  const tasks = (state.data.tasks || []).filter((t) => t.employee_id === id);
  const priority = { RUNNING: 0, BLOCKED_APPROVAL: 1, BLOCKED_BUDGET: 1, REVIEW: 2, READY: 3, PLAN_PENDING: 4 };
  const active = tasks.filter(ACTIVE_TASK).sort((a, b) => (priority[a.status] ?? 5) - (priority[b.status] ?? 5));
  const spend = tasks.reduce((sum, t) => sum + Number(t.spentUsd || 0), 0);
  return { tasks, active, spend, current: active[0] || (['FAILED', 'EXPIRED'].includes(tasks[0]?.status) ? tasks[0] : null) };
}

export function employeeActivity(person, load = employeeLoad(person.id)) {
  const task = load.current;
  if (person.status !== 'ACTIVE') return { tone: person.status, label: person.status === 'RETIRED' ? 'Retired' : 'Inactive' };
  if (task?.status === 'RUNNING') return { tone: 'RUNNING', label: task.phase === 'PLAN' ? 'Planning' : task.phase === 'REVIEW' ? 'Checking own work' : 'Working' };
  if (task?.status === 'BLOCKED_APPROVAL') return { tone: 'BLOCKED_APPROVAL', label: task.error === 'Owner approval required for this paid model call' ? 'Awaiting approval' : 'Waiting', detail: taskProblem(task) };
  if (task?.status === 'BLOCKED_BUDGET') return { tone: 'BLOCKED_BUDGET', label: 'Blocked by limit', detail: taskProblem(task) };
  if (person.role==='CEO' && state.data.company?.status==='RUNNING' && (!task || ['FAILED','EXPIRED'].includes(task.status))) {
    const cycle=state.data.ceoCycle;
    if(cycle?.unresolved)return {tone:'BLOCKED_APPROVAL',label:'Awaiting reconciliation',detail:'A previous call has unresolved usage. Scheduling resumes after reconciliation.'};
    if(cycle && ['FAILED','EXPIRED'].includes(cycle.status))return {tone:'QUEUED',label:'Recovering',detail:'A new cycle is scheduled automatically after a short recovery delay.'};
    const latest=load.tasks.find(t=>t.id===cycle?.id);
    const wait=latest?.artifact?.operations?.find(operation=>operation.type==='WAIT');
    if(wait)return {tone:'IDLE',label:'Waiting',detail:wait.instructions || 'The CEO chose to wait. New replies or completed work can wake it early.'};
    return {tone:'QUEUED',label:'Next cycle queued',detail:'The scheduler continues when the current work has settled.'};
  }
  if (task?.status === 'FAILED' || task?.status === 'EXPIRED') return { tone: task.status, label: task.status === 'EXPIRED' ? 'Assignment expired' : 'Needs attention', detail: taskProblem(task) };
  if (state.data.company?.status === 'KILLED') return { tone: 'KILLED', label: 'Stopped' };
  if (state.data.company?.status === 'PAUSED') return { tone: 'PAUSED', label: 'Paused' };
  if (!task) return { tone: 'IDLE', label: 'Idle' };
  return { tone: 'QUEUED', label: task.phase === 'REVIEW' ? 'Queued for self-check' : task.phase === 'PLAN' ? 'Queued to plan' : 'Queued to work' };
}

function node(person) {
  const load = employeeLoad(person.id);
  const model = (state.data.models || []).find((m) => m.id === person.model_id);
  const paid = model?.live;
  const activity = employeeActivity(person, load);
  return `<div class="org-node ${person.status !== 'ACTIVE' ? 'inactive' : ''}"><button class="org-person" data-employee="${person.id}">
    <div class="org-node-head">
      <span class="avatar small">${esc((person.name || '?')[0])}</span>
      <div>
        <strong>${esc(person.name)}</strong>
        <span class="org-role">${esc(person.role)}</span>
      </div>
      ${person.status === 'ACTIVE' ? '' : badge(person.status)}
    </div>
    <div class="org-node-body">
      <div class="org-activity">${badge(activity.tone, activity.label)}${load.active.length > 1 ? `<span>${load.active.length} open assignments</span>` : ''}</div>
      ${load.current
      ? `<span class="org-task" title="${esc(load.current.objective)}">${icon('work')}<span>${esc(load.current.objective)}</span></span>`
      : `<span class="org-task idle">${icon('clock')}${person.status === 'ACTIVE' ? 'No open objective' : 'Not working'}</span>`}
      ${activity.detail ? `<span class="org-blocker" title="${esc(activity.detail)}">${esc(activity.detail)}</span>` : ''}
    </div>
    <div class="org-node-foot">
      <span class="${paid ? 'paid-model' : ''}">${icon('models')}${esc(model?.name || person.model_id)}${paid ? ' · paid' : ''}</span>
      <span>${load.tasks.length} ${load.tasks.length === 1 ? 'objective' : 'objectives'} · ${money(load.spend)}</span>
    </div>
  </button>${person.status === 'ACTIVE' ? employeeModelPicker(person) : ''}</div>`;
}

export function employeeModelPicker(person) {
  return `<div class="employee-model-picker"><label for="employee-model-${esc(person.id)}" title="Applies to the next call under your approval settings.">Worker model</label><select id="employee-model-${esc(person.id)}" data-employee-model="${esc(person.id)}" aria-label="Model for ${esc(person.name)}">${(state.data.models || []).map(m => `<option value="${esc(m.id)}"${m.id === person.model_id ? ' selected' : ''}${!m.ready && !(m.live && m.model && m.credentialsConfigured) ? ' disabled' : ''}>${esc(m.name)} · ${esc(m.model || 'not configured')}${m.live ? ' · paid' : ''}${!m.ready ? ' · setup pending' : ''}</option>`).join('')}</select></div>`;
}

function branch(people, managerId) {
  const children = people.filter((p) => (p.manager_id ?? null) === managerId);
  if (!children.length) return '';
  return `<ul class="org-branch">${children.map((p) => `<li>${node(p)}${branch(people, p.id)}</li>`).join('')}</ul>`;
}

export function orgChart() {
  const people = state.data.employees || [];
  if (!people.length) {
    return ownerNode() + empty('No agents hired', 'Starting the company appoints the CEO. Subsequent hiring follows configured headcount and depth limits.', '', 'team');
  }
  const roots = people.filter((p) => !p.manager_id || !people.some((m) => m.id === p.manager_id));
  return `<div class="org-chart">
    ${ownerNode()}
    <ul class="org-branch root">${roots.map((p) => `<li>${node(p)}${branch(people, p.id)}</li>`).join('')}</ul>
  </div>`;
}

function ownerNode() {
  const profile = state.data.ownerProfile;
  return `<button class="org-owner" data-action="owner-profile" aria-label="Edit owner profile">${icon('person')}<span><strong>${esc(profile?.name || 'Owner')}</strong><span class="org-role">${esc(profile?.role || 'Owner')} · Edit profile</span></span></button>`;
}

export function departmentSummary() {
  const departments = state.data.departments || [];
  const people = state.data.employees || [];
  const staffed = departments.map((d) => ({ ...d, staff: people.filter((p) => p.department_id === d.id && p.status === 'ACTIVE') }));
  const withStaff = staffed.filter((d) => d.staff.length);
  const vacant = staffed.filter((d) => !d.staff.length);
  return `<div class="card-body">
    <div class="dept-grid">
      ${withStaff.map((d) => `<div class="dept">
        <div class="dept-head"><h3>${esc(d.name)}</h3><span class="badge">${d.staff.length}</span></div>
        <p>${esc(d.purpose)}</p>
        <div class="dept-staff">${d.staff.map((p) => `<button class="chip" data-employee="${p.id}">${esc(p.name)}</button>`).join('')}</div>
      </div>`).join('')}
    </div>
    ${vacant.length ? `<p class="section-note">Unstaffed: ${vacant.map((d) => esc(d.name)).join(', ')}. The CEO hires into a department when the work needs it.</p>` : ''}
  </div>`;
}
