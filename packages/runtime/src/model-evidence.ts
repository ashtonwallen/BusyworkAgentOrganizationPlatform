import type { Row, Tx } from './db.js';

/** Latest terminal task outcomes, attributed to the task's primary worker, not its reviewer.
 * These are operational observations, not controlled model benchmarks or revenue evidence.
 */
export async function modelOutcomes(tx: Pick<Tx, 'query'>) {
  return (await tx.query<Row>(`SELECT model_id,
    COUNT(*)::integer AS terminal_tasks,
    COUNT(*) FILTER(WHERE status='COMPLETED')::integer AS completed_tasks,
    COUNT(*) FILTER(WHERE status='FAILED')::integer AS failed_tasks,
    COUNT(*) FILTER(WHERE status='EXPIRED')::integer AS expired_tasks,
    COUNT(*) FILTER(WHERE review->>'decision' IN ('PASS','REVISE','BLOCK'))::integer AS reviewed_tasks,
    COUNT(*) FILTER(WHERE status='COMPLETED' AND review->>'decision'='PASS')::integer AS review_passed_tasks
    FROM tasks WHERE status IN ('COMPLETED','FAILED','EXPIRED')
    AND NOT EXISTS(SELECT 1 FROM events WHERE entity_id=tasks.id AND type='model.test_requested') GROUP BY model_id`)).rows;
}
