import { it, expect } from 'vitest';
import { openDatabase, HiveService, createModels, Worker } from '../packages/runtime/src/index.js';

it('counts full-history work outcomes separately from call success and incomplete settlement', async () => {
  const db = await openDatabase();
  try {
    const service = new HiveService(db, createModels({}));
    const task = await service.createTask({objective:'Offline evidence fixture',modelId:'mock-worker',reviewModelId:'mock-reviewer'});
    await db.query(`INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,settled,token_reserved,budget_day,usage)
      SELECT 'history-'||n,$1,'WORK',n,'mock-worker','mock',false,'SUCCEEDED',0,0,100,CURRENT_DATE,'{"latencyMs":250}'::jsonb FROM generate_series(1,120) n`,[task.id]);
    await db.query(`INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,token_reserved,budget_day)
      VALUES('uncertain',$1,'WORK',121,'mock-worker','mock',false,'UNCERTAIN',0,100,CURRENT_DATE)`,[task.id]);
    await db.query(`UPDATE tasks SET status='FAILED',review='{"decision":"BLOCK"}'::jsonb WHERE id=$1`,[task.id]);
    await db.query(`INSERT INTO tasks(id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id,review)
      SELECT 'task-'||n,'task-'||n,'Older reviewed fixture','worker',0,'COMPLETED',0,1000,now()+interval '1 day','mock-worker','mock-reviewer','{"decision":"PASS"}'::jsonb FROM generate_series(1,210) n`);
    const snapshot=await service.snapshot();
    expect(snapshot.calls).toHaveLength(100);
    expect(snapshot.tasks).toHaveLength(200);
    expect(snapshot.modelStats.find(s=>s.model_id==='mock-worker')).toMatchObject({total:121,succeeded:120,unsettled:1,latency_ms:250});
    expect(snapshot.modelOutcomes).toEqual([expect.objectContaining({model_id:'mock-worker',terminal_tasks:211,completed_tasks:210,failed_tasks:1,reviewed_tasks:211,review_passed_tasks:210})]);
    // Retrying removes a provisional outcome until it reaches another terminal state.
    await db.query("UPDATE tasks SET status='READY',finished_at=NULL WHERE id=$1",[task.id]);
    expect((await service.snapshot()).modelOutcomes[0]?.terminal_tasks).toBe(210);
  } finally { await db.close(); }
});

it('gives choosing agents outcome evidence without prescribing role models', async () => {
  const db=await openDatabase();
  try {
    const models=createModels({});
    let captured:any;
    const adapter=models[0]!.adapter;
    models[0]!.adapter={...adapter,providerId:adapter.providerId,listModels:()=>adapter.listModels(),generate:async request=>{captured=request;return adapter.generate(request);}};
    const service=new HiveService(db,models);
    await service.createTask({objective:'Choose a worker for a bounded commercial test',modelId:'mock-worker',reviewModelId:'mock-reviewer'});
    await service.setStatus('RUNNING'); await new Worker(service).runNext();
    expect(captured.input.configuredModels.find((m:any)=>m.id==='mock-worker').outcomes).toBeNull();
    expect(captured.system).toContain('not a controlled benchmark');
    expect(captured.system).toContain('The owner selects the CEO model');
    expect(captured.system).toContain('paid choice still needs normal spending approval');
  } finally { await db.close(); }
});
