import type {Tx,Row} from './db.js';
const facts=(name:string)=>`jsonb_build_array(${name}.payload->'customerId',${name}.payload->'scope',${name}.payload->'priceUsd',${name}.payload->'dueAt',COALESCE(${name}.payload->'documentRefs','[]'::jsonb),${name}.payload->>'stage'='CANCELLED')`;
/** Same exclusion is used before dispatch LIMIT and in owner queue explanations. */
export const staleOrderEmailsSql=`SELECT link.entity_id AS email_id FROM events link
 LEFT JOIN LATERAL (SELECT payload FROM events WHERE type='order.updated' AND entity_id=link.payload->>'orderId' AND payload->>'version'=link.payload->>'orderVersion' ORDER BY sequence DESC LIMIT 1) original ON true
 LEFT JOIN LATERAL (SELECT payload FROM events WHERE type='order.updated' AND entity_id=link.payload->>'orderId' ORDER BY sequence DESC LIMIT 1) current_order ON true
 WHERE link.type='order.email_proposed' AND (original.payload IS NULL OR current_order.payload IS NULL OR ${facts('original')} IS DISTINCT FROM ${facts('current_order')})`;
export async function staleOrderEmails(tx:Pick<Tx,'query'>){return new Set((await tx.query<Row>(staleOrderEmailsSql)).rows.map(r=>r.email_id));}
