import {ctx} from '../lib/context.js';
import {state} from '../lib/state.js';
import {api,toast,download} from '../lib/api.js';
import {esc,ago,badge} from '../lib/format.js';
import {card,empty,helpTip,pageTitle} from '../lib/ui.js';
import {openModal,form,field,handleModal,selectField} from '../lib/modal.js';
let visibleCount=20,olderMessages=[],historyLoading=false,historyExhausted=false;
let searchResults=null,searchQuery='',searchDraft='',searchBefore=null,searchVersion=0,searchLoading=false,searchError='';
async function searchMailbox(append=false){
 const version=append?searchVersion:++searchVersion;if(!append){searchQuery=searchDraft.trim();searchResults=searchQuery?[]:null;searchBefore=null;visibleCount=20;}
 if(!searchQuery){searchLoading=false;searchError='';ctx.renderPage();return;}searchLoading=true;searchError='';ctx.renderPage();
 try{const result=await api('/email/history?search='+encodeURIComponent(searchQuery)+(append&&searchBefore?'&before='+encodeURIComponent(searchBefore):''));if(version!==searchVersion)return;searchResults=append?[...searchResults,...result.messages]:result.messages;searchBefore=result.nextBefore;if(append)visibleCount+=30;}catch(error){if(version===searchVersion)searchError=error.message;}finally{if(version===searchVersion){searchLoading=false;if(state.page==='email')ctx.renderPage();}}
}
document.addEventListener('input',event=>{if(event.target.id==='email-search-query')searchDraft=event.target.value;});
document.addEventListener('submit',event=>{if(event.target.id==='email-search'){event.preventDefault();void searchMailbox();}});
function allEmails(){
 if(searchResults!==null)return searchResults;
 const snapshot=state.data.emailMessages||[],seen=new Set(),cachedIds=new Set(olderMessages.map(m=>m.id));
 if(snapshot.length&&olderMessages.length&&!snapshot.some(m=>cachedIds.has(m.id))){olderMessages=[];historyExhausted=false;visibleCount=20;}
 return [...snapshot,...olderMessages].filter(m=>{if(seen.has(m.id))return false;seen.add(m.id);return true;});
}
function historyFooter(rows){if(searchResults!==null)return `<span>${Math.min(visibleCount,rows.length)} of ${rows.length} loaded matches</span>${visibleCount<rows.length?'<button class="small quiet" data-email-more>Show 20 more</button>':searchBefore?`<button class="small quiet" data-email-search-more ${searchLoading?'disabled':''}>Load older matches</button>`:''}`;return rows.length?`<span>${Math.min(visibleCount,rows.length)} of ${rows.length} loaded messages</span>${visibleCount<rows.length?'<button class="small quiet" data-email-more>Show 20 more</button>':!historyExhausted&&(state.data.emailMessages||[]).length>=100?`<button class="small quiet" data-email-older ${historyLoading?'disabled':''}>${historyLoading?'Loading...':'Load older messages'}</button>`:'<span class="muted">Beginning of recorded email history</span>'}`:'';}
document.addEventListener('click',async event=>{
 if(event.target.closest('[data-email-search-clear]')){searchDraft='';void searchMailbox();return;}
 if(event.target.closest('[data-email-search-more]')){if(!searchLoading)void searchMailbox(true);return;}
 if(event.target.closest('[data-email-more]')){visibleCount+=20;ctx.renderPage();return;}
 if(!event.target.closest('[data-email-older]')||historyLoading)return;
 const messages=allEmails(),before=messages.at(-1)?.id;if(!before)return;
 historyLoading=true;ctx.renderPage();
 try{const result=await api('/email/history?before='+encodeURIComponent(before));olderMessages=[...messages,...result.messages];historyExhausted=!result.nextBefore;visibleCount+=20;}
 catch(error){toast(error.message);}
 finally{historyLoading=false;if(state.page==='email')ctx.renderPage();}
});
function entityRecords(){
 const rows=state.data.emailEntities||[];
 return card('Business records',`<div class="card-body"><button data-action="email-entity">Add business record</button>
 ${helpTip('Address matches link email to records; they do not verify demand, consent or payment.')} ${rows.length===100?'<p class="section-note">Showing the first 100 records.</p>':''}
 ${!rows.length?'<p>No business records yet. Add a prospect, customer, campaign or project to associate it with email.</p>':''}${rows.map(r=>`<button class="document-row" data-action="email-entity" data-entity-id="${esc(r.id)}" data-entity-kind="${esc(r.kind)}"><span><strong>${esc(r.label)}</strong><small>${esc(r.kind)} / ${esc(r.addresses.join(', ')||'No addresses')}</small></span><span>${r.linked_messages} linked messages</span></button>`).join('')}</div>`);
}
export function emailPage(){
 const box=state.data.emailMailbox,rows=allEmails();
 return pageTitle('Email','Business correspondence and mailbox controls.')+card('Business email',`<div class="card-body"><div class="detail-meta"><strong>${esc(state.data.instance?.mailbox||'Mailbox not configured')}</strong>${badge(box?.enabled&&box?.connected?'CONNECTED':'DISCONNECTED')}</div><p>${box?.last_synced_at?'Last synchronized '+ago(box.last_synced_at):'Mailbox has not synchronized yet.'}</p>${box?.error?`<p class="notice amber">${esc(box.error)}</p>`:''}<div class="form-actions">${!box?.connected?`<button data-action="email-connect" ${state.data.emailOAuthConfigured?'':'disabled'}>Connect Google Workspace</button>`:''}<button data-action="email-sync" ${!box?.connected?'disabled':''}>Sync mailbox</button><button data-action="email-settings">Settings and permissions</button><button data-action="email-compose" class="primary" ${state.data.instance?.mailbox?'':'disabled'}>Compose email</button></div>${!state.data.emailOAuthConfigured?'<details open><summary>Connection setup</summary><p>Set HIVE_BUSINESS_EMAIL to the account you want to connect. Create your own OAuth web client with the Gmail API enabled, configure HIVE_GMAIL_CLIENT_ID, HIVE_GMAIL_CLIENT_SECRET and HIVE_GMAIL_REDIRECT_URI, then restart Busywork. Register that exact redirect URI in your Google project and connect the matching account.</p></details>':''}</div>`)
 +entityRecords()+card('Messages',`<div class="card-body"><form id="email-search" class="document-search"><label for="email-search-query">Search cached email</label><div><input id="email-search-query" maxlength="250" value="${esc(searchDraft)}" placeholder="Subject, body or email address"><button type="submit">Search</button>${searchResults!==null?'<button type="button" data-email-search-clear>Clear</button>':''}</div></form>${searchLoading?'<p role="status">Searching cached email...</p>':''}${searchError?`<p class="notice amber">${esc(searchError)}</p>`:''}${rows.length?rows.slice(0,visibleCount).map(m=>`<button class="document-row" data-email="${esc(m.id)}"><span><strong>${esc(m.subject||'(No subject)')}</strong><small>${m.direction==='OUTBOUND'?'To: ':'From: '}${esc((m.direction==='OUTBOUND'?[...(m.recipients||[]),...(m.cc_recipients||[]).map(a=>'Cc: '+a),...(m.bcc_recipients||[]).map(a=>'Bcc: '+a)]:(m.sender||[])).join(', ')||'No recipient recorded')}</small>${state.data.emailQueueStatus?.[m.id]?`<small>${esc(state.data.emailQueueStatus[m.id].message)}</small>`:''}</span><span>${badge(m.status)}<small>${ago(m.received_at||m.created_at)}</small></span></button>`).join(''):searchResults!==null?(searchLoading||searchError?'':empty('No matching email','Try different words or clear the search. Only locally retained content is searched.','','inbox')):empty('No email recorded','Connect the mailbox to ingest messages. Drafts remain subject to Hive communication policy.','','inbox')}</div>`,{footer:historyFooter(rows)});
}
export async function connectEmail(){const {url}=await api('/email/connect','POST',{});location.assign(url);}
export async function syncEmail(){await api('/email/sync','POST',{});toast('Mailbox synchronized.');}
const addresses=value=>value.split(/[,;\n]/).map(v=>v.trim()).filter(Boolean);
export async function composeEmail(reply,workspaceAttachment,preset){
 const c=reply?.content,requestId=crypto.randomUUID();
 const documents=(state.data.documents||[]).map(d=>({...d}));for(const doc of preset?.documents||[])if(!documents.some(d=>d.path===doc.path&&d.version===doc.version))documents.push(doc);
 let attachmentCount=0;const attachmentLimit=workspaceAttachment?4:5;
 const attachmentSection=`<fieldset class="email-attachment-picker"><legend>Document attachments (optional)</legend><p class="section-note">Attach up to five shared document versions. Use a .pdf filename to render a PDF. The versions shown here are fixed for this draft.</p><div id="email-attachment-rows"></div><button type="button" id="email-add-attachment" ${documents.length?'':'disabled'}>Add document</button>${documents.length?'':'<p>No shared documents available. Create a document in Documents first.</p>'}</fieldset>`;
 const replyRecipients=reply?.direction==='OUTBOUND'?(c?.to||[]):Array.isArray(c?.replyTo)&&c.replyTo.length?c.replyTo:c?.from||[];
 openModal(reply?'Reply':'Compose business email',form(`<p>From ${esc(state.data.instance?.mailbox||'unconfigured mailbox')}. Busywork checks communication policy before sending.</p>`+field('To','to',(preset?.to||replyRecipients).join(', '))+field('Cc','cc')+field('Bcc','bcc')+field('Subject','subject',preset?.subject||(c?(/^re:/i.test(c.subject)?c.subject:'Re: '+c.subject):''))+field('Plain-text body','text','','textarea')+field('HTML body','html','','textarea')+field('Reply-to address','replyTo',state.data.instance?.mailbox||'')+attachmentSection+(workspaceAttachment?`<p>Workspace attachment: <strong>${esc(workspaceAttachment.filename)}</strong>. The inspected file hash is fixed for this proposal.</p>`:''),'Create email proposal'),{wide:true});
 for(const name of ['to','cc','bcc','text','html','replyTo']){const input=document.querySelector(`[name=${name}]`);input.required=false;input.closest('.field')?.querySelector('small')?.remove();}
 document.querySelector('#email-add-attachment').onclick=()=>{
   if(attachmentCount>=attachmentLimit)return;const index=attachmentCount++;
   const row=document.createElement('div');row.className='email-attachment-row';
   row.innerHTML=`<label>Document<select name="attachment-${index}" aria-label="Attachment ${index+1}"><option value="">None</option>${documents.map((d,i)=>`<option value="${i}">${esc(d.title)} &middot; v${d.version} &middot; ${esc(d.path)}</option>`).join('')}</select></label><label>Filename<input name="attachment-filename-${index}" maxlength="150" placeholder="deliverable.md" aria-label="Attachment ${index+1} filename"></label>`;
   document.querySelector('#email-attachment-rows').append(row);
   row.querySelector('select').onchange=event=>{const file=row.querySelector('input');if(event.target.value===''){file.value='';file.required=false;return;}const doc=documents[Number(event.target.value)];let name=doc.path.split('/').pop().replace(/[^a-zA-Z0-9_.-]/g,'_');if(!/^[a-zA-Z0-9]/.test(name))name='document-'+name;if(!/\.(txt|md|csv|json|pdf)$/i.test(name))name+='.txt';file.value=name;file.required=true;};
   document.querySelector('#email-add-attachment').disabled=attachmentCount>=attachmentLimit;
 };
 if(preset?.documents?.length<=attachmentLimit)for(const doc of preset.documents){document.querySelector('#email-add-attachment').click();const select=document.querySelector('[name=attachment-'+(attachmentCount-1)+']');select.value=String(documents.findIndex(d=>d.path===doc.path&&d.version===doc.version));select.dispatchEvent(new Event('change'));}
 if(preset?.notice){const notice=document.createElement('p');notice.className='notice amber';notice.textContent=preset.notice;document.querySelector('#email-attachment-rows').before(notice);}
 handleModal(async x=>{
   const documentAttachments=[];
   for(let i=0;i<attachmentCount;i++){const selected=x[`attachment-${i}`];if(selected==null||selected==='')continue;const doc=documents[Number(selected)],filename=String(x[`attachment-filename-${i}`]||'').trim();if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(txt|md|csv|json|pdf)$/i.test(filename))throw new Error('Use an attachment filename ending in .txt, .md, .csv, .json or .pdf, with letters, numbers, dots, hyphens or underscores.');documentAttachments.push({path:doc.path,version:doc.version,filename});}
   await api('/email/proposals','POST',{requestId,...(preset?.order?{order:preset.order}:{}),email:{documentAttachments,workspaceAttachments:workspaceAttachment?[workspaceAttachment]:[],to:addresses(x.to),cc:addresses(x.cc),bcc:addresses(x.bcc),subject:x.subject,text:x.text,html:x.html,...(x.replyTo?{replyTo:x.replyTo}:{}),...(reply?{replyToMessageId:reply.id}:{}),links:preset?.links||[]}});},'Email proposal created. Hive communication policy controls sending.');
}
export async function showEmail(id){
 const m=await api('/email/messages/'+encodeURIComponent(id)),c=m.content;
 openModal(c.subject||'Email',`<div class="detail-meta">${badge(m.status)}<span>${m.direction==='OUTBOUND'?'Outbound':'Inbound'}</span></div>${m.queueStatus?`<p class="notice amber">${esc(m.queueStatus.message)}</p>`:''}<p>From: ${esc((c.from||[]).join(', '))}</p><p>To: ${esc((c.to||[]).join(', '))}</p><p>Cc: ${esc((c.cc||[]).join(', '))}</p><p>Bcc: ${esc((c.bcc||[]).join(', '))}</p><p>Thread: ${esc(m.thread_id||'Not assigned')}</p>${m.error?`<p class="notice amber">${esc(m.error)}</p>`:''}<pre class="document-content">${esc(c.text||'No plain-text body.')}</pre>${c.html?`<details><summary>HTML source</summary><pre class="document-content">${esc(c.html)}</pre></details>`:''}${c.bodyTruncated?'<p class="notice amber">Body exceeds the local ingestion limit. The original remains in Gmail.</p>':''}${c.attachments?.length?`<h3>Attachments</h3>${c.attachments.map((a,i)=>`<p>${esc(a.filename)} / ${esc(a.mimeType)} / ${esc(a.size)} bytes ${a.sha256?`<button class="text-link" data-frozen-attachment="${i}" data-email-id="${esc(m.id)}" data-filename="${esc(a.filename)}">Download attachment</button>`:m.direction==='INBOUND'?'<span class="muted">Metadata only; no local file cached.</span>':''}</p>`).join('')}`:''}<h3>Business associations</h3>${m.links.map(l=>`<p>${esc(l.kind)}: ${esc(l.entity_id)} (${esc(l.source)})</p>`).join('')||'<p>No association recorded.</p>'}<div class="form-actions">${m.rfc_message_id?'<button id="email-reply">Reply</button>':''}${m.status==='UNCERTAIN'?'<button id="email-reconcile">Find original sent message</button>':''}</div>`,{wide:true});
 document.querySelector('#email-reply')?.addEventListener('click',()=>composeEmail(m));
 document.querySelector('#email-reconcile')?.addEventListener('click',async()=>{try{const result=await api('/email/messages/'+encodeURIComponent(id)+'/reconcile','POST',{});toast(result.resolved?'Original send confirmed.':'No unique original send found. No replacement was sent.');await showEmail(id);}catch(error){toast(error.message);}});
}
export function emailSettings(){
 const box=state.data.emailMailbox,people=state.data.emailPermissions||[];
 openModal('Email settings','<p><button data-action="email-connect">Reconnect Google Workspace</button></p>'+form(selectField('Mailbox polling and sending','enabled',[['false','Disabled'],['true','Enabled']],String(box?.enabled??false))+field('Daily send limit','dailySendLimit',String(box?.daily_send_limit??100),'number'),'Save settings')+`<h3>Employee permissions</h3>${people.map(p=>`<div class="release-file"><strong>${esc(p.name)}</strong><label><input type="checkbox" data-email-read="${esc(p.id)}" ${p.can_read?'checked':''}> Read business email</label><label><input type="checkbox" data-email-send="${esc(p.id)}" ${p.can_send?'checked':''}> Propose and send within communication policy</label><button data-save-email-permission="${esc(p.id)}">Save permissions</button></div>`).join('')}`);
 handleModal(async x=>api('/email/settings','POST',{enabled:x.enabled==='true',dailySendLimit:Number(x.dailySendLimit)}),'Email settings saved.');
 for(const b of document.querySelectorAll('[data-save-email-permission]'))b.onclick=async()=>{try{const id=b.dataset.saveEmailPermission;await api('/email/permissions/'+id,'PUT',{canRead:document.querySelector(`[data-email-read="${id}"]`).checked,canSend:document.querySelector(`[data-email-send="${id}"]`).checked});toast('Email permissions saved.');}catch(error){toast(error.message);}};
}

export function editBusinessEntity(existing){
 const kinds=['PROSPECT','CUSTOMER','CAMPAIGN','PROJECT','EXPERIMENT'];
 openModal(existing?'Edit business record':'Add business record',form(
   selectField('Record type','kind',(existing?[existing.kind]:kinds).map(k=>[k,k.charAt(0)+k.slice(1).toLowerCase()]),existing?.kind||'PROSPECT')
   +field('Name','label',existing?.label||'')
   +field('Email addresses','addresses',(existing?.addresses||[]).join(', '),'textarea','Separate addresses with commas. Leave blank until an address is known.'),'Save record'));
 const input=document.querySelector('[name=addresses]');input.required=false;input.closest('.field').querySelector('label small').textContent='Optional';
 const id=existing?.id||crypto.randomUUID();
 handleModal(x=>api('/email/entities','PUT',{id,kind:x.kind,label:x.label,addresses:addresses(x.addresses),expected:existing?{label:existing.label,addresses:existing.addresses}:null}),'Business record saved.');
}

document.addEventListener('click',async event=>{const button=event.target.closest('[data-frozen-attachment]');if(!button)return;button.disabled=true;try{await download('/email/messages/'+encodeURIComponent(button.dataset.emailId)+'/attachments/'+button.dataset.frozenAttachment,button.dataset.filename);}catch(error){toast(error.message);}finally{button.disabled=false;}});
