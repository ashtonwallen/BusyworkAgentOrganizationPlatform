import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,Organization} from '../packages/runtime/src/index.js';
import {internalRead,internalReadContext} from '../packages/runtime/src/internal-reads.js';
it('reads every matching business record in bounded pages and invalidates changed contact details',async()=>{
 const db=await openDatabase();try{
  const service=new HiveService(db,createModels({})),org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
  await db.query("INSERT INTO email_entities(kind,id,label,addresses) SELECT 'CUSTOMER','buyer-'||n,'Customer checklist buyer '||n,jsonb_build_array('buyer'||n||'@example.com') FROM generate_series(1,45) n");
  const read=(target:string,offset=0)=>db.transaction(tx=>internalRead(tx,service,ceo.id,{type:'ENTITY_FIND',target,offset})) as Promise<any>;
  let page=await read('checklist');const first=page;let value=page.content,pages=1;
  expect(page.totalMatches).toBe(45);expect(page.content.length).toBeLessThanOrEqual(4000);
  while(page.nextOffset!==null){page=await read('checklist',page.nextOffset);expect(page.resultHash).toBe(first.resultHash);expect(page.content.length).toBeLessThanOrEqual(4000);value+=page.content;pages++;}
  expect(pages).toBeGreaterThan(1);expect(JSON.parse(value)).toHaveLength(45);
  expect(JSON.parse((await read('BUYER45@example.com')).content)[0].id).toBe('buyer-45');
  expect(JSON.parse((await read('%')).content)).toEqual([]);
  const cached={employeeId:ceo.id,request:{type:'ENTITY_FIND',target:'checklist'},result:first};
  expect((await db.transaction(tx=>internalReadContext(tx,ceo.id,cached)))?.result).toEqual(first);
  await db.query("UPDATE email_entities SET addresses='[\"changed@example.com\"]'::jsonb WHERE id='buyer-45'");
  expect((await db.transaction(tx=>internalReadContext(tx,ceo.id,cached)))?.error).toContain('changed');
  await expect(db.transaction(tx=>internalRead(tx,service,'outsider',{type:'ENTITY_FIND',target:'*'}))).rejects.toThrow('active employee');
  await expect(read('*',999999)).rejects.toThrow('offset');
 }finally{await db.close();}
});
