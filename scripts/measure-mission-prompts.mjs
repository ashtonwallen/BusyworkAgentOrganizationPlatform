// Synthetic, in-memory mock inference only. Build before running.
import {writeFile} from 'node:fs/promises';
import {openDatabase,HiveService,createModels,Worker} from '../packages/runtime/dist/index.js';
import {missionTemplates,createMission,activateMission} from '../packages/runtime/dist/missions.js';
import {estimatedInputTokens} from '../packages/runtime/dist/prompt-capacity.js';
const rows=[];
for(const template of missionTemplates){
 const db=await openDatabase();
 try{
  const service=new HiveService(db,createModels({}));
  const {id}=await createMission(service,{template:template.id,title:template.name,objective:template.objective,definitionOfDone:template.definitionOfDone,kind:template.kind,budgetUsd:null,capabilities:template.capabilities,deliverable:template.deliverable});
  await activateMission(service,id);
  const model=service.models.find(m=>m.id==='mock-worker');model.maxInputTokens=100000;model.maxOutputTokens=3000;
  const generate=model.adapter.generate.bind(model.adapter);
  model.adapter.generate=async request=>{rows.push({template:template.id,phase:request.input.phase,estimatedTokens:estimatedInputTokens(request),systemBytes:Buffer.byteLength(request.system),schemaBytes:Buffer.byteLength(JSON.stringify(request.outputSchema))});const result=await generate(request);if(request.input.phase==='WORK')for(const key of Object.keys(result.output))if(!Object.hasOwn(request.outputSchema.properties,key))delete result.output[key];return result;};
  await service.createTask({objective:'Prepare the mission deliverable using recorded evidence.'});await service.setStatus('RUNNING');const worker=new Worker(service);
  await worker.runNext();await worker.runNext();
 }finally{await db.close();}
}
const output=JSON.stringify({method:'ceil(UTF-8 request JSON bytes / 3) + 512; synthetic empty mission, mock model, identical objective; estimates, not provider tokenizer counts',rows},null,2);
if(process.argv[2])await writeFile(process.argv[2],output);console.log(output);
