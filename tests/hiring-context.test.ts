import {it,expect} from 'vitest';
import {openDatabase,HiveService,Organization,Worker,createModels,one} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';
import {fitPrompt} from '../packages/runtime/src/prompt-capacity.js';
it('carries a generated hiring choice into self-review and applies the hire once',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));const org=new Organization(service);let reviewed=false;
  await db.query("UPDATE company SET ceo_model_id='mock-worker' WHERE id=1");
  const ceo=await db.transaction(tx=>org.ensureCEO(tx));
  const adapter=new MockProvider(),generate=adapter.generate.bind(adapter);
  adapter.generate=async request=>{
   const result=await generate(request),input=request.input as any;
   if(input.phase==='PLAN')(result.output as any).hiringNeeds=[{role:'Internal analyst',requirements:'Compare the existing evidence',desiredTraits:{caution:3,rigor:4,dissent:3,initiative:4,thrift:4}}];
   if(input.phase==='WORK'){
    expect(input.hiringShortlist).toHaveLength(4);
    (result.output as any).operations=[{type:'HIRE',target:'operations',title:'Internal analyst',instructions:'Compare existing evidence and report a decision',budgetUsd:'0',tokenBudget:5000,modelId:'mock-worker',participants:[],scheduledAt:null,candidateId:input.hiringShortlist[0].candidateId}];
   }
   if(input.phase==='REVIEW'){
    const fitted=fitPrompt({...request,input:{...input,hiringShortlist:input.hiringShortlist}},1).input as any;
    expect(fitted.hiringShortlist).toHaveLength(0);
    const chosen=input.artifact.operations[0].candidateId;
    const valid=fitted.selectedHiringCandidates.some((c:any)=>c.candidateId===chosen&&c.persisted&&c.available);
    reviewed=true;(result.output as any)={decision:valid?'PASS':'REVISE',findings:valid?[]:['Candidate evidence missing'],nextAction:valid?'Apply the hire':'Restore candidate evidence'};
   }
   return result;
  };
  service.models.find(m=>m.id==='mock-worker')!.adapter=adapter;
  const task=await service.createTask({objective:'Delegate a bounded analysis',employeeId:ceo.id,modelId:'mock-worker',tokenBudget:200000});
  await service.setStatus('RUNNING');const worker=new Worker(service);
  for(let i=0;i<3;i++)await worker.runNext();
  expect(reviewed).toBe(true);expect((await one(db,'SELECT status FROM tasks WHERE id=$1',[task.id])).status).toBe('COMPLETED');
  await org.applyOperations(task.id);await org.applyOperations(task.id);
  expect((await db.query('SELECT id FROM employees WHERE manager_id=$1',[ceo.id])).rows).toHaveLength(1);
  expect((await db.query("SELECT sequence FROM events WHERE type='recruitment.generated' AND entity_id=$1",[task.id])).rows).toHaveLength(1);
  const posting=(await service.snapshot()).recruitmentSearches.find((r:any)=>r.task_id===task.id);
  expect(posting?.posting_status).toBe('FILLED');expect(posting?.hires).toHaveLength(1);
 }finally{await db.close();}
});
