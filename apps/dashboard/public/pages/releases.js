import {state} from '../lib/state.js';
import {api} from '../lib/api.js';
import {esc,ago,micro} from '../lib/format.js';
import {card,button,empty} from '../lib/ui.js';
import {openModal,form,field,handleModal,selectField} from '../lib/modal.js';
export function releaseLibrary(){
 const rows=state.data.staticReleases||[];
 return card('Publishing releases',`<div class="card-body"><p class="section-note">Frozen file versions prepared for publishing review. Preparing a release does not publish it.</p>${button('Prepare release','prepare-release','plus',false)}${rows.length?rows.map(r=>`<button class="document-row" data-release="${esc(r.id)}"><span><strong>${esc(r.title)}</strong><small>${r.source_versions.length} files / Netlify / ${esc(r.site_id)}</small></span><span>${ago(r.created_at)}<small>Prepared</small></span></button>`).join(''):empty('No releases prepared','Select working documents to preserve an exact set of site files.','','work')}</div>`)+deploymentLibrary();
}
export async function prepareRelease(){
 const documents=await api('/documents');const selected=documents.filter(d=>/\.(html|css|js|txt|json|svg|xml|webmanifest)$/i.test(d.path));
 if(!selected.length){openModal('Prepare release','<p>Create your static site files in Documents first, including index.html.</p>');return;}
 const requestId=crypto.randomUUID();
 openModal('Prepare publishing release',form(field('Release title','title')+field('Netlify site ID','siteId','','text','The existing destination site UUID. This step does not create or contact a site.')+
 '<p>Select source documents and set their published paths. Each selected version is frozen into the release.</p>'+selected.map((d,i)=>`<div class="release-file"><label><input type="checkbox" data-release-source="${i}"> ${esc(d.path)} (v${d.version})</label><label for="release-path-${i}">Published path</label><input id="release-path-${i}" value="${esc(d.path.split('/').pop())}" disabled></div>`).join(''),'Prepare release'),{wide:true});
 document.querySelector('[name=siteId]').pattern='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
 for(const checkbox of document.querySelectorAll('[data-release-source]'))checkbox.onchange=()=>{const path=document.querySelector('#release-path-'+checkbox.dataset.releaseSource);path.disabled=!checkbox.checked;path.required=checkbox.checked;};
 handleModal(async x=>{
 const files=[...document.querySelectorAll('[data-release-source]:checked')].map(c=>{const index=Number(c.dataset.releaseSource);return {path:document.querySelector('#release-path-'+index).value.trim(),documentPath:selected[index].path,version:selected[index].version};});
 if(!files.length)throw new Error('Select at least one file, including index.html.');
 await api('/releases','POST',{requestId,title:x.title,siteId:x.siteId,files});
 },'Release prepared. Nothing was published.');
}
export async function showRelease(id){
 const r=await api('/releases/'+encodeURIComponent(id));
 openModal(r.title,`<p>Prepared release. No publication is implied.</p><dl class="release-metadata"><dt>Provider</dt><dd>${esc(r.provider)}</dd><dt>Site ID</dt><dd>${esc(r.site_id)}</dd><dt>Content hash (SHA-256)</dt><dd>${esc(r.content_hash)}</dd></dl>
 ${r.manifest.files.map(file=>{const source=r.source_versions.find(s=>s.path===file.path);return `<details class="release-content"><summary>${esc(file.path)}</summary><p class="muted">${esc(source?.documentPath||'')} / Version ${source?.version||''}</p><pre class="document-content">${esc(file.content)}</pre></details>`;}).join('')}<p class="section-note">Working-document edits do not change this release. A deployment still requires its own authorization and executable integration.</p><button id="propose-release" class="primary">Propose publication</button>`,{wide:true});
 document.querySelector('#propose-release').onclick=()=>proposeRelease(r);
}

function proposeRelease(r){
 const automatic=state.data.hosting?.ready && state.data.hosting.siteId===r.site_id;
 openModal('Propose publication',form(`<p>Publish ${esc(r.title)} to the production site ${esc(r.site_id)}.</p><p class="section-note">Frozen content: ${esc(r.content_hash)}</p><p class="notice amber">This creates an approval request. Owner-assisted execution requires you to publish the files. Automatic execution uploads the frozen files after approval. Enter the maximum charge, including applicable hosting costs; automatic execution requires the configured maximum.</p>`+selectField('Execution','executionMode',automatic?[['OWNER_ASSISTED','Owner-assisted'],['NETLIFY_AUTOMATIC','Automatic after approval']]:[['OWNER_ASSISTED','Owner-assisted']])+field('Purpose','rationale','','textarea')+field('Maximum charge (USD)','maxCostUsd',automatic?state.data.hosting.maxDeploymentUsd:'')+field('Approval valid for (hours)','hours','24','number'),'Create proposal'));
 handleModal(async x=>{await api('/actions','POST',{actionType:'PUBLISH',target:r.site_id,payload:{releaseId:r.id,executionMode:x.executionMode,description:`Publish frozen release: ${r.title}`},rationale:x.rationale,maxCostUsd:x.maxCostUsd,expiresAt:new Date(Date.now()+Number(x.hours)*3600000).toISOString()});},'Publication proposal created. Nothing was published.');
}

function deploymentLibrary(){
 const setup=state.data.hosting;
 const setupInfo=setup?`<details><summary>Hosting setup: ${setup.ready?'Ready':setup.enabled?'Incomplete':'Disabled'}</summary><p>Netlify / ${esc(setup.siteId||'No site configured')}</p><p>Maximum per deployment: ${esc(setup.maxDeploymentUsd??'Not set')} USD / Lifetime cap: ${esc(setup.totalCapUsd??'Not set')} USD</p><p>Configure HIVE_NETLIFY_ENABLED, HIVE_NETLIFY_TOKEN, HIVE_NETLIFY_SITE_ID, HIVE_NETLIFY_MAX_DEPLOY_USD and HIVE_NETLIFY_TOTAL_CAP_USD in the server environment, then restart. Credentials remain on the server. Each release requires approval.</p></details>`:'';
 const rows=state.data.deployments||[];
 return card('Deployments',`<div class="card-body">${setupInfo}${rows.length?rows.map(d=>`<button class="document-row" data-deployment="${esc(d.action_id)}"><span><strong>${esc(d.title)}</strong><small>${esc(d.status)} / ${esc(d.site_id)}</small></span><span>${d.settled===null?'Cost awaiting reconciliation':micro(d.settled)}</span></button>`).join(''):empty('No deployments','Prepared releases appear above. Deployment progress and final costs will be recorded here.','','work')}</div>`);
}
export async function showDeployment(id){
 const d=await api('/deployments/'+encodeURIComponent(id));
 const canSettle=d.settled===null&&['READY','FAILED'].includes(d.status);
 openModal('Deployment',`<h3>${esc(d.title)}</h3><p>Status: ${esc(d.status)}</p><p>Site: ${esc(d.site_id)}</p><p>Provider deployment: ${esc(d.provider_id||'Not confirmed')}</p><p>Approved maximum: ${micro(d.max_cost)} / Reserved: ${micro(d.reservation)}</p><p>${d.settled===null?'Final cost has not been confirmed.':`Reconciled cost: ${micro(d.settled)}`}</p>${d.error?`<p class="notice amber">${esc(d.error)}</p>`:''}<button data-release="${esc(d.release_id)}">Review frozen files</button>${canSettle?form('<p class="notice amber">Record the final charge from a receipt, including an explicit zero when confirmed. This permanent entry cannot be edited. A failed deployment remains failed.</p>'+field('Final cost (USD)','actualCostUsd')+field('Receipt or reference','externalReference')+field('Accounting note','resultNote','','textarea'),'Review settlement'):''}`);
 if(canSettle)handleModal(async x=>{
  openModal('Confirm deployment cost',form(`<p>Record $${Number(x.actualCostUsd).toFixed(2)} for ${esc(d.title)}.</p><p>Reference: ${esc(x.externalReference)}</p><p>${esc(x.resultNote)}</p><p class="notice amber">This permanently records the cost and releases the remaining reservation. Charges above the approved maximum pause the company.</p>`,'Record final cost'));
  handleModal(async()=>{await api('/deployments/'+encodeURIComponent(id)+'/reconcile-cost','POST',x);},'Deployment cost reconciled.');return false;
 });
}
