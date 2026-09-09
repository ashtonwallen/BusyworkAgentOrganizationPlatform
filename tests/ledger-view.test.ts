import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';
it('pages full-history ledger, groups model charges exactly and opens individual calls',async()=>{
 const db=await openDatabase();const service=new HiveService(db,createModels({}));
 const app=buildApp({service,ownerToken:'ledger-fixture',logger:false});const headers={authorization:'Bearer ledger-fixture'};
 try{
  await db.query(`INSERT INTO tasks(id,root_id,objective,role,depth,status,budget,token_budget,expires_at,model_id,review_model_id) VALUES('task','task','fixture','Worker',0,'COMPLETED',10000000,10000,now(),'model','model')`);
  await db.query(`INSERT INTO calls(id,task_id,phase,attempt,model_id,provider,is_live,status,reserved,settled,token_reserved,budget_day) SELECT 'call-'||n,'task','WORK',n,'model','fixture',true,'SUCCEEDED',0,50000,1,current_date FROM generate_series(1,203) n`);
  await db.query(`INSERT INTO ledger(id,idempotency_key,account,kind,amount,description,call_id,occurred_at) SELECT 'entry-'||n,'entry-'||n,'OPERATING','COST',50000,'Model charge','call-'||n,'2026-09-09T12:00:00Z' FROM generate_series(1,203) n`);
  await db.query(`INSERT INTO ledger(id,idempotency_key,account,kind,amount,description,occurred_at) VALUES('twilio','twilio','BUSINESS','COST',20000000,'Twilio SMS','2026-09-01'),('zero','zero','BUSINESS','COST',0,'No charge','2026-09-01')`);
  const get=async(q='')=>{const r=await app.inject({method:'GET',url:'/v1/ledger/view'+q,headers});expect(r.statusCode,r.body).toBe(200);return r.json();};
  const all=await get();expect(all.rows).toHaveLength(2);expect(all.rows[0]).toMatchObject({calls:203,amount:'10150000'});expect(all.rows[1].description).toBe('Twilio SMS');
  expect((await get('?category=business')).rows).toHaveLength(1);
  expect((await get('?showZero=true')).rows).toHaveLength(3);
  expect((await get('?search=TWILIO')).rows[0].id).toBe('twilio');
  const first=await get('?model=model&day=2026-09-09');const second=await get('?model=model&day=2026-09-09&offset=50');expect(first.rows).toHaveLength(50);expect(first.hasMore).toBe(true);expect(new Set([...first.rows,...second.rows].map(x=>x.id)).size).toBe(100);
  expect((await app.inject({method:'GET',url:'/v1/ledger/view'})).statusCode).toBe(401);
 }finally{await app.close();await db.close();}
});
