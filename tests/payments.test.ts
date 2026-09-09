import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase,HiveService,createModels} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';

it('requires owner authentication and returns only supported receiving details',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hive-payment-test-'));const path=join(directory,'receiving.txt');
  const db=await openDatabase();const service=new HiveService(db,createModels({}));
  const app=buildApp({service,ownerToken:'payment-fixture-access',paymentInfoPath:path,logger:false});
  try{
    await writeFile(path,'Bitcoin (preferred): fixture-bitcoin\nBase: fixture-base\nVenmo: fixture-handle\nDirect deposit details: Coming later\nPrivate key: never-return-this-fixture\n');
    expect((await app.inject({url:'/v1/company/payment-info'})).statusCode).toBe(401);
    const response=await app.inject({url:'/v1/company/payment-info',headers:{authorization:'Bearer payment-fixture-access'}});
    expect(response.statusCode).toBe(200);expect(response.json().items).toHaveLength(3);expect(response.json().items[0].tag).toBe('preferred');expect(response.body).not.toContain('never-return');expect(response.json()).not.toHaveProperty('raw');
    expect((await service.snapshot()).metrics.revenueUsd).toBe('0.000000');expect((await db.query('SELECT * FROM actions')).rows).toHaveLength(0);
  }finally{await app.close();await db.close();await rm(directory,{recursive:true,force:true});}
});
