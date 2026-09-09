import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels} from '../packages/runtime/src/index.js';
import {buildApp} from '../apps/api/src/app.js';
it('pages complete owner correspondence with stable equal-time cursors and no unrelated messages',async()=>{
 const db=await openDatabase(),service=new HiveService(db,createModels({})),app=buildApp({service,ownerToken:'history-fixture',logger:false});try{
 await db.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body,created_at) SELECT 'message-'||lpad(n::text,3,'0'),'owner','employee','MESSAGE','Subject','Body','2026-09-09T00:00:00.123456Z' FROM generate_series(1,125) n");
 await db.query("INSERT INTO messages(id,sender_id,recipient_id,kind,subject,body) VALUES('private','a','b','MESSAGE','Private','Not owner correspondence')");
 const read=async(before?:string)=>{const r=await app.inject({method:'GET',url:'/v1/conversations/history'+(before?'?before='+before:''),headers:{authorization:'Bearer history-fixture'}});expect(r.statusCode).toBe(200);return r.json();};
 const first=await read(),second=await read(first.messages.at(-1).id),third=await read(second.messages.at(-1).id);
 expect(first.messages).toHaveLength(50);expect(second.messages).toHaveLength(50);expect(third.messages).toHaveLength(25);expect(third.hasMore).toBe(false);expect(new Set([...first.messages,...second.messages,...third.messages].map(m=>m.id)).size).toBe(125);
 expect((await app.inject({method:'GET',url:'/v1/conversations/history'})).statusCode).toBe(401);
 expect((await app.inject({method:'GET',url:'/v1/conversations/history?before=private',headers:{authorization:'Bearer history-fixture'}})).statusCode).toBe(404);
 }finally{await app.close();await db.close();}
});
