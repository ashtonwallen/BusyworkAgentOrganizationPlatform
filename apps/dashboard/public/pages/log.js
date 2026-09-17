import { ctx } from '../lib/context.js';
import { state } from '../lib/state.js';
import { esc, ago, dateTime } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { pageTitle, card, empty } from '../lib/ui.js';
import { describe, categories, refAttribute } from '../lib/events.js';

export function log() {
  const snapshotEvents = state.data.events || [];
  const extraEvents = state.extraEvents || [];

  // Combine and deduplicate by sequence/id
  const eventMap = new Map();
  for (const e of [...snapshotEvents, ...extraEvents]) {
    eventMap.set(e.id || e.sequence, e);
  }
  const events = [...eventMap.values()].sort((a, b) => Number(b.sequence) - Number(a.sequence));

  const routine = new Set(['call.reserved','call.dispatched','call.settled']);
  const groups=new Map(),visibleEvents=[];
  for(const event of events){
    if(!routine.has(event.type)||!event.entity_id){visibleEvents.push({event});continue;}
    if(!state.logRoutine)continue;
    let group=groups.get(event.entity_id);
    if(!group){group={event,callEvents:[]};groups.set(event.entity_id,group);visibleEvents.push(group);}
    group.callEvents.push(event);
  }
  const described=visibleEvents.map(group=>{
    const description=describe(group.event);
    if(group.callEvents){
      const model=group.callEvents.find(e=>e.payload?.modelId)?.payload.modelId||(state.data.calls||[]).find(c=>c.id===group.event.entity_id)?.model_id;
      if(model)description.text=`${esc(model)}: ${description.text}`;
    }
    return {...group,...description};
  });
  const counts = described.reduce((acc, d) => ({ ...acc, [d.category]: (acc[d.category] || 0) + 1 }), {});
  const filtered = state.logFilter === 'all' ? described : described.filter((d) => d.category === state.logFilter);

  const filters = [['all', 'Everything', described.length], ...Object.entries(categories).map(([key, label]) => [key, label, counts[key] || 0])]
    .filter(([key, , count]) => key === 'all' || count > 0);

  const maxSeq = events.length ? Math.max(...events.map((e) => Number(e.sequence))) : 0;
  const minSeq = events.length ? Math.min(...events.map((e) => Number(e.sequence))) : 1;
  const canLoadMore = minSeq > 1;

  const footer = `<div class="log-footer">
    <span>Showing ${filtered.length} rows from ${events.length} loaded audit events</span>
    ${canLoadMore ? `<button class="button small quiet" data-action="load-older-events" data-before="${minSeq}">Load older events ${icon('arrow')}</button>` : '<span class="muted">Earliest recorded event reached</span>'}
    <span class="muted">Append-only audit</span>
  </div>`;

  return pageTitle(state.data.mission?.capabilities.includes('commerce')?'Company log':'Activity log', 'Everything that happened, in order. This record cannot be edited or deleted.')
    + `<label class="log-traffic"><input type="checkbox" data-log-routine ${state.logRoutine?'checked':''}> Show routine model traffic</label><div class="log-toolbar">
        <div class="log-filters">${filters.map(([key, label, count]) => `<button class="filter ${state.logFilter === key ? 'selected' : ''}" data-log-filter="${key}">${esc(label)}<span>${count}</span></button>`).join('')}</div>
        <div class="log-actions"><button class="button small quiet" data-action="load-newer-events" data-after="${maxSeq}">${icon('refresh')} Check for new events</button></div>
      </div>`
    + card('', filtered.length ? `<div class="log">${filtered.map((d) => {
      const ref = refAttribute(d.ref);
      const body = `<span class="log-icon ${d.category}">${icon(d.icon)}</span>
        <span class="log-text">${d.text}</span>
        <time class="log-time" title="${esc(dateTime(d.event.created_at))}">${ago(d.event.created_at)}</time>`;
      if(d.callEvents)return `<details class="log-call-group"><summary class="log-row">${body}<span class="badge">${d.callEvents.length} events</span></summary><div class="log-call-detail">${[...d.callEvents].reverse().map(event=>`<p><time>${esc(dateTime(event.created_at))}</time> ${describe(event).text}</p>`).join('')}${ref?`<button class="text-link"${ref}>View objective</button>`:''}<p class="section-note">Events for this call within the loaded history.</p></div></details>`;
      return ref ? `<button class="log-row link"${ref}>${body}</button>` : `<div class="log-row">${body}</div>`;
    }).join('')}</div>`
      : empty('Nothing in this category', 'Try another filter.', '', 'log'),
      { footer });
}

document.addEventListener('change',event=>{if(event.target.hasAttribute('data-log-routine')){state.logRoutine=event.target.checked;ctx.renderPage();}});
