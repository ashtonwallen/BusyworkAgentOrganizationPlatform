import {it,expect,vi} from 'vitest';
import {HttpProvider} from '../packages/providers/src/http.js';
const request={model:'fixture-model',input:{objective:'Return fixture'},correlationId:'fixture',maxOutputTokens:100,outputSchema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}};
it('requires nested properties for OpenAI strict schemas without mutating the approved request',async()=>{
  let sent:any;
  const provider=new HttpProvider({kind:'openai',apiKey:'fixture',fetch:async(_url,options)=>{
    sent=JSON.parse(String(options?.body));
    return new Response(JSON.stringify({model:'fixture',usage:{input_tokens:1,output_tokens:1},output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}]}));
  }});
  const schema={type:'object',properties:{items:{type:'array',default:[],items:{type:'object',properties:{name:{type:'string'}},additionalProperties:false}}},additionalProperties:false};
  await provider.generate({...request,outputSchema:schema});
  expect(sent.text.format.schema.required).toEqual(['items']);
  expect(sent.text.format.schema.properties.items.items.required).toEqual(['name']);
  expect(sent.text.format.schema.properties.items.default).toBeUndefined();
  expect(schema.properties.items.default).toEqual([]);
});
it.each([
  ['openai',{id:'r1',model:'actual',usage:{input_tokens:11,output_tokens:7},output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}]},'https://api.openai.com/v1/responses'],
  ['anthropic',{id:'r1',model:'actual',usage:{input_tokens:11,output_tokens:7},content:[{type:'tool_use',name:'submit_result',input:{ok:true}}]},'https://api.anthropic.com/v1/messages'],
  ['gemini',{responseId:'r1',modelVersion:'actual',usageMetadata:{promptTokenCount:11,candidatesTokenCount:4,thoughtsTokenCount:3},candidates:[{content:{parts:[{text:'private reasoning',thought:true},{text:'{"ok":true}'}]}}]},'https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent'],
  ['lmstudio',{id:'r1',model:'actual',usage:{prompt_tokens:11,completion_tokens:7},choices:[{message:{content:'{"ok":true}'}}]},'http://127.0.0.1:1234/v1/chat/completions'],
] as const)('normalizes %s results and bounds each request without retrying',async(kind,response,url)=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(response),{status:200}));
  const provider=new HttpProvider({kind,apiKey:'fixture-secret',fetch:fetcher as typeof fetch});const result=await provider.generate(request);
  expect(result.output).toEqual({ok:true});expect(result.usage).toEqual({inputTokens:11,outputTokens:7});expect(result.rawModelId).toBe('actual');expect(result.providerRequestId).toBe('r1');
  const args=fetcher.mock.calls[0] as unknown as [string,RequestInit];expect(args[0]).toBe(url);expect(args[1].redirect).toBe('error');expect(args[1].body).not.toContain('fixture-secret');expect(fetcher).toHaveBeenCalledTimes(1);
});
it('retains usage for malformed model output so validation cannot erase costs',async()=>{
  const provider=new HttpProvider({kind:'lmstudio',apiKey:'',fetch:async()=>new Response(JSON.stringify({usage:{prompt_tokens:20,completion_tokens:30},choices:[{message:{content:'not JSON'}}]}))});
  const result=await provider.generate(request);expect(result.output).toBe('not JSON');expect(result.usage.outputTokens).toBe(30);
});
it('treats network failures as uncertain without leaking credentials or response bodies',async()=>{
  const fetcher=vi.fn(async()=>{throw new Error('fixture-secret private response');});const provider=new HttpProvider({kind:'openai',apiKey:'fixture-secret',fetch:fetcher as typeof fetch});
  await expect(provider.generate(request)).rejects.toMatchObject({definitelyNotCharged:false,message:expect.not.stringContaining('fixture-secret')});expect(fetcher).toHaveBeenCalledTimes(1);
});
it('requires explicit private LAN opt-in and rejects remote endpoint overrides',()=>{
  expect(()=>new HttpProvider({kind:'lmstudio',apiKey:'',baseUrl:'http://192.168.1.20:1234/v1'})).toThrow('explicitly');
  expect(()=>new HttpProvider({kind:'lmstudio',apiKey:'',baseUrl:'http://192.168.1.20:1234/v1',allowLan:true})).not.toThrow();
  expect(()=>new HttpProvider({kind:'openai',apiKey:'',baseUrl:'https://example.com'})).toThrow('fixed');
  expect(()=>new HttpProvider({kind:'lmstudio',apiKey:'',baseUrl:'http://user:secret@localhost:1234/v1'})).toThrow('credentials');
});

it.each([
 ['openai',{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:11,output_tokens:100},output:[{type:'message',content:[{type:'output_text',text:'{"ok":'}]}]}],
 ['anthropic',{stop_reason:'max_tokens',usage:{input_tokens:11,output_tokens:100},content:[]}],
 ['gemini',{usageMetadata:{promptTokenCount:11,candidatesTokenCount:100},candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{"ok":'}]}}]}],
 ['lmstudio',{usage:{prompt_tokens:11,completion_tokens:100},choices:[{finish_reason:'length',message:{content:'{"ok":'}}]}],
] as const)('preserves truncation and billable usage for %s',async(kind,raw)=>{
 const provider=new HttpProvider({kind,apiKey:'fixture',fetch:async()=>new Response(JSON.stringify(raw))});
 const result=await provider.generate(request);expect(result.truncated).toBe(true);expect(result.usage).toEqual({inputTokens:11,outputTokens:100});
});

 it('accepts real email work schemas and preserves optional reply semantics',async()=>{
  const {artifactSchema,jsonSchema}=await import('../packages/runtime/src/contracts.js');
  const {emailDraftSchema}=await import('../packages/runtime/src/email-provider.js');
  let sent:any;
  const provider=new HttpProvider({kind:'openai',apiKey:'fixture',fetch:async(_url,options)=>{
    sent=JSON.parse(String(options?.body));
    return new Response(JSON.stringify({usage:{input_tokens:1,output_tokens:1},output:[]}));
  }});
  await provider.generate({...request,outputSchema:jsonSchema(artifactSchema)});
  const email=sent.text.format.schema.properties.operations.items.properties.email.anyOf[0];
  expect(email.properties.to.items.format).toBe('email');
  expect(email.properties.to.items.pattern).toBeUndefined();
  expect(email.properties.replyTo.anyOf).toContainEqual({type:'null'});
  expect(email.properties.replyToMessageId.anyOf).toContainEqual({type:'null'});
  const draft=emailDraftSchema.parse({to:['reader@example.com'],subject:'Test',text:'Hello',replyTo:null,replyToMessageId:null});
  expect(draft.replyTo).toBeUndefined();expect(draft.replyToMessageId).toBeUndefined();
  expect(emailDraftSchema.safeParse({...draft,to:['bad..address@example.com']}).success).toBe(false);
 });
 it('explains schema rejection without exposing the provider error body',async()=>{
  const provider=new HttpProvider({kind:'openai',apiKey:'fixture',fetch:async()=>new Response(JSON.stringify({error:{code:'invalid_json_schema',message:'private input fixture-secret'}}),{status:400})});
  await expect(provider.generate(request)).rejects.toMatchObject({definitelyNotCharged:true,message:'Provider returned HTTP 400. The structured response schema was rejected.'});
 });

it('exposes exact money syntax in generated schemas and preserves unknown optional estimates',async()=>{
 const {usd,artifactSchema,jsonSchema}=await import('../packages/runtime/src/contracts.js');
 const {parseUsd}=await import('../packages/core/src/index.js');
 const schema=jsonSchema(usd) as any;expect(schema.pattern).toBeDefined();
 for(const value of ['0','12.50','0.000001','999999999999.999999']){expect(new RegExp(schema.pattern).test(value)).toBe(true);expect(usd.parse(value)).toBe(value);expect(parseUsd(value)).toBeTypeOf('bigint');}
 for(const value of ['$12.50','12 USD','unknown','0.0000001','-1','1,000','']){expect(new RegExp(schema.pattern).test(value)).toBe(false);expect(usd.safeParse(value).success).toBe(false);expect(()=>parseUsd(value)).toThrow();}
 const optional=artifactSchema.shape.estimatedTestCostUsd;expect(optional.parse(null)).toBeNull();expect(optional.safeParse('unknown').success).toBe(false);
 expect((jsonSchema(artifactSchema) as any).properties.estimatedTestCostUsd.anyOf).toContainEqual({type:'null'});
});
