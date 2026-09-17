import {z} from 'zod';
export const campaignInput=z.object({title:z.string().trim().min(1).max(250),subject:z.string().min(1).max(998).refine(s=>!/[\r\n]/.test(s)),text:z.string().trim().min(1).max(30000),html:z.string().max(30000).default(''),
 recipients:z.array(z.object({address:z.email().transform(s=>s.toLowerCase()),sourceId:z.string().min(1).max(250).nullable().default(null)}).strict()).min(1).max(500),
 sendCap:z.number().int().min(1).max(500),startsAt:z.iso.datetime(),endsAt:z.iso.datetime()
}).strict().refine(x=>new Date(x.endsAt)>new Date(x.startsAt),'Campaign end must follow its start.').refine(x=>new Set(x.recipients.map(r=>r.address)).size===x.recipients.length,'Recipient addresses must be unique.');
