import {z} from 'zod';
import {cacheTextAttachment} from './email-attachments.js';
import {simpleParser} from 'mailparser';
import {type EmailProvider,type ProviderEmail,type EmailPage,type EmailAttachment,EmailProviderError} from './email-provider.js';
const safeId=(id:string)=>{if(!/^[a-zA-Z0-9_-]{1,4096}$/.test(id))throw new EmailProviderError('INVALID_ID');return encodeURIComponent(id);};
const messageReference=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,4096}$/)});
const pageFields={nextPageToken:z.string().min(1).max(4096).optional()};
const messagePage=z.object({...pageFields,messages:z.array(messageReference).optional()});
const historyPage=z.object({...pageFields,historyId:z.string().regex(/^\d+$/).optional(),history:z.array(z.object({messagesAdded:z.array(z.object({message:messageReference})).optional()})).optional()});
function validPage<T>(schema:z.ZodType<T>,value:unknown):T{const parsed=schema.safeParse(value);if(!parsed.success)throw new EmailProviderError('INVALID_PAGE');return parsed.data;}
export class GmailEmailProvider implements EmailProvider {
 readonly name='gmail';
 constructor(private readonly accessToken:()=>Promise<string>,private readonly fetcher:typeof fetch=fetch){}
 private async request(path:string,method='GET',body?:unknown){
  const token=await this.accessToken();let response:Response;
  try{response=await this.fetcher('https://gmail.googleapis.com/gmail/v1/users/me'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new EmailProviderError('CONNECTION_FAILED',undefined,method==='POST');}
  if(!response.ok)throw new EmailProviderError(response.status===404?'NOT_FOUND':response.status===429?'RATE_LIMITED':response.status===401?'AUTH_REQUIRED':'HTTP_ERROR',response.status,method==='POST'&&![400,401,403,404,413,422,429].includes(response.status));
  const value=await response.text();if(value.length>12000000)throw new EmailProviderError('RESPONSE_TOO_LARGE',undefined,method==='POST');
  try{const parsed=JSON.parse(value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed;}catch{throw new EmailProviderError('INVALID_RESPONSE',undefined,method==='POST');}
 }
 async profile(){const p=await this.request('/profile');if(typeof p.emailAddress!=='string'||typeof p.historyId!=='string')throw new EmailProviderError('INVALID_PROFILE');return {emailAddress:p.emailAddress.toLowerCase(),historyId:p.historyId};}
 async send(raw:string,threadId?:string){const r=await this.request('/messages/send','POST',{raw,...(threadId?{threadId}:{})});if(typeof r.id!=='string'||typeof r.threadId!=='string')throw new EmailProviderError('MISSING_SEND_RECEIPT',undefined,true);return {providerMessageId:r.id,threadId:r.threadId};}
 async list(pageToken?:string):Promise<EmailPage>{const q=new URLSearchParams({maxResults:'50',q:'-in:chats -in:drafts',...(pageToken?{pageToken}:{})});const r=validPage(messagePage,await this.request('/messages?'+q));return {messageIds:(r.messages??[]).map(m=>m.id),nextPageToken:r.nextPageToken};}
 async changes(historyId:string,pageToken?:string):Promise<EmailPage>{const q=new URLSearchParams({startHistoryId:historyId,historyTypes:'messageAdded',maxResults:'100',...(pageToken?{pageToken}:{})});const r=validPage(historyPage,await this.request('/history?'+q));return {messageIds:[...new Set<string>((r.history??[]).flatMap(h=>(h.messagesAdded??[]).map(m=>m.message.id)))],nextPageToken:r.nextPageToken,historyId:r.historyId};}
 async findSent(messageIdHeader:string){if(!/^<[^<>\s]+>$/.test(messageIdHeader))throw new EmailProviderError('INVALID_MESSAGE_ID');const r=validPage(messagePage,await this.request('/messages?'+new URLSearchParams({q:'in:sent rfc822msgid:'+messageIdHeader.slice(1,-1),maxResults:'10'})));return (r.messages??[]).map(m=>m.id);}
 async get(messageId:string):Promise<ProviderEmail|null>{
  let r:any;try{r=await this.request('/messages/'+safeId(messageId)+'?format=full');}catch(error){if(error instanceof EmailProviderError&&error.status===404)return null;throw error;}
  if(!r.id||!r.threadId||!r.payload||!/^\d+$/.test(String(r.internalDate)))throw new EmailProviderError('INVALID_MESSAGE');
  if((r.labelIds??[]).includes('DRAFT'))return null;
  const headers:Record<string,string>={};for(const h of r.payload.headers??[])if(typeof h.name==='string'&&typeof h.value==='string')headers[h.name.toLowerCase()]=h.value;
  const parsed=await simpleParser(Object.entries(headers).filter(([name])=>['from','to','cc','bcc','reply-to','subject','message-id','in-reply-to','references'].includes(name)).map(([k,v])=>k+': '+v.replace(/[\r\n]+/g,' ')).join('\r\n')+'\r\n\r\n',{skipHtmlToText:true,skipTextToHtml:true});
  const addresses=(value:any):string[]=>!value?[]:(Array.isArray(value)?value:[value]).flatMap(v=>(v.value??[]).map((a:any)=>String(a.address??'')).filter(Boolean));
  let text='',html='',bodyTruncated=false,cachedFiles=0;const attachments:EmailAttachment[]=[];
  const walk=async(part:any,depth=0):Promise<void>=>{
   if(depth>30){bodyTruncated=true;return;}
   const type=String(part.mimeType??'');const body=part.body??{};
   if(part.filename||(!['text/plain','text/html'].includes(type)&&body.attachmentId)){
    const attachment:EmailAttachment={filename:String(part.filename??''),mimeType:type,size:Number(body.size??0),providerAttachmentId:body.attachmentId,partId:part.partId,contentId:(part.headers??[]).find((h:any)=>h.name?.toLowerCase()==='content-id')?.value};
    if(!(r.labelIds??[]).includes('SENT')&&cachedFiles<5&&attachments.length<100){
      Object.assign(attachment,await cacheTextAttachment(attachment,async()=>{cachedFiles++;return body.data??(body.attachmentId?(await this.request('/messages/'+safeId(messageId)+'/attachments/'+safeId(body.attachmentId))).data:body.size===0?'':undefined);}));
    }else attachment.textCacheStatus='NOT_CACHED';
    attachments.push(attachment);
   }
   else if(['text/plain','text/html'].includes(type)){
    let data=body.data;
    if(!data&&body.attachmentId&&Number(body.size)<=1000000)data=(await this.request('/messages/'+safeId(messageId)+'/attachments/'+safeId(body.attachmentId))).data;
    if(data){const bytes=Buffer.from(data,'base64url');const contentType=(part.headers??[]).find((h:any)=>h.name?.toLowerCase()==='content-type')?.value??'';const charset=/charset=["']?([^;"'\s]+)/i.exec(contentType)?.[1]??'utf-8';let decoded:string;try{decoded=new TextDecoder(charset).decode(bytes);}catch{decoded=bytes.toString('utf8');}if(type==='text/plain')text+=decoded;else html+=decoded;}
    else if(Number(body.size)>0)bodyTruncated=true;
   }
   for(const child of part.parts??[])await walk(child,depth+1);
  };await walk(r.payload);
  if(text.length>2000000||html.length>2000000)bodyTruncated=true;
  return {providerMessageId:String(r.id),threadId:String(r.threadId),direction:(r.labelIds??[]).includes('SENT')?'OUTBOUND':'INBOUND',from:addresses(parsed.from),to:addresses(parsed.to),cc:addresses(parsed.cc),bcc:addresses(parsed.bcc),replyTo:addresses(parsed.replyTo),subject:parsed.subject??'',text:text.slice(0,2000000),html:html.slice(0,2000000),receivedAt:new Date(Number(r.internalDate)).toISOString(),headers,attachments,bodyTruncated};
 }
}
