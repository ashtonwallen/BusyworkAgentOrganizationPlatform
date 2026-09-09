import {releaseLibrary} from './releases.js';
import { state, employeeName } from '../lib/state.js';
import { esc, ago } from '../lib/format.js';
import { api, toast, download } from '../lib/api.js';
import { ctx } from '../lib/context.js';
import { pageTitle, card, empty, button } from '../lib/ui.js';
import { openModal, form, field, handleModal } from '../lib/modal.js';

export function documents() {
 const rows=state.documentResults ?? state.data.documents ?? [];
 const folders=Map.groupBy(rows,d=>d.path.includes('/')?d.path.slice(0,d.path.lastIndexOf('/')):'Root');
 return pageTitle('Documents','Shared working documents, decisions, and handoffs. Edits preserve version history.',button('New document','new-document','plus',true))
 +card('Document library',`<div class="card-body"><form id="document-search" class="document-search"><label for="document-query">Search paths and titles</label><div><input id="document-query" name="query" value="${esc(state.documentQuery || '')}" maxlength="250" placeholder="Search documents"><button type="submit">Search</button></div></form>
 ${rows.length?[...folders].map(([folder,docs])=>`<section class="document-folder"><h3>${esc(folder)}</h3>${docs.map(d=>`<button class="document-row" data-document="${esc(d.path)}"><span><strong>${esc(d.title)}</strong><small>${esc(d.path)}</small></span><span>v${d.version}<small>${esc(employeeName(d.updated_by))} · ${ago(d.updated_at)}</small></span></button>`).join('')}</section>`).join(''):empty('No documents found','Create a document using a folder path such as operations/process.md. Agents can create and maintain their own documents.','','work')}
 <p class="section-note">${rows.length} documents shown. Search the full library for other documents. Shared internally with all employees.</p></div>`)+releaseLibrary();
}
let searchTimer,searchSequence=0;
export async function searchDocuments(query) {
 clearTimeout(searchTimer);query=String(query||'');const sequence=++searchSequence;
 state.documentQuery=query;
 const rows=await api('/documents?search='+encodeURIComponent(query));
 if(sequence!==searchSequence||state.documentQuery!==query)return;
 state.documentResults=rows;
 if(state.page!=='documents')return;
 const input=document.querySelector('#document-query'),focused=document.activeElement===input;
 const start=input?.selectionStart,end=input?.selectionEnd;
 ctx.renderPage();
 if(focused){const replacement=document.querySelector('#document-query');replacement?.focus({preventScroll:true});replacement?.setSelectionRange(start,end);}
}
document.addEventListener('input',event=>{
 if(event.target.id!=='document-query')return;
 const query=event.target.value;state.documentQuery=query;searchSequence++;clearTimeout(searchTimer);
 searchTimer=setTimeout(()=>{void searchDocuments(query).catch(error=>{if(state.page==='documents'&&state.documentQuery===query)toast(error.message);});},250);
});

export async function showDocument(path,version) {
 const doc=await api('/documents/read?path='+encodeURIComponent(path)+(version?'&version='+version:''));
 const versions=await api('/documents/versions?path='+encodeURIComponent(path));
 openModal(doc.title,`<p class="muted">${esc(doc.path)} &middot; Version ${doc.version} of ${doc.current_version} · ${esc(employeeName(doc.author_id))}</p>
 <div class="document-actions"><button class="primary" data-document-edit="${esc(path)}">Edit latest</button><button data-document-download="${esc(path)}" data-version="${doc.version}">Download this version</button><button data-document-pdf="${esc(path)}" data-version="${doc.version}">Download PDF</button></div>
 <pre class="document-content">${esc(doc.content)}</pre>
 <details><summary>Version history (${versions.length})</summary>${versions.map(v=>`<button class="document-row" data-document="${esc(path)}" data-version="${v.version}"><span>Version ${v.version} · ${esc(v.title)}</span><small>${esc(employeeName(v.author_id))} · ${ago(v.created_at)}</small></button>`).join('')}</details>`,{wide:true});
}
export async function editDocument(path) {
 const doc=path?await api('/documents/read?path='+encodeURIComponent(path)):null;
 openModal(doc?'Edit document':'New document',form(
 (doc?`<p class="muted">${esc(doc.path)} ? Editing version ${doc.version}</p>`:field('Path','path','', 'text','Use folders, for example operations/process.md.'))
 +field('Title','title',doc?.title || '')+field('Content','content',doc?.content || '', 'textarea','Plain text or Markdown. Maximum 12,000 characters per document. Do not store passwords or API keys.')
 ,'Save version'),{wide:true});
 document.querySelector('[name=content]').maxLength=12000;
 handleModal(async x=>{await api('/documents','PUT',{path:doc?.path || x.path,title:x.title,content:x.content,expectedVersion:doc?.version || 0});state.documentResults=undefined;state.documentQuery='';},'Document version saved.');
}
export async function downloadDocument(path,version) {
 const doc=await api('/documents/read?path='+encodeURIComponent(path)+(version?'&version='+version:''));
 const url=URL.createObjectURL(new Blob([doc.content],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=path.split('/').pop();link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Download ready.');
}

document.addEventListener('click',async event=>{const button=event.target.closest('[data-document-pdf]');if(!button)return;button.disabled=true;try{const path=button.dataset.documentPdf;await download('/documents/export.pdf?path='+encodeURIComponent(path)+'&version='+button.dataset.version,path.split('/').pop().replace(/\.[^.]+$/,'')+'.pdf');}catch(error){toast(error.message);}finally{button.disabled=false;}});
