import { esc } from './format.js';

// Text-only Markdown subset: all user content is escaped before adding our own tags.
// Raw HTML, embedded media and link targets are intentionally rendered as text.
function inline(text) {
  return String(text).split(/(`[^`\n]+`)/g).map(part=>{
    if(part.startsWith('`')&&part.endsWith('`'))return '<code>'+esc(part.slice(1,-1))+'</code>';
    return esc(part).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_\n]+)__/g,'<strong>$1</strong>').replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,!?]|$)/g,'$1<em>$2</em>');
  }).join('');
}
export function messageMarkdown(value) {
  const lines=String(value??'').replace(/\r\n?/g,'\n').split('\n');
  const out=[];let paragraph=[],list=[],listKind='',code=null;
  const flushParagraph=()=>{if(paragraph.length){out.push('<p>'+paragraph.map(inline).join('<br>')+'</p>');paragraph=[];}};
  const flushList=()=>{if(list.length){out.push('<'+listKind+'>'+list.map(t=>'<li>'+inline(t)+'</li>').join('')+'</'+listKind+'>');list=[];listKind='';}};
  for(const line of lines){
    if(/^\s*```/.test(line)){flushParagraph();flushList();if(code===null)code=[];else{out.push('<pre><code>'+esc(code.join('\n'))+'</code></pre>');code=null;}continue;}
    if(code!==null){code.push(line);continue;}
    if(!line.trim()){flushParagraph();flushList();continue;}
    const heading=line.match(/^#{1,6}\s+(.+)$/),item=line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/);
    if(heading){flushParagraph();flushList();out.push('<h4>'+inline(heading[1])+'</h4>');}
    else if(item){flushParagraph();const kind=item[1]?'ul':'ol';if(listKind&&listKind!==kind)flushList();listKind=kind;list.push(item[2]);}
    else{flushList();paragraph.push(line);}
  }
  flushParagraph();flushList();if(code!==null)out.push('<pre><code>'+esc(code.join('\n'))+'</code></pre>');
  return out.join('');
}
