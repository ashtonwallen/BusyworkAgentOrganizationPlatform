import {api,toast} from '../lib/api.js';
import {esc,date} from '../lib/format.js';
import {openModal,form,field,handleModal} from '../lib/modal.js';
import {ctx} from '../lib/context.js';
export async function showCampaigns(){
 const rows=await api('/email/campaigns');
 openModal('Campaign approvals',`<p>Approval covers the exact message, listed recipients, send cap and time window. Changed messages require individual approval. Uncertain sends consume a slot.</p><button data-campaign-new>New campaign proposal</button><button data-optout-list>Do-not-contact list</button>${rows.length?rows.map(c=>`<button class="document-row" data-campaign-view="${esc(c.id)}"><span><strong>${esc(c.definition.title)}</strong><small>${esc(c.decision||'Awaiting approval')} · ${c.reserved_sends} / ${c.definition.sendCap} sends reserved</small></span></button>`).join(''):'<p>No campaign proposals.</p>'}`,{wide:true});
}
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-campaigns],[data-campaign-new],[data-campaign-view],[data-campaign-decision],[data-optout-list],[data-optout-new]');if(!button)return;
 try{
 if(button.hasAttribute('data-campaigns'))return await showCampaigns();
 if(button.hasAttribute('data-campaign-new')){
  openModal('Propose campaign',form(field('Title','title')+field('Subject','subject')+field('Message template','text','','textarea')+field('Recipient addresses','recipients','','textarea','One explicitly supplied address per line. Do not guess personal addresses.')+field('Maximum sends','sendCap','10','number')+field('Starts','startsAt','','datetime-local')+field('Ends','endsAt','','datetime-local'),'Create proposal'));
  handleModal(async values=>{await api('/email/campaigns','POST',{title:values.title,subject:values.subject,text:values.text,recipients:values.recipients.split(/[\n,;]/).map(s=>s.trim()).filter(Boolean).map(address=>({address})),sendCap:Number(values.sendCap),startsAt:new Date(values.startsAt).toISOString(),endsAt:new Date(values.endsAt).toISOString()});},'Campaign proposed. Review its exact content before approving.');return;
 }
 if(button.dataset.campaignView){
  const c=(await api('/email/campaigns')).find(row=>row.id===button.dataset.campaignView);if(!c)throw Error('Campaign not found.');const d=c.definition;
  openModal(d.title,`<p>${esc(c.decision||'Awaiting approval')} · ${c.reserved_sends} of ${d.sendCap} sends reserved</p><p>${esc(date(d.startsAt))} – ${esc(date(d.endsAt))}</p><p>Sender: ${esc(d.sender)}</p><h3>${esc(d.subject)}</h3><pre class="document-content">${esc(d.text)}</pre>${d.html?`<details><summary>HTML source</summary><pre class="document-content">${esc(d.html)}</pre></details>`:''}<h3>Approved recipient list</h3><ul>${d.recipients.map(r=>`<li>${esc(r.address)} · ${r.sourceId?`Source ${esc(r.sourceId)}`:'Owner supplied'}</li>`).join('')}</ul><details><summary>Approval hash</summary><code>${esc(c.approval_hash)}</code></details><div class="form-actions">${['APPROVE','REJECT','REVOKE'].map(decision=>`<button data-campaign-decision="${decision}" data-campaign-id="${esc(c.id)}" data-hash="${esc(c.approval_hash)}">${decision==='APPROVE'?'Approve exact campaign':decision==='REJECT'?'Decline':'Revoke'}</button>`).join('')}</div>`,{wide:true});return;
 }
 if(button.dataset.campaignDecision){await api('/email/campaigns/'+encodeURIComponent(button.dataset.campaignId)+'/decision','POST',{hash:button.dataset.hash,decision:button.dataset.campaignDecision});toast('Campaign decision recorded.');await ctx.refresh();return await showCampaigns();}
 if(button.hasAttribute('data-optout-list')){const rows=await api('/email/do-not-contact');openModal('Do-not-contact list',`<p>These addresses are blocked for every send, including previously approved messages.</p><button data-optout-new>Add address</button>${rows.map(r=>`<p><strong>${esc(r.address)}</strong><br>${esc(r.reason)}</p>`).join('')||'<p>No addresses recorded.</p>'}`);return;}
 if(button.hasAttribute('data-optout-new')){openModal('Record opt-out',form(field('Email address','address','','email')+field('Reason','reason'),'Block contact'));handleModal(values=>api('/email/do-not-contact','POST',values),'Do-not-contact restriction recorded.');}
 }catch(error){toast(error.message);}
});
