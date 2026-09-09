import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';

it('loads historical task details with exact holds, delegated allocations and complete totals',async()=>{
  const db=await openDatabase();const service=new HiveService(db,createModels({}));
  const app=buildApp({service,ownerToken:'detail-fixture-token',logger:false});
  try{
    const {id}=await service.createTask({objective:'Historical detail fixture',budgetUsd:'1',tokenBudget:1000000,ttlMinutes:1440});
    await service.createTask({parentId:id,objective:'Child allocation',budgetUsd:'0.30',tokenBudget:10000,ttlMinutes:60});
    await db.query(`INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,settled,token_reserved,input_tokens,output_tokens,budget_day)
      SELECT 'detail-call-'||n,$1,'WORK',n,'mock-worker','mock',false,'SUCCEEDED',1000,1000,20,10,10,CURRENT_DATE FROM generate_series(1,120) n`,[id]);
    await db.query(`INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,token_reserved,budget_day)
      VALUES('held-detail',$1,'WORK',121,'mock-worker','mock',false,'UNCERTAIN',50000,5000,CURRENT_DATE)`,[id]);
    await db.query(`INSERT INTO meetings(id,title,objective,organizer_id,participants,scheduled_at,budget,source_task_id,token_budget)
      VALUES('detail-meeting','Scheduled work','Fixture','owner','[]',now()+interval '1 hour',200000,$1,20000)`,[id]);
    await db.query(`INSERT INTO tasks(id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id)
      SELECT 'newer-'||n,'newer-'||n,'Newer task','worker',0,'PLAN_PENDING',0,1000,now()+interval '1 day','mock-worker','mock-reviewer' FROM generate_series(1,210) n`);
    expect((await service.snapshot()).tasks.some(t=>t.id===id)).toBe(false);
    expect((await app.inject({url:`/v1/tasks/${id}`})).statusCode).toBe(401);
    const response=await app.inject({url:`/v1/tasks/${id}`,headers:{authorization:'Bearer detail-fixture-token'}});
    expect(response.statusCode).toBe(200);const record=response.json();
    expect(record.task).toMatchObject({budgetUsd:'1.000000',spentUsd:'0.120000',reservedUsd:'0.050000'});
    expect(record.allocation).toMatchObject({delegatedUsd:'0.300000',scheduledMeetingsUsd:'0.200000',remainingUsd:'0.330000',usedOrHeldTokens:7400,remainingTokens:962600});
    expect(record.counts.calls).toBe(121);expect(record.calls).toHaveLength(100);expect(record.children).toHaveLength(1);
  }finally{await app.close();await db.close();}
});
