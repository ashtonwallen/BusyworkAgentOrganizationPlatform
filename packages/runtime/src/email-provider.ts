import {z} from 'zod';
import {instanceSettings} from './instance-settings.js';
export const businessMailbox=instanceSettings.mailbox;
const address=z.email().max(254).refine(v=>!/[\r\n]/.test(v));
export const emailDraftSchema=z.object({
 to:z.array(address).max(50).default([]),cc:z.array(address).max(50).default([]),bcc:z.array(address).max(50).default([]),
 subject:z.string().min(1).max(998).refine(v=>!/[\r\n]/.test(v)),text:z.string().max(500000).default(''),html:z.string().max(500000).default(''),replyTo:address.nullish().transform(v=>v??undefined),
 documentAttachments:z.array(z.object({path:z.string().min(1).max(250),version:z.number().int().positive(),filename:z.string().max(150).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(txt|md|csv|json|pdf)$/i)}).strict()).max(5).default([]),
 workspaceAttachments:z.array(z.object({path:z.string().min(1).max(250),employeeId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/),filename:z.string().max(150).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(txt|md|csv|json)$/i)}).strict()).max(5).default([]),
 replyToMessageId:z.uuid().nullish().transform(v=>v??undefined),
 links:z.array(z.object({kind:z.enum(['CAMPAIGN','PROSPECT','CUSTOMER','PROJECT','EXPERIMENT']),id:z.string().min(1).max(250)}).strict()).max(20).default([])
}).strict().refine(x=>x.documentAttachments.length+x.workspaceAttachments.length<=5,'Use at most five attachments.').refine(x=>x.to.length+x.cc.length+x.bcc.length>0&&x.to.length+x.cc.length+x.bcc.length<=50,'Choose between 1 and 50 recipients.').refine(x=>!!(x.text.trim()||x.html.trim()),'Email needs a plain-text or HTML body.');
export type EmailDraft=z.infer<typeof emailDraftSchema>;
export interface EmailAttachment {textContent?:string;sha256?:string;textCacheStatus?:string;filename:string;mimeType:string;size:number;providerAttachmentId?:string;partId?:string;contentId?:string;}
export interface ProviderEmail {providerMessageId:string;threadId:string;direction:'INBOUND'|'OUTBOUND';from:string[];to:string[];cc:string[];bcc:string[];replyTo:string[];subject:string;text:string;html:string;receivedAt:string;headers:Record<string,string>;attachments:EmailAttachment[];bodyTruncated:boolean;}
export interface EmailPage {messageIds:string[];nextPageToken?:string;historyId?:string;}
export interface EmailProvider {
 readonly name:string;
 profile():Promise<{emailAddress:string;historyId:string}>;
 send(raw:string,threadId?:string):Promise<{providerMessageId:string;threadId:string}>;
 list(pageToken?:string):Promise<EmailPage>;
 changes(historyId:string,pageToken?:string):Promise<EmailPage>;
 get(messageId:string):Promise<ProviderEmail|null>;
 findSent(messageIdHeader:string):Promise<string[]>;
}
export class EmailProviderError extends Error {
 constructor(readonly code:string,readonly status?:number,readonly uncertain=false){super(`Email provider: ${code}${status?` (HTTP ${status})`:''}.`);}
}
