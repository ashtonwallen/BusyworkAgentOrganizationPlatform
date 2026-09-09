import {it,expect} from 'vitest';
import {openDatabase,HiveService,createModels,ledgerCsv} from '../packages/runtime/src/index.js';
it('includes historical receipts across the full 90-day dashboard range',async()=>{
  const db=await openDatabase();try{
    await db.query("INSERT INTO ledger(id,idempotency_key,account,kind,amount,description,occurred_at) VALUES('historical-fixture','historical-fixture','BUSINESS','REVENUE',1250000,'Historical fixture',now()-interval '60 days')");
    const snapshot=await new HiveService(db,createModels({})).snapshot();
    expect(snapshot.daily.some(row=>row.kind==='REVENUE'&&row.amount==='1250000')).toBe(true);
  }finally{await db.close();}
});
it('exports exact receipts, separates funding and neutralizes spreadsheet formulas',async()=>{
  const db=await openDatabase();try{
    const service=new HiveService(db,createModels({}));await service.recordMoney({kind:'FUNDING',amountUsd:'123.123456',description:'=HYPERLINK("https://invalid.example")',externalReference:'@untrusted-reference',idempotencyKey:'csv-fixture'});
    const csv=await ledgerCsv(service,{});expect(csv).toContain('"BUSINESS","FUNDING","123.123456"');expect(csv).toContain('"\'@untrusted-reference"');expect(csv).toContain('"\'=HYPERLINK(""https://invalid.example"")"');
    expect((await ledgerCsv(service,{to:'2000-01-01T00:00:00Z'})).trim().split('\r\n')).toHaveLength(1);
    await expect(ledgerCsv(service,{from:'2026-02-01T00:00:00Z',to:'2026-01-01T00:00:00Z'})).rejects.toThrow('precede');
  }finally{await db.close();}
});
