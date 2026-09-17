import {z} from 'zod';
export const documentClaims=z.array(z.object({text:z.string().trim().min(1).max(2000),kind:z.enum(['OBSERVATION','INFERENCE','HYPOTHESIS']),sourceIds:z.array(z.string().min(1).max(100)).max(10)}).strict()
 .refine(claim=>claim.kind!=='OBSERVATION'||claim.sourceIds.length>0,'An observation requires a recorded source. Label uncited claims INFERENCE or HYPOTHESIS.')).max(30);
