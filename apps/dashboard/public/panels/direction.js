import { linkedText } from '../lib/record-display.js';
import { state } from '../lib/state.js';
import { esc, ago, money, truncate } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { button, helpTip } from '../lib/ui.js';

/**
 * The company's operating direction. The CEO normally writes this; the owner can
 * override it. Whoever set it, this is the answer to "what is my company doing?".
 */
export function directionCard() {
  const d = state.data.direction;
  const running = state.data.company.status === 'RUNNING';
  if (!d) {
    return `<section class="card direction-card empty-direction">
      <div class="card-header"><div><div class="eyebrow">Operating direction</div><h2>No operating direction ${helpTip('The CEO sets operating direction during its next cycle. The owner can override it.', 'Operating direction')}</h2></div>${icon('compass')}</div>
      <div class="card-body">
        <div class="title-actions" style="justify-content:flex-start;margin-top:14px">

          ${button('Set direction', 'set-direction', 'compass', running)}
        </div>
      </div>
    </section>`;
  }
  const byOwner = d.set_by_role === 'Owner';
  const s = d.scorecard;
  // A direction is a claim about what will work. Show what it has produced so far.
  const commerce=s&&Object.hasOwn(s,'revenueUsd');
  const nothingYet = s && s.daysActive >= 1 && !s.completedTasks && !s.recordedProgress?.documentVersions && !s.recordedProgress?.fetchedSources && !s.recordedProgress?.approvedActions;
  return `<section class="card direction-card">
    <div class="card-header">
      <div><div class="eyebrow">Operating direction</div><h2>${esc(d.headline)}</h2></div>
      ${icon('compass')}
    </div>
    <div class="card-body">
      <p class="direction-statement">${linkedText(d.statement)}</p>
      <div class="direction-foot">
        <span class="attribution ${byOwner ? 'owner' : ''}">${icon(byOwner ? 'shield' : 'person')}${byOwner ? 'You set this' : `Set by ${esc(d.set_by_name || 'the CEO')}`} · ${ago(d.created_at)}</span>
        <span class="direction-links">
          ${state.data.directions.length > 1 ? '<button class="text-link" data-action="direction-history">Direction history</button>' : ''}
          <button class="text-link" data-action="set-direction">Override</button>
        </span>
      </div>
      ${s ? `<div class="scorecard">
        <span class="eyebrow">Mission activity since this edit${s.daysActive ? `, ${s.daysActive} ${s.daysActive === 1 ? 'day' : 'days'} ago` : ''}</span>
        <div class="scorecard-row">
          ${commerce?`<div><strong>${money(s.revenueUsd)}</strong><span>earned</span></div>`:''}
          <div><strong>${money(s.spendUsd)}</strong><span>spent</span></div>
          <div><strong>${s.completedTasks}</strong><span>tasks completed</span></div>
          ${commerce?`<div><strong>${s.opportunitiesOpened}</strong><span>opportunities</span></div>`:`<div><strong>${s.recordedProgress?.documentVersions??0}</strong><span>document versions</span></div>`}
          ${s.failedTasks ? `<div class="bad"><strong>${s.failedTasks}</strong><span>failed</span></div>` : ''}
        </div>
        <p class="section-note">Mission totals for this period. Activity alone does not establish that completion conditions are satisfied.</p>
        ${nothingYet ? '<p class="section-note">No recorded progress in this reporting period.</p>' : ''}
      </div>` : ''}
      ${byOwner && running ? '<p class="section-note">You are steering. The CEO can still replace this when its evidence disagrees.</p>' : ''}
    </div>
  </section>`;
}

/** The mandate is the owner's boundary; the direction is the agents' strategy inside it. */
export function mandateStrip() {
  const c = state.data.company;
  return `<div class="mandate-strip">
    <div><span class="eyebrow">Your mandate to the company</span><p>${truncate(c.mandate, 260)}</p></div>
    <button class="text-link" data-action="mandate">Edit mandate & limits ${icon('arrow')}</button>
  </div>`;
}
