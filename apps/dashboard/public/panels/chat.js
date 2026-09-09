import { messageMarkdown } from '../lib/markdown.js';
import {state} from '../lib/state.js';
import {api} from '../lib/api.js';
import {esc,ago} from '../lib/format.js';
import {icon} from '../lib/icons.js';
import {employeeActivity} from './org.js';
let opened=false,selected='ceo',loading=false,sending=false,lastLoad=0,history=[],historyFor='',signature='';
const drafts=new Map(),requests=new Map();
export function removeChat(){document.querySelector('#agent-chat')?.remove();opened=false;history=[];historyFor='';signature='';drafts.clear();requests.clear();}
export function updateChat(){
 if(!state.data)return;
 let host=document.querySelector('#agent-chat');
 if(!host){
  host=document.createElement('div');host.id='agent-chat';host.innerHTML=`<button class="chat-launcher" aria-label="Chat with an agent" aria-expanded="false">${icon('chat')}<span>Chat</span></button>
  <section class="chat-pane" aria-label="Agent chat" hidden><header class="chat-heading"><strong>Agent chat</strong><button class="quiet small chat-close" aria-label="Close agent chat">Close</button></header>
  <label class="chat-recipient-label">Agent<select class="chat-recipient" aria-label="Chat recipient"></select></label><div class="chat-profile"></div>
  <div class="chat-history" role="log" aria-label="Conversation" aria-live="polite"></div><p class="chat-error" role="alert"></p>
  <form class="chat-compose"><label class="sr-only" for="chat-message">Message</label><textarea id="chat-message" maxlength="10000" rows="3" placeholder="Message the CEO..." required></textarea><div class="chat-compose-footer"><small>Internal chat. Replies use the selected model.</small><button type="submit">Send</button></div></form></section>`;
  document.body.append(host);
  host.querySelector('.chat-launcher').onclick=()=>{opened=!opened;updateChat();if(opened){host.querySelector('textarea').focus();const log=host.querySelector('.chat-history');log.scrollTop=log.scrollHeight;}};
  host.querySelector('.chat-close').onclick=()=>{opened=false;updateChat();host.querySelector('.chat-launcher').focus();};
  host.querySelector('select').onchange=e=>{selected=e.target.value;history=[];historyFor='';signature='';lastLoad=0;host.querySelector('textarea').value=drafts.get(selected)||'';renderHistory();updateChat();};
  host.querySelector('textarea').oninput=e=>drafts.set(selected,e.target.value);
  host.querySelector('form').onsubmit=send;
  host.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();opened=false;updateChat();host.querySelector('.chat-launcher').focus();}if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&e.target.tagName==='TEXTAREA'){e.preventDefault();host.querySelector('form').requestSubmit();}});
 }
 host.querySelector('.chat-pane').hidden=!opened;host.querySelector('.chat-launcher').hidden=opened;host.querySelector('.chat-launcher').setAttribute('aria-expanded',String(opened));
 const people=(state.data.employees||[]).filter(e=>e.status==='ACTIVE');
 const options=[['ceo',people.find(e=>e.role==='CEO')?.name+' / CEO'],...people.filter(e=>e.role!=='CEO').map(e=>[e.id,`${e.name} / ${e.role}`])];
 if(!people.some(e=>e.role==='CEO'))options[0][1]='CEO';
 const select=host.querySelector('select');const markup=options.map(([id,name])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('');
 if(select.dataset.options!==markup){select.innerHTML=markup;select.dataset.options=markup;if(!options.some(([id])=>id===selected))selected='ceo';}select.value=selected;
 const person=people.find(e=>selected==='ceo'?e.role==='CEO':e.id===selected);
 const department=state.data.departments?.find(d=>d.id===person?.department_id)?.name || person?.department_id || 'Executive';
 const status=person?employeeActivity(person):{label:'Not appointed'};
 const profile=host.querySelector('.chat-profile');
 const profileMarkup=`<span>${esc(department)} ? ${esc(status.label)}</span>${status.detail?`<details class="chat-status-details"><summary>Status details</summary><small>${esc(status.detail)}</small></details>`:''}`;
 if(profile.dataset.content!==profileMarkup){const expanded=profile.querySelector('details')?.open&&profile.dataset.person===selected;profile.innerHTML=profileMarkup;profile.dataset.content=profileMarkup;profile.dataset.person=selected;if(expanded&&profile.querySelector('details'))profile.querySelector('details').open=true;}
 host.querySelector('textarea').placeholder=`Message ${person?.name||'the CEO'}...`;
 host.querySelector('button[type=submit]').disabled=sending || state.data.company.status==='KILLED';
 host.querySelector('.chat-compose-footer small').textContent=state.data.company.status==='PAUSED'?'Company paused. Replies will queue until resumed.':state.data.company.status==='KILLED'?'Company stopped. Messaging is unavailable.':'Internal chat. Replies use the selected model.';
 if(opened && !loading && Date.now()-lastLoad>4000)void load();
}
async function load(){
 const who=selected;loading=true;lastLoad=Date.now();
 try{const data=await api(`/conversations/${encodeURIComponent(who)}`);if(who!==selected || !state.data || !document.querySelector('#agent-chat'))return;history=data.messages;historyFor=who;document.querySelector('#agent-chat .chat-error').textContent='';renderHistory();}
 catch(error){const target=document.querySelector('#agent-chat .chat-error');if(who===selected && target)target.textContent=error.message;}
 finally{loading=false;if(who!==selected){lastLoad=0;updateChat();}}
}
function renderHistory(){
 const log=document.querySelector('#agent-chat .chat-history');if(!log)return;
 const messages=historyFor===selected?history:[];const next=JSON.stringify([selected,messages]);if(signature===next)return;signature=next;
 const atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<70;
 log.innerHTML=messages.length?messages.map(m=>`<article class="chat-message ${m.sender_id==='owner'?'from-owner':'from-agent'}"><strong>${m.sender_id==='owner'?'You':esc(state.data.employees?.find(e=>e.id===m.sender_id)?.name||'CEO')}</strong><div class="message-markdown">${messageMarkdown(m.body)}</div><small>${ago(m.created_at)}${m.sender_id==='owner'&&m.task_status?` | ${esc(m.task_status==='COMPLETED'?'Answered':m.task_status==='RUNNING'?'Preparing reply':m.task_status.replaceAll('_',' ').toLowerCase())}`:''}</small>${m.task_error?`<small class="chat-task-error">${esc(m.task_error)}</small>`:''}</article>`).join(''):'<p class="chat-empty">Send a message to ask about current work or give direction. Replies appear here after the agent checks its answer.</p>';
 if(atBottom)log.scrollTop=log.scrollHeight;
}
async function send(event){
 event.preventDefault();if(sending)return;const host=document.querySelector('#agent-chat');const input=host.querySelector('textarea');const body=input.value.trim();if(!body)return;
 const who=selected;const request=requests.get(who)?.body===body?requests.get(who):{body,requestId:crypto.randomUUID(),recipientId:who,subject:body.slice(0,100),budgetUsd:(Number(state.data.company.cycle_budget)/1e6).toFixed(6),tokenBudget:Math.max(1000,Number(state.data.company.cycle_tokens))};requests.set(who,request);
 sending=true;host.querySelector('.chat-error').textContent='';updateChat();
 try{await api('/conversations','POST',request);drafts.delete(who);requests.delete(who);if(selected===who){input.value='';lastLoad=0;await load();}}
 catch(error){host.querySelector('.chat-error').textContent=error.message;}
 finally{sending=false;updateChat();}
}
