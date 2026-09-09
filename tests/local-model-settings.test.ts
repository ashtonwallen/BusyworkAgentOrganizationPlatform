import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';
it('configures a local model without prices, verifies availability and restores the selection',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({}));const local=service.models.find(m=>m.id==='local-qwen')!;
  local.ready=false;let inference=0;local.adapter={providerId:'lmstudio',listModels:async()=>[{provider:'lmstudio',modelId:'google/gemma-4-12b-qat',capabilities:['structured_output']}],loadedContextLength:async()=>32768,generate:async()=>{inference++;throw Error('No inference needed');}} as any;
  const app=buildApp({service,ownerToken:'fixture',logger:false});try{
   expect((await app.inject({method:'PUT',url:'/v1/models/local-qwen',payload:{model:'google/gemma-4-12b-qat'}})).statusCode).toBe(401);
   const response=await app.inject({method:'PUT',url:'/v1/models/local-qwen',headers:{authorization:'Bearer fixture'},payload:{model:'google/gemma-4-12b-qat'}});expect(response.statusCode).toBe(200);expect(response.json().ready).toBe(true);
   expect(local.model).toBe('google/gemma-4-12b-qat');expect(local.inputPerMillionUsd).toBe('0');expect(local.maxInputTokens).toBe(16000);
   await expect(service.configureModel(local.id,{model:'unknown'})).rejects.toThrow('not available');expect(local.model).toBe('google/gemma-4-12b-qat');
   const restored=new HiveService(db,createModels({}));restored.models.find(m=>m.id===local.id)!.adapter=local.adapter;await restored.loadModelSettings();expect(restored.model(local.id).model).toBe(local.model);expect(inference).toBe(0);
  }finally{await app.close();}
 }finally{await db.close();}
});
