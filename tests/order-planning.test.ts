import {it,expect} from 'vitest';
import {orderPlanningContext,orderRegister} from '../packages/runtime/src/orders.js';

it('keeps older overdue commitments visible and counts the full open register without changing stored data',()=>{
 const now=new Date('2026-09-09T12:00:00Z');
 const register=Array.from({length:35},(_,i)=>({id:String(i).padStart(2,'0'),title:'Order '+i,customerId:'buyer',customer:'Buyer',stage:'INTAKE',employeeId:'worker',experimentId:null,dueAt:null,priceMicroUsd:'1000000',receivedMicroUsd:'0',refundedMicroUsd:'0',netReceivedMicroUsd:'0',paymentState:'UNPAID',version:1,updatedAt:new Date(now.getTime()-i*1000).toISOString()})) as Awaited<ReturnType<typeof orderRegister>>;
 Object.assign(register[34]!,{dueAt:'2026-09-08T12:00:00Z',employeeId:null,stage:'READY'});
 Object.assign(register[33]!,{dueAt:'2026-09-09T12:00:00Z'});
 Object.assign(register[32]!,{dueAt:'2026-09-10T12:00:00Z'});
 Object.assign(register[31]!,{dueAt:'2026-09-10T12:00:01Z'});
 Object.assign(register[0]!,{dueAt:'2026-09-01T12:00:00Z',stage:'CLOSED'});
 Object.assign(register[1]!,{dueAt:'2026-09-01T12:00:00Z',stage:'CANCELLED'});
 const original=JSON.stringify(register),result=orderPlanningContext(register,now);
 expect(result.summary).toMatchObject({open:33,overdue:1,dueWithin24Hours:2,unassigned:1,omitted:3,asOf:now.toISOString()});
 expect(result.orders).toHaveLength(30);
 expect(result.orders.slice(0,4).map(order=>[order.id,order.dueState])).toEqual([['34','OVERDUE'],['33','DUE_WITHIN_24_HOURS'],['32','DUE_WITHIN_24_HOURS'],['31','UPCOMING']]);
 expect(result.orders.some(order=>['00','01'].includes(order.id))).toBe(false);
 expect(result.orders[4]!.dueState).toBe('NO_DUE_DATE');
 expect(JSON.stringify(register)).toBe(original);
 expect(orderPlanningContext([],now).summary).toMatchObject({open:0,overdue:0,dueWithin24Hours:0,unassigned:0,omitted:0});
});
