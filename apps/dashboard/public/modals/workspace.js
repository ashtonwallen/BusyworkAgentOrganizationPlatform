import {composeEmail} from '../pages/email.js';
import {api,toast} from '../lib/api.js';
import {esc} from '../lib/format.js';
import {openModal,form,field,handleModal} from '../lib/modal.js';
export async function showWorkspace(employeeId,scope='private'){
 try{
  const query=new URLSearchParams({employeeId,scope}),files=await api('/workspaces?'+query);
  openModal('Workspace files',`<div class="form-actions"><button id="workspace-private">Agent files</button><button id="workspace-shared">Shared files</button></div><p>${scope==='shared'?'Shared company files':"This agent\'s files"}</p>${files.length?files.map((f,i)=>`<button class="document-row" data-workspace-file="${i}"><strong>${esc(f.path)}</strong><small>${f.bytes.toLocaleString()} bytes</small></button>`).join(''):'<p>No files created yet.</p>'}`,{wide:true});
  document.querySelector('#workspace-private').onclick=()=>showWorkspace(employeeId,'private');document.querySelector('#workspace-shared').onclick=()=>showWorkspace(employeeId,'shared');
  for(const button of document.querySelectorAll('[data-workspace-file]'))button.onclick=async()=>{try{
   const path=files[Number(button.dataset.workspaceFile)].path,result=await api('/workspaces?'+new URLSearchParams({employeeId,scope,path}));
   openModal(path,`<pre class="document-content">${esc(result.content)}</pre><div class="form-actions"><button id="workspace-back">Back to files</button><button id="workspace-download">Download</button><button id="workspace-email">Email this file</button><button id="workspace-copy">Copy file</button></div>`,{wide:true});
   document.querySelector('#workspace-copy').onclick=()=>{openModal('Copy workspace file',`<p>Creates an exact copy. Shared files are readable by every employee. Existing files are preserved.</p>`+form(field('Destination (private/path or shared/path)','destination',(scope==='private'?'shared/':'private/')+path),'Copy file'));handleModal(x=>api('/workspaces/copy','POST',{employeeId,source:scope+'/'+path,destination:x.destination,sha256:result.sha256}),'File copied.');};
   document.querySelector('#workspace-email').onclick=()=>{let filename=path.split('/').at(-1);if(!/\.(txt|md|csv|json)$/i.test(filename))filename+='.txt';void composeEmail(undefined,{path:scope+'/'+path,employeeId,sha256:result.sha256,filename});};
   document.querySelector('#workspace-back').onclick=()=>showWorkspace(employeeId,scope);
   document.querySelector('#workspace-download').onclick=()=>{const url=URL.createObjectURL(new Blob([result.content],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=path.split('/').at(-1);a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  }catch(error){toast(error.message);}};
 }catch(error){toast(error.message);}
}
