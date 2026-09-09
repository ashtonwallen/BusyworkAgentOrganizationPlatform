import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';
it('allows explicit local sign-in bypass while retaining origin checks and business approval gates',async()=>{
  const db=await openDatabase(),service=new HiveService(db,createModels({}));
  const app=buildApp({service,dashboardAuthDisabled:true,logger:false});
  try{
    expect((await app.inject({url:'/v1/auth/status'})).json()).toMatchObject({authenticated:true,signInRequired:false});
    const response=await app.inject({url:'/v1/snapshot'});expect(response.statusCode).toBe(200);
    expect(response.json().company.approval_policy.expenses).toBe(true);
    expect((await app.inject({method:'POST',url:'/v1/tasks',headers:{origin:'https://unrelated.example'},payload:{objective:'Disallowed origin'}})).statusCode).toBe(403);
    expect((await app.inject({url:'/v1/snapshot',headers:{host:'unrelated.example'}})).statusCode).toBe(403);
  }finally{await app.close();await db.close();}
});
