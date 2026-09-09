export const state = {
  page: location.hash.slice(1) || 'overview',
  data: null,
  connected: true,
  period: 30,
  logFilter: 'all',
  pipelineView: 'stages',
};

export const root = document.querySelector('#app');
export const modal = document.querySelector('#modal');

/** Pending owner decisions: exact action proposals plus open help requests. */
export function pendingCount() {
  if (!state.data) return 0;
  return state.data.actions.filter((a) => a.status === 'PENDING').length
    + state.data.requests.filter((r) => r.status === 'OPEN').length;
}

export function employeeName(id) {
  if (!id || id === 'owner') return 'You';
  if (id === 'company') return 'Company-wide';
  if (id === 'tool-gateway') return 'Tool gateway';
  if (id === 'system') return 'System';
  const person = (state.data?.employees || []).find((e) => e.id === id);
  if (person) return person.name;
  const department = (state.data?.departments || []).find((d) => d.id === id);
  return department ? department.name : id.slice(0, 8);
}

export function employee(id) {
  return (state.data?.employees || []).find((e) => e.id === id);
}

export function task(id) {
  return (state.data?.tasks || []).find((t) => t.id === id);
}

export const ACTIVE_TASK = (t) => !['COMPLETED', 'CANCELLED', 'FAILED', 'EXPIRED'].includes(t.status);
