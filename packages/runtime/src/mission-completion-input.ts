import {z} from 'zod';
export const completionReference=z.object({kind:z.enum(['TASK','DOCUMENT','ACTION','SOURCE']),id:z.string().min(1).max(250),version:z.number().int().positive().optional()}).strict();
export const completionInput=z.object({conditions:z.array(z.object({conditionIndex:z.number().int().min(0),evidence:z.array(completionReference).min(1).max(20)}).strict()).max(20),
 deliverable:z.object({path:z.string().min(1).max(250),version:z.number().int().positive()}).strict()}).strict();
