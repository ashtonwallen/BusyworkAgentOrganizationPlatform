import { api } from '../lib/api.js';
import { ctx } from '../lib/context.js';
import { state } from '../lib/state.js';
import { esc, micro, date, titleCase } from '../lib/format.js';
import { card, table } from '../lib/ui.js';
const view={category:'all',search:'',showZero:false,rows:[],hasMore:false,loading:false,loaded:false,error:'',model:'',day:''};
let generation=0, snapshotKey, scheduled=false;
async function load(more=false) {
  const ticket=++generation;
  view.loading=true;view.error='';
  if(!more)view.rows=[];
  if(state.page==='finance')ctx.renderPage();
  try {
    const q=new URLSearchParams({category:view.category,search:view.search,showZero:String(view.showZero),offset:String(view.rows.length)});
    if(view.model){q.set('model',view.model);q.set('day',view.day);}
    const result=await api('/ledger/view?'+q);
    if(ticket!==generation)return;
    view.rows.push(...result.rows);view.hasMore=result.hasMore;view.loaded=true;
  }catch(error){if(ticket===generation)view.error=error.message;}
  finally{if(ticket===generation){view.loading=false;if(state.page==='finance')ctx.renderPage();}}
}
export function ledgerPanel(){
  const key=JSON.stringify([state.data.ledgerRevision,state.data.ledger?.[0]?.id]);
  if(snapshotKey!==key){
    snapshotKey=key;generation++;
    Object.assign(view,{loaded:false,loading:false,error:'',rows:[],hasMore:false});
    if(!state.data.ledger?.length){view.model='';view.day='';}
  }
  if(!view.loaded&&!view.loading&&!view.error&&!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;void load();});}
  const rows=view.rows.map(l=>`<tr><td class="wrap">${l.calls?`<button class="table-link" data-ledger-model="${esc(l.model_id)}" data-ledger-day="${esc(l.day)}">${esc(l.model_id)} · ${l.calls} calls</button><div class="row-detail">Daily total (UTC) · Open individual transactions</div>`:esc(l.description)}${!l.calls&&l.external_reference?`<div class="row-detail">${esc(l.external_reference)}</div>`:''}</td><td>${esc(titleCase(l.account))}</td><td>${esc(titleCase(l.kind))}</td><td class="numeric" title="${esc('$'+(Number(l.amount)/1e6).toFixed(6))}">${micro(l.amount)}</td><td class="numeric">${date(l.occurred_at)}</td></tr>`);
  return card('Transactions',`<form id="ledger-filter" class="ledger-filters card-body">
    <label>Type<select name="category">${[['all','All'],['business','Business'],['models','Models']].map(([v,t])=>`<option value="${v}" ${view.category===v?'selected':''}>${t}</option>`).join('')}</select></label>
    <label>Search<input name="search" value="${esc(view.search)}" placeholder="Description, model or reference" maxlength="250"></label>
    <label class="ledger-zero"><input type="checkbox" name="showZero" ${view.showZero?'checked':''}> Include zero-cost transactions</label>
    <button type="submit">Apply</button><button type="button" data-ledger-refresh>Refresh</button></form>
    ${view.model?`<div class="card-body"><button data-ledger-back>Back to daily totals</button> ${esc(view.model)} · ${esc(view.day)}</div>`:''}
    ${view.error?`<p class="error-message" role="alert">${esc(view.error)}</p>`:''}
    ${rows.length?table([{label:'Transaction'},{label:'Account'},{label:'Type'},{label:'Amount',numeric:true},{label:'Date (UTC)',numeric:true}],rows):`<p class="card-body">${view.loading?'Loading transactions…':'No matching transactions.'}</p>`}
    <div class="card-body">${view.rows.length} ${view.model?'transactions':'rows'} shown ${view.loading?' · Loading…':''} ${view.hasMore?`<button data-ledger-more ${view.loading?'disabled':''}>Load 50 more</button>`:''}</div>`,{subtitle:'Model calls grouped by model and UTC day. Entries are append-only; export retains every transaction.'});
}
document.addEventListener('submit',event=>{
  if(event.target.id!=='ledger-filter')return;
  event.preventDefault();const values=new FormData(event.target);
  Object.assign(view,{category:values.get('category'),search:values.get('search'),showZero:values.has('showZero'),model:'',day:''});void load();
});
document.addEventListener('click',event=>{
  const el=event.target.closest('[data-ledger-more],[data-ledger-refresh],[data-ledger-model],[data-ledger-back]');if(!el)return;
  if(el.hasAttribute('data-ledger-model')){view.model=el.dataset.ledgerModel;view.day=el.dataset.ledgerDay;}
  if(el.hasAttribute('data-ledger-back')){view.model='';view.day='';}
  void load(el.hasAttribute('data-ledger-more'));
});
