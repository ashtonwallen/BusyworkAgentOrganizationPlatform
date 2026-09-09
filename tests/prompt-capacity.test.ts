import {it,expect} from 'vitest';
import {fitPrompt,fitRemainingAllocation,estimatedInputTokens} from '../packages/runtime/src/prompt-capacity.js';
const request={model:'fixture',correlationId:'fixture',system:'Respect the owner constraints.',input:{companyRecords:[{body:'Only execute approved actions.'}],plan:{understanding:'Current assignment'},artifact:{summary:'Preserve this work.'}},outputSchema:{type:'object'},maxOutputTokens:3000};
it('reduces answer capacity while retaining all required context and the original request',()=>{
 const result=fitRemainingAllocation(request,16000,1500)!;
 expect(result).not.toBeNull();expect(result.request.maxOutputTokens).toBeLessThan(3000);
 expect(result.inputLimit+result.request.maxOutputTokens!).toBe(1500);
 expect(estimatedInputTokens(result.request)).toBeLessThanOrEqual(result.inputLimit);
 expect(result.request.input).toEqual(request.input);expect(result.request.outputSchema).toEqual(request.outputSchema);
 expect(request.maxOutputTokens).toBe(3000);
});
it('preserves output capacity where optional history can be dropped',()=>{
 const large={...request,input:{...request.input,messages:[{body:'x'.repeat(30000)}]}};
 const result=fitRemainingAllocation(large,16000,4000)!;
 expect(result.request.maxOutputTokens).toBe(3000);expect(result.inputLimit).toBe(1000);
 expect((result.request.input as any).omittedContext.messages).toBe(1);
 expect((result.request.input as any).companyRecords).toEqual(request.input.companyRecords);
});
it('never cuts mandatory records to manufacture an affordable prompt',()=>{
 expect(fitRemainingAllocation({...request,input:{...request.input,companyRecords:[{body:'x'.repeat(30000)}]}},16000,4000)).toBeNull();
 expect(fitRemainingAllocation(request,16000,0)).toBeNull();
});

it('trims retrievable order and backlog previews while keeping the active read and required instructions',()=>{
 const input={...request.input,internalRead:{request:{type:'BACKLOG',target:'current'},result:{content:'Current precise fulfillment requirements.'}},customerOrders:Array.from({length:30},(_,i)=>({id:'order-'+i,title:'Recorded order '.repeat(30)})),workBacklog:Array.from({length:50},(_,i)=>({id:'plan-'+i,payload:{instructions:'Preview '.repeat(100)}}))};
 const large={...request,input},fitted=fitPrompt(large,1800),context=fitted.input as any;
 expect(estimatedInputTokens(large)).toBeGreaterThan(16000);expect(estimatedInputTokens(fitted)).toBeLessThanOrEqual(1800);expect(context.omittedContext.customerOrders).toBeGreaterThan(0);expect(context.omittedContext.workBacklog).toBeGreaterThan(0);expect(context.contextRetrieval.customerOrders).toContain('ORDER_FIND');expect(context.contextRetrieval.workBacklog).toContain('BACKLOG');
 expect(context.internalRead).toEqual(input.internalRead);expect(context.companyRecords).toEqual(input.companyRecords);expect(context.plan).toEqual(input.plan);expect(context.artifact).toEqual(input.artifact);expect(fitted.system).toBe(request.system);expect(fitted.outputSchema).toEqual(request.outputSchema);expect(input.workBacklog).toHaveLength(50);
});
