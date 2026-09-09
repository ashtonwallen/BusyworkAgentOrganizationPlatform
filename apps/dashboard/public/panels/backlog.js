import {state,employeeName} from '../lib/state.js';
import {api,toast} from '../lib/api.js';
import {ctx} from '../lib/context.js';
import {esc,badge} from '../lib/format.js';
import {card,empty} from '../lib/ui.js';
import {openModal,form,field,selectField,handleModal} from '../lib/modal.js';
let showClosed=false,limit=20;
const closed=item=>item.payload.cancelled||item.task_status==='COMPLETED';
const editable=item=>!item.task_id||['FAILED','EXPIRED','CANCELLED'].includes(item.task_status);
export function backlogPanel(){
 const schedules=state.data.backlogSchedules||[];
 const schedulePanel=schedules.length?card('Scheduled backlog work',`<div class="card-body">${schedules.map(s=>`<div class="document-row"><span><strong>${esc(s.payload.title)}</strong><small>${esc(employeeName(s.payload.employeeId))} &middot; Earliest start: ${esc(new Date(s.payload.notBefore).toLocaleString())}</small><small>${esc(s.reason||'Waiting for scheduler')}</small></span><div class="form-actions"><button class="small quiet" data-backlog-view="${esc(s.payload.backlogId)}">Plan</button><button class="small quiet" data-schedule-cancel="${esc(s.id)}">Cancel schedule</button></div></div>`).join('')}</div>`,{subtitle:'Waits for prerequisites and employee availability. Company runtime and spending controls apply.'}):'';
 const all=state.data.backlog||[],rows=all.filter(b=>showClosed||!closed(b));
 return schedulePanel+card('Work backlog',rows.length?`<div class="card-body">${rows.slice(0,limit).map(item=>{
  const p=item.payload,blocked=p.dependsOn.filter(id=>{const d=all.find(b=>b.id===id);return !d||d.payload.cancelled||d.task_status!=='COMPLETED'||!d.operations_applied;}).length;
  return `<div class="document-row"><span><strong>${esc(p.title)}</strong><small>${esc(p.priority.toLowerCase())} priority &middot; ${p.employeeId?esc(employeeName(p.employeeId)):'Unassigned'}${p.experimentId?` &middot; ${esc(state.data.experiments.find(e=>e.id===p.experimentId)?.title||'Linked opportunity')}`:''}${blocked?` &middot; ${blocked} pending prerequisite(s)`:''}</small></span><div class="form-actions">${badge(p.cancelled?'CANCELLED':item.task_status||'PLANNED')}<button class="small quiet" data-backlog-view="${esc(item.id)}">Details</button>${editable(item)?`<button class="small quiet" data-backlog-edit="${esc(item.id)}">Edit</button>`:''}${item.task_id?`<button class="small quiet" data-task="${esc(item.task_id)}">Objective</button>`:''}${!p.cancelled&&editable(item)?`<button class="small" data-backlog-start="${esc(item.id)}" ${blocked?'disabled':''}>Assign work</button>`:''}</div></div>`;
 }).join('')}</div>`:empty('No planned work','Record useful work before assigning it. Agents can maintain this shared backlog.','','work'),{aside:'<button class="small" data-backlog-edit="new">Add work</button>',footer:`<label><input type="checkbox" data-backlog-closed ${showClosed?'checked':''}> Show completed and cancelled</label><span>${Math.min(limit,rows.length)} of ${rows.length} items</span>${rows.length>limit?'<button class="small" data-backlog-more>Show 20 more</button>':''}`});
}
export function editBacklog(item){
 const p=item?.payload||{},rows=state.data.backlog||[];
 openModal(item?.id?'Edit planned work':'Plan work',form(field('Title','title',p.title||'')+field('Instructions','instructions',p.instructions||'','textarea')+field('Success criteria','successCriteria',p.successCriteria||'','textarea')
 +selectField('Priority','priority',[['HIGH','High'],['NORMAL','Normal'],['LOW','Low']],p.priority||'NORMAL')
 +selectField('Customer order','orderId',[['','No order'],...(state.data.orders||[]).map(o=>[o.id,o.title])],p.orderId||'')
 +selectField('Opportunity attribution','experimentId',[['','No explicit attribution'],...state.data.experiments.map(e=>[e.id,e.title])],p.experimentId||'')
 +selectField('Responsible employee','employeeId',[['','Unassigned'],...state.data.employees.filter(e=>e.status==='ACTIVE').map(e=>[e.id,e.name])],p.employeeId||'')
 +`<label class="field">Prerequisite work (optional)<select id="backlog-dependencies" multiple size="4">${rows.filter(r=>r.id!==item?.id&&!r.payload.cancelled).map(r=>`<option value="${esc(r.id)}" ${(p.dependsOn||[]).includes(r.id)?'selected':''}>${esc(r.payload.title)}</option>`).join('')}</select></label>`
 +selectField('State','cancelled',[['false','Planned'],['true','Cancelled']],String(p.cancelled||false)),'Save planned work'),{wide:true});
 handleModal(x=>api('/backlog/'+(item?.id||crypto.randomUUID()),'PUT',{...x,orderId:x.orderId||null,experimentId:x.experimentId||null,employeeId:x.employeeId||null,cancelled:x.cancelled==='true',dependsOn:[...document.querySelector('#backlog-dependencies').selectedOptions].map(o=>o.value),expectedVersion:p.version||0}),'Work plan saved.');
}
document.addEventListener('change',event=>{if(event.target.matches('[data-backlog-closed]')){showClosed=event.target.checked;ctx.renderPage();}});
document.addEventListener('click',async event=>{
 const button=event.target.closest('button');if(!button||!state.data)return;const rows=state.data.backlog||[];
 if(button.dataset.scheduleCancel){button.disabled=true;try{await api('/backlog-schedules/'+encodeURIComponent(button.dataset.scheduleCancel)+'/cancel','POST',{});toast('Schedule cancelled.');await ctx.refresh(true);}catch(error){toast(error.message);button.disabled=false;}return;}
 if(button.hasAttribute('data-backlog-more')){limit+=20;ctx.renderPage();return;}
 if(button.dataset.backlogEdit){editBacklog(rows.find(r=>r.id===button.dataset.backlogEdit));return;}
 if(button.dataset.backlogView){const item=rows.find(r=>r.id===button.dataset.backlogView);if(item)openModal(item.payload.title,`<h3>Instructions</h3><pre class="document-content">${esc(item.payload.instructions)}</pre><h3>Success criteria</h3><p>${esc(item.payload.successCriteria)}</p><h3>Prerequisites</h3><p>${item.payload.dependsOn.map(id=>esc(rows.find(r=>r.id===id)?.payload.title||'Unavailable item')).join(', ')||'None'}</p>`);return;}
 if(button.dataset.backlogStart){button.disabled=true;try{await api('/backlog/'+button.dataset.backlogStart+'/start','POST',{});toast('Objective queued. Company runtime and approvals apply.');await ctx.refresh(true);}catch(error){toast(error.message);button.disabled=false;}}
});
