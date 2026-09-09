import {z} from 'zod';
import {formatUsd,timestamp} from './contracts.js';
import {DomainError,type HiveService} from './service.js';
import type {Row} from './db.js';

export const exportRange=z.object({from:timestamp.optional(),to:timestamp.optional()}).strict().refine(x=>!x.from||!x.to||new Date(x.from)<new Date(x.to),'From must precede to');
function cell(value:unknown){
  let text=value==null?'':String(value);
  // Spreadsheet applications can evaluate quoted strings as formulas too.
  if(/^[\s]*[=+@-]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
export async function ledgerCsv(service:HiveService,range:unknown){
  const x=exportRange.parse(range);
  const rows=await service.db.query<Row>("SELECT * FROM ledger WHERE ($1::timestamptz IS NULL OR occurred_at >= $1) AND ($2::timestamptz IS NULL OR occurred_at < $2) ORDER BY occurred_at,id LIMIT 10001",[x.from??null,x.to??null]);
  if(rows.rows.length>10000)throw new DomainError('Export exceeds 10,000 entries. Choose a smaller date range.');
  const columns=['id','occurred_at_utc','account','kind','amount_usd','external_reference','task_id','experiment_id','description'];
  const lines=rows.rows.map(r=>[r.id,new Date(r.occurred_at).toISOString(),r.account,r.kind,formatUsd(r.amount),r.external_reference,r.task_id,r.experiment_id,r.description].map(cell).join(','));
  return [columns.join(','),...lines].join('\r\n')+'\r\n';
}
