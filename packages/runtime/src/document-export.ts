import {chromium} from 'playwright';
import {DomainError} from './service.js';

const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const inline=(value:string)=>escape(value).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
/** Small, text-only Markdown subset. Raw HTML, links and images cannot load resources. */
export function documentHtml(title:string,content:string){
 const lines=content.replace(/\r\n/g,'\n').split('\n');let code=false,list='';const body:string[]=[];
 const closeList=()=>{if(list){body.push(`</${list}>`);list='';}};
 for(const line of lines){
  if(/^```/.test(line)){closeList();body.push(code?'</code></pre>':'<pre><code>');code=!code;continue;}
  if(code){body.push(escape(line)+'\n');continue;}
  const heading=/^(#{1,6})\s+(.+)$/.exec(line),item=/^\s*(?:([-*])|\d+[.)])\s+(.+)$/.exec(line);
  if(item){const kind=item[1]?'ul':'ol';if(list!==kind){closeList();list=kind;body.push(`<${list}>`);}body.push(`<li>${inline(item[2]!).replace(/^\[ \] /,'&#9744; ').replace(/^\[[xX]\] /,'&#9745; ')}</li>`);continue;}
  closeList();if(heading){const level=heading[1]!.length;body.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);}else if(line.trim())body.push(`<p>${inline(line)}</p>`);
 }
 closeList();if(code)body.push('</code></pre>');
 return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>
 @page{size:A4;margin:20mm 18mm}body{font:11pt/1.5 Arial,sans-serif;color:#17212b}h1{font-size:23pt}h2{font-size:17pt}h3{font-size:13pt}h1,h2,h3,h4,h5,h6{break-after:avoid;line-height:1.25;margin:18pt 0 8pt}p{margin:7pt 0;overflow-wrap:anywhere}li{margin:5pt 0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f7;padding:10pt;font-size:9pt}code{font-family:Consolas,monospace}ul,ol{padding-left:22pt}header{border-bottom:1px solid #ccd3da;margin-bottom:18pt;padding-bottom:9pt;font-size:19pt;font-weight:bold}p,li{orphans:3;widows:3}
 </style></head><body><header>${escape(title)}</header>${body.join('\n')}</body></html>`;
}
let active=0;
export async function documentPdf(title:string,content:string):Promise<Buffer>{
 if(title.length>250||content.length>12000)throw new DomainError('Document exceeds PDF export limits.');
 if(active>=2)throw new DomainError('PDF renderer is busy. Retry shortly.');
 active++;let browser;let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  browser=await chromium.launch({headless:true,timeout:15000});
  const context=await browser.newContext({javaScriptEnabled:false,offline:true,serviceWorkers:'block',acceptDownloads:false});
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage();await page.setContent(documentHtml(title,content),{waitUntil:'domcontentloaded',timeout:15000});
  return await Promise.race([page.pdf({format:'A4',printBackground:true,displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:'<div style="font-size:9px;width:100%;text-align:center;color:#64748b"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',margin:{top:'20mm',bottom:'20mm',left:'18mm',right:'18mm'}}),new Promise<Buffer>((_,reject)=>{timer=setTimeout(()=>reject(new Error('PDF rendering timed out.')),15000);})]);
 }catch{throw new DomainError('PDF export failed. Check that the local browser is installed and retry.');}
 finally{if(timer)clearTimeout(timer);try{await browser?.close();}finally{active--;}}
}
