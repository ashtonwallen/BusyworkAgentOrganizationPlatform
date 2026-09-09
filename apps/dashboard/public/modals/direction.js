import { state } from '../lib/state.js';
import { api } from '../lib/api.js';
import { esc, ago, dateTime } from '../lib/format.js';
import { openModal, form, field, handleModal } from '../lib/modal.js';
import { ctx } from '../lib/context.js';

export function setDirection() {
  const current = state.data.direction;
  openModal(current ? 'Override the direction' : 'Set the operating direction',
    `<p class="modal-lede">${current
      ? 'This replaces what the CEO chose. The previous direction is kept in the history, and the CEO can still replace yours later if its evidence says otherwise.'
      : 'Normally the CEO writes this on its own cycle. Set it yourself only when you want to steer the opening move.'}</p>`
    + form(
      field('Headline', 'headline', current?.headline || '', 'text', 'A few words. What the company is pursuing.')
      + field('What and why', 'statement', current?.statement || '', 'textarea', 'The market, the offer, the channel, and the reason this is the right bet now.'),
      current ? 'Replace direction' : 'Set direction',
    )
    + (current ? '<div class="form-actions secondary"><button class="danger small" data-action="clear-direction">Clear it and let the CEO decide</button></div>' : ''));
  handleModal((x) => api('/company/direction', 'PUT', x), 'Direction updated.');
}

export async function clearDirection() {
  await api('/company/direction', 'DELETE');
  await ctx.refresh(true);
}

export function directionHistory() {
  const rows = state.data.directions || [];
  openModal('How the direction has changed', rows.length
    ? `<p class="modal-lede">Newest first. Each entry replaced the one below it.</p>
       <div class="history">${rows.map((d, i) => `<div class="history-entry ${i === 0 && !d.superseded_at ? 'current' : ''}">
        <div class="history-mark"></div>
        <div>
          <div class="history-head"><strong>${esc(d.headline)}</strong>${i === 0 && !d.superseded_at ? '<span class="badge green">Current</span>' : ''}</div>
          <p>${esc(d.statement)}</p>
          <span class="row-detail">${d.set_by_role === 'Owner' ? 'You' : esc(d.set_by_name || 'CEO')} · ${dateTime(d.created_at)}${d.superseded_at ? ` · replaced ${ago(d.superseded_at)}` : ''}</span>
        </div>
      </div>`).join('')}</div>`
    : '<p>No direction has been recorded yet.</p>', { wide: true });
}
