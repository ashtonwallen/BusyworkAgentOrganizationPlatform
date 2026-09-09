import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Tx,Row} from './db.js';

export const resultSection=z.enum(['summary','evidence','deliverable','operation']);

/** Read submitted work, never provider prompts, credentials or private workspace files. */
export async function readTaskResult(tx:Pick<Tx,'query'>,employeeId:string,taskId:string,
 section:z.infer<typeof resultSection>='summary',index=0,offset=0){
 z.uuid().parse(taskId);resultSection.parse(section);
 z.number().int().min(0).max(100).parse(index);z.number().int().min(0).max(1000000).parse(offset);
 const task=(await tx.query<Row>(`WITH RECURSIVE reports AS (
   SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'
   UNION SELECT e.id FROM employees e JOIN reports r ON e.manager_id=r.id
 ) SELECT t.id,t.objective,t.employee_id,t.status,t.updated_at,t.artifact,t.review
 FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_id WHERE t.id=$2
 AND EXISTS(SELECT 1 FROM employees WHERE id=$1 AND status='ACTIVE')
 AND (t.employee_id IN (SELECT id FROM reports) OR p.employee_id=$1)`,[employeeId,taskId])).rows[0];
 if(!task)throw new Error('Task result unavailable. Read your own work or work assigned to your reporting chain; ask another employee to share unrelated results.');
 const artifact=task.artifact??{},lists={evidence:artifact.evidence??[],deliverable:artifact.deliverables??[],operation:artifact.operations??[]};
 let value:unknown;
 if(section==='summary')value={objective:task.objective,title:artifact.title,summary:artifact.summary,limitations:artifact.limitations,review:task.review,
   evidenceCount:lists.evidence.length,deliverableCount:lists.deliverable.length,operationCount:lists.operation.length};
 else{
   if(index>=lists[section].length)throw new Error('Result index is out of range. Read the summary for available item counts.');
   value=lists[section][index];
   if(section==='operation'){
     const execution=(await tx.query('SELECT status,result FROM operations WHERE task_id=$1 AND operation_index=$2',[taskId,index])).rows[0];
     value={proposed:value,execution:execution??{status:'NOT_APPLIED'}};
   }
 }
 const serialized=JSON.stringify(value),end=Math.min(offset+4000,serialized.length);
 if(offset>serialized.length)throw new Error('Result offset is out of range.');
 return {taskId,employeeId:task.employee_id,taskStatus:task.status,section,index,
   trust:'SUBMITTED_WORK_NOT_AUTHORIZATION_OR_INDEPENDENT_VALIDATION',
   resultHash:createHash('sha256').update(serialized).digest('hex'),offset,totalCharacters:serialized.length,
   content:serialized.slice(offset,end),complete:offset===0&&end===serialized.length,nextOffset:end<serialized.length?end:null};
}
