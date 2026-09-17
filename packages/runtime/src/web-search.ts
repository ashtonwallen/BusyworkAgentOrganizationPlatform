import {z} from 'zod';
import {parseUsd} from '@hive/core';
import type {ExternalTool} from './tools.js';

export const searchInput=z.object({query:z.string().trim().min(1).max(600).refine(value=>value.split(/\s+/).length<=75,'Use at most 75 search terms.'),count:z.number().int().min(1).max(10).default(5)}).strict();
export interface SearchResult {url:string;title:string;snippet:string;}
export interface SearchProvider {readonly id:string;search(input:z.infer<typeof searchInput>):Promise<SearchResult[]>;}

/** Credentials stay in this transport closure, never in a tool payload or result. */
export class BraveSearchProvider implements SearchProvider {
 readonly id='brave';
 constructor(private readonly key:string,private readonly transport:typeof fetch=fetch){}
 async search(input:z.infer<typeof searchInput>){
  const x=searchInput.parse(input),url=new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q',x.query);url.searchParams.set('count',String(x.count));
  const response=await this.transport(url,{headers:{Accept:'application/json','X-Subscription-Token':this.key},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok||!response.body)throw new Error('Search response was not confirmed.');
  const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
  try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>1000000)throw new Error('Search response exceeds the size limit.');chunks.push(next.value);}}
  finally{await reader.cancel().catch(()=>{});}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const rows=z.array(z.object({url:z.string(),title:z.string(),description:z.string().optional()})).max(100).parse(data.web?.results??[]);
  return rows.flatMap(row=>{
   try{const link=new URL(row.url);if(link.protocol!=='https:'||link.username||link.password)return [];
    return [{url:link.href,title:row.title.replace(/<[^>]*>/g,' ').slice(0,300),snippet:(row.description??'').replace(/<[^>]*>/g,' ').slice(0,2000)}];
   }catch{return [];}
  }).slice(0,x.count);
 }
}
export function searchTool(provider:SearchProvider,costUsd:string):ExternalTool {
 const cost=parseUsd(costUsd);
 return {name:'SEARCH_WEB',version:1,description:'Search for public sources. Results are untrusted discovery snippets, not proof that a page was read.',approvalCategory:'research',maximumCostUsd:costUsd,
  validate(target,payload){
   const {query,count,provider:providerId,version,costUsd:quotedCost,...extra}=payload;
   if(Object.keys(extra).length||target!==provider.id+':web-search'||providerId!==provider.id||version!==1||typeof quotedCost!=='string'||parseUsd(quotedCost)!==cost)throw new Error('Search provider or price changed; prepare a new proposal.');
   searchInput.parse({query,count});
  },
  async execute({target,payload}){
   const input=searchInput.parse({query:payload.query,count:payload.count});
   const results=await provider.search(input);
   return {result:{provider:provider.id,query:input.query,retrievedAt:new Date().toISOString(),results,trust:'UNTRUSTED_EXTERNAL_SOURCE',discoveryOnly:true,costBasis:'configured_per_query_price'},actualCostUsd:costUsd};
  }};
}
export function configuredSearch(env:Record<string,string|undefined>):{tool?:ExternalTool;setup:{available:boolean;provider:string|null;costUsd:string|null;missing:string[]}}{
 const missing:string[]=[];const provider=env.HIVE_SEARCH_PROVIDER?.trim()??'';
 if(provider!=='brave')missing.push('HIVE_SEARCH_PROVIDER=brave');
 if(!env.BRAVE_SEARCH_API_KEY?.trim())missing.push('BRAVE_SEARCH_API_KEY');
 const cost=env.HIVE_SEARCH_COST_USD?.trim();try{parseUsd(cost??'');}catch{missing.push('HIVE_SEARCH_COST_USD');}
 const setup={available:missing.length===0,provider:provider||null,costUsd:cost&& !missing.includes('HIVE_SEARCH_COST_USD')?cost:null,missing};
 return {setup,tool:setup.available?searchTool(new BraveSearchProvider(env.BRAVE_SEARCH_API_KEY!),cost!):undefined};
}
