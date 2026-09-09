import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels} from '../packages/runtime/src/index.js';
import {ownerEffort} from '../packages/runtime/src/owner-effort.js';
it('summarizes all recorded resolved request minutes without inventing cash expenses',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));const opportunity=await service.createExperiment({title:'Small test',hypothesis:'Untested',customer:'Buyer',offer:'Checklist',channel:'Email',price:'20',maxLossUsd:'0',successCriteria:'Paid sale',killCriteria:'Deadline',deadline:new Date(Date.now()+86400000).toISOString()});
  await db.query("INSERT INTO owner_requests(id,title,details,status,minutes,experiment_id) SELECT 'time-'||n,'Request','Fixture','DONE',1,$1 FROM generate_series(1,205)n",[opportunity.id]);
  await db.query("INSERT INTO owner_requests(id,title,details,status,minutes) VALUES('declined','Request','Fixture','DECLINED',3),('zero','Request','Fixture','DONE',0),('open','Request','Fixture','OPEN',100)");
  const result=await ownerEffort(db);expect(result.minutes).toBe(208);expect(result.resolvedRequests).toBe(207);expect(result.requestsWithTime).toBe(206);expect(result.byOpportunity).toContainEqual({experimentId:opportunity.id,minutes:205,resolvedRequests:205,requestsWithTime:205});
  expect((await service.snapshot()).ownerEffort).toEqual(result);expect((await db.query('SELECT id FROM ledger')).rows).toHaveLength(0);
 }finally{await db.close();}
});
