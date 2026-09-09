import {one,type Tx,type Row} from './db.js';

/** Shared coordination metadata only: no task text, messages, prompts or private files. */
export async function staffDirectory(tx:Pick<Tx,'query'>,actor:string,search:string,before:string|null=null) {
 await one(tx,"SELECT id FROM employees WHERE id=$1 AND status='ACTIVE'",[actor]);
 const rows=(await tx.query<Row>(`
  SELECT e.id,e.name,e.role,e.department_id,d.name AS department,e.manager_id,e.model_id,
   assignments.*,calls.*
  FROM employees e LEFT JOIN departments d ON d.id=e.department_id
  CROSS JOIN LATERAL (
   SELECT count(*) FILTER (WHERE t.status NOT IN ('COMPLETED','FAILED','EXPIRED','CANCELLED'))::integer AS active_assignments,
    count(*) FILTER (WHERE t.status IN ('BLOCKED_BUDGET','BLOCKED_APPROVAL'))::integer AS blocked_assignments,
    count(*) FILTER (WHERE t.status='COMPLETED' AND NOT t.operations_applied)::integer AS awaiting_operation_processing
   FROM tasks t WHERE t.employee_id=e.id
  ) assignments
  CROSS JOIN LATERAL (
   SELECT count(*)::integer AS unresolved_calls,
    count(*) FILTER (WHERE c.status IN ('RESERVED','DISPATCHED'))::integer AS active_calls,
    count(*) FILTER (WHERE c.status='UNCERTAIN')::integer AS uncertain_calls
   FROM calls c JOIN tasks t ON t.id=c.task_id
   WHERE t.employee_id=e.id AND c.status IN ('RESERVED','DISPATCHED','UNCERTAIN')
  ) calls
  WHERE e.status='ACTIVE'
   AND ($1='*' OR strpos(lower(concat_ws(' ',e.id,e.name,e.role,d.name)),lower($1))>0)
   AND ($2::text IS NULL OR e.id>$2)
  ORDER BY e.id LIMIT 21`,[search,before])).rows;
 return {
  employees:rows.slice(0,20),nextBefore:rows.length>20?rows[19]!.id:null,
  note:'Shared active staff metadata. Blocked assignments are included in active assignments. Active calls include reserved and dispatched calls; uncertain calls require reconciliation and are not proof that the employee is still working. Workload counts are observations, not availability guarantees or permission to assign outside your reporting chain. Use REQUEST_REPLY or MESSAGE for collaboration across departments; private work results require their existing access rules.',
 };
}
