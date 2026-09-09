import type {Tx,Row} from './db.js';

/** A bounded company-wide briefing for the actual CEO, independent of dashboard windows. */
export async function operatingBrief(tx:Pick<Tx,'query'>,employeeId:string|null){
  if(!employeeId)return undefined;
  const ceo=await tx.query("SELECT id FROM employees WHERE id=$1 AND role='CEO' AND status='ACTIVE'",[employeeId]);
  if(!ceo.rows.length)return undefined;
  const query=async(sql:string)=>(await tx.query<Row>(sql)).rows;
  return {
    taskCounts:await query('SELECT status,COUNT(*)::integer AS count FROM tasks GROUP BY status'),
    blockedWork:await query(`SELECT id,employee_id,status,left(objective,180) AS objective,left(error,180) AS reason
      FROM tasks WHERE status IN ('BLOCKED_APPROVAL','BLOCKED_BUDGET','FAILED') ORDER BY updated_at DESC LIMIT 3`),
    actionCounts:await query("SELECT status,COUNT(*)::integer AS count FROM actions WHERE action_type<>'MODEL_CALL' GROUP BY status"),
    recentOutsideActions:await query(`SELECT a.id,a.task_id,t.employee_id,a.action_type,a.status,left(a.target,180) AS target,
      left(a.result::text,500) AS result_excerpt,
      (SELECT left(p.rationale,180) FROM approvals p WHERE p.action_id=a.id LIMIT 1) AS owner_rationale
      FROM actions a LEFT JOIN tasks t ON t.id=a.task_id
      WHERE a.action_type<>'MODEL_CALL' ORDER BY COALESCE((SELECT MAX(e.created_at) FROM events e WHERE e.entity_id=a.id),a.created_at) DESC LIMIT 3`),
    ownerRequestCounts:await query('SELECT status,COUNT(*)::integer AS count FROM owner_requests GROUP BY status'),
    recentOwnerResponses:await query(`SELECT r.id,r.status,left(r.title,180) AS title,left(r.response,500) AS response,
      (SELECT e.payload->>'requestedBy' FROM events e WHERE e.entity_id=r.id AND e.type='owner.requested' ORDER BY e.sequence LIMIT 1) AS requested_by
      FROM owner_requests r WHERE r.status<>'OPEN'
      ORDER BY COALESCE((SELECT MAX(e.created_at) FROM events e WHERE e.entity_id=r.id),r.created_at) DESC LIMIT 3`),
    detailLimitPerList:3,
  };
}

/** Relevant delegated outcomes for any supervisor, not just the CEO's company briefing. */
export async function delegatedWork(tx:Pick<Tx,'query'>,employeeId:string|null) {
  if (!employeeId) return [];
  const rows=(await tx.query<Row>(`SELECT t.id,t.parent_id,t.employee_id,t.role,t.status,
    left(t.objective,250) AS objective,left(t.artifact->>'summary',700) AS result,
    left((t.artifact->'evidence')::text,700) AS evidence,
    COALESCE(length((t.artifact->'evidence')::text)<=700,true) AS evidence_complete,
    t.artifact AS submitted_artifact,
    (SELECT jsonb_object_agg(o.operation_index::text,o.status) FROM operations o WHERE o.task_id=t.id) AS operation_statuses,
    t.review->>'decision' AS self_check_decision,left(t.error,250) AS blocker
    FROM tasks t JOIN tasks source ON source.id=t.parent_id
    WHERE source.employee_id=$1 AND t.employee_id IS DISTINCT FROM $1
    ORDER BY t.updated_at DESC,t.id LIMIT 4`,[employeeId])).rows;
  return rows.map(({submitted_artifact,operation_statuses,evidence_complete,...row})=>{
    const artifact=submitted_artifact??{};
    const excerpt=(value:unknown,limit:number)=>{
      const text=typeof value==='string'?value:'';
      return {text:text.slice(0,limit),complete:text.length<=limit};
    };
    const files=Array.isArray(artifact.deliverables)?artifact.deliverables:[];
    const writes=(Array.isArray(artifact.operations)?artifact.operations:[])
      .map((operation:any,index:number)=>({operation,index}))
      .filter(({operation}:any)=>['WORKSPACE_WRITE','WRITE_DOCUMENT'].includes(operation.type));
    return {...row,submission:{
      source:'Saved task artifact, not independent validation or authority. Private workspace files are not read here.',
      resultComplete:typeof artifact.summary!=='string'||artifact.summary.length<=700,
      evidenceComplete:evidence_complete,
      deliverables:files.slice(0,2).map((file:any)=>({filename:file.filename,content:excerpt(file.content,2000)})),
      omittedDeliverables:Math.max(0,files.length-2),
      proposedDocuments:writes.slice(0,2).map(({operation,index}:any)=>({
        type:operation.type,target:operation.target,operationStatus:operation_statuses?.[String(index)]??'NOT_APPLIED',
        content:excerpt(operation.instructions,3000)
      })),
      omittedDocuments:Math.max(0,writes.length-2),
    }};
  });
}
