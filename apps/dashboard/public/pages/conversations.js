import {consultationPanel} from '../panels/consultations.js';
import { api, toast } from '../lib/api.js';
import { ctx } from '../lib/context.js';
import { messageMarkdown } from '../lib/markdown.js';
import { state, employeeName } from '../lib/state.js';
import { esc, ago, badge, truncate } from '../lib/format.js';
import { pageTitle, card, empty, button } from '../lib/ui.js';

let visibleCount=20,olderMessages=[],historyLoading=false,historyExhausted=false;
function allMessages(){
 const snapshot=state.data.ownerMessages||[],seen=new Set();
 const cachedIds=new Set(olderMessages.map(m=>m.id));
 if(snapshot.length&&olderMessages.length&&!snapshot.some(m=>cachedIds.has(m.id))){olderMessages=[];historyExhausted=false;visibleCount=20;}
 return [...snapshot,...olderMessages].filter(m=>{if(seen.has(m.id))return false;seen.add(m.id);return true;});
}
const expandedMessages=new Set();
export function conversations() {
  const messages=allMessages();
  return pageTitle('Conversations','Internal correspondence with your agents. Requested replies consume their configured model budgets and wait while the company is paused.',
    button('Ask an agent','request-reply','chat',true))
    + consultationPanel()
    + card('Owner correspondence',messages.length?`<div class="card-body messages correspondence-list">${messages.slice(0,visibleCount).map(m=>{
      return `<article class="message"><div class="message-head"><strong>${esc(m.subject)}</strong>
        ${m.task_status?badge(m.task_status):badge('DONE',m.sender_id==='owner'?'Recorded':'Reply')}</div>
        ${String(m.body||'').length>500?`<details class="correspondence-body" data-conversation-id="${esc(m.id)}" ${expandedMessages.has(m.id)?'open':''}><summary><span>${truncate(String(m.body).replace(/\*\*|^#{1,6}\s/gm,''),220)}</span><span class="text-link">Read full message</span></summary><div class="message-markdown">${messageMarkdown(m.body)}</div></details>`:`<div class="message-markdown">${messageMarkdown(m.body)}</div>`}
        <div class="message-foot"><span>${esc(m.sender_name || employeeName(m.sender_id))} → ${esc(m.recipient_name || employeeName(m.recipient_id))}</span>
        <span>${ago(m.created_at)} ${m.task_id?`<button class="text-link" data-task="${m.task_id}">View work</button>`:''}</span></div></article>`;
    }).join('')}</div>`:empty('No owner conversations','Ask the CEO or another employee a question. Their reviewed response appears here.','','chat'),
    {footer:messages.length?`<span>${Math.min(visibleCount,messages.length)} of ${messages.length} loaded messages</span>${visibleCount<messages.length?'<button class="small quiet" data-conversations-more>Show 20 more</button>':!historyExhausted&&(state.data.ownerMessages||[]).length>=100?`<button class="small quiet" data-conversations-older ${historyLoading?'disabled':''}>${historyLoading?'Loading?':'Load older messages'}</button>`:'<span class="muted">Beginning of correspondence</span>'}`:'',subtitle:'Most recent owner correspondence. Full task details retain budgets, approval requirements, reviews and failure reasons.'});
}

document.addEventListener('click',event=>{if(event.target.closest('[data-conversations-more]')){visibleCount+=20;ctx.renderPage();}});

document.addEventListener('toggle',event=>{const el=event.target;if(!el.matches?.('.correspondence-body'))return;if(el.open)expandedMessages.add(el.dataset.conversationId);else expandedMessages.delete(el.dataset.conversationId);},true);

document.addEventListener('click',async event=>{
 if(!event.target.closest('[data-conversations-older]')||historyLoading)return;
 const messages=allMessages(),before=messages.at(-1)?.id;if(!before)return;
 historyLoading=true;ctx.renderPage();
 try{const result=await api('/conversations/history?before='+encodeURIComponent(before));olderMessages=[...messages,...result.messages];historyExhausted=!result.hasMore;visibleCount+=20;}
 catch(error){toast(error.message);}
 finally{historyLoading=false;if(state.page==='conversations')ctx.renderPage();}
});
