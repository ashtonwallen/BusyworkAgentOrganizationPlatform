import { beforeEach,afterEach,it,expect } from "vitest";
import { createHmac } from "node:crypto";
import { openDatabase,HiveService,createModels,SmsService,one,smsConfig,smsSetupStatus,smsAuthorization,verifyTwilioSignature,type SmsConfig } from "../packages/runtime/src/index.js";
let db:Awaited<ReturnType<typeof openDatabase>>,service:HiveService;
const config:SmsConfig={accountSid:'AC'+'1'.repeat(32),authToken:'test-signature-secret',from:'+15550000001',to:'+15550000002',webhookUrl:'https://hive.example/webhooks/twilio',maxCostUsd:'0.10',dailyCapUsd:'1.00'};
beforeEach(async()=>{db=await openDatabase();service=new HiveService(db,createModels({}));});
afterEach(async()=>{await db.close();});
async function proposal(){return service.createAction({actionType:'OTHER_EXTERNAL',target:'A proposed vendor',payload:{description:'Request a quote'},rationale:'Compare a business input',maxCostUsd:'0',expiresAt:new Date(Date.now()+3600000).toISOString()});}
function signed(params:Record<string,string>){return createHmac('sha1',config.authToken).update(config.webhookUrl+Object.keys(params).sort().map(k=>k+params[k]).join('')).digest('base64');}
it('supports API key aliases for outbound authentication while retaining account-token reply validation',()=>{
  const env={TWILIO_ACCOUNT_SID:config.accountSid,TWILIO_AUTH_TOKEN:config.authToken,HIVE_SMS_FROM:config.from,HIVE_SMS_TO:config.to,HIVE_SMS_WEBHOOK_URL:config.webhookUrl,HIVE_SMS_MAX_COST_USD:config.maxCostUsd,HIVE_SMS_DAILY_CAP_USD:config.dailyCapUsd,TWILIO_SID:'SK'+'3'.repeat(32),TWILIO_CLIENT_SECRET:'api-secret-fixture'};
  const configured=smsConfig(env)!;expect(smsSetupStatus(env).configured).toBe(true);
  expect(Buffer.from(smsAuthorization(configured).slice(6),'base64').toString()).toBe(env.TWILIO_SID+':'+env.TWILIO_CLIENT_SECRET);
  const params={Body:'APPROVE fixture'};expect(verifyTwilioSignature(configured,signed(params),params)).toBe(true);
  const wrong=createHmac('sha1',env.TWILIO_CLIENT_SECRET).update(config.webhookUrl+'Body'+params.Body).digest('base64');expect(verifyTwilioSignature(configured,wrong,params)).toBe(false);
  const status=smsSetupStatus({TWILIO_SID:env.TWILIO_SID,TWILIO_CLIENT_SECRET:env.TWILIO_CLIENT_SECRET});expect(status.configured).toBe(false);expect(status.missingFields).toContain('TWILIO_ACCOUNT_SID');expect(JSON.stringify(status)).not.toContain('api-secret-fixture');
});
it('sends notification-only alerts without a webhook or reply instructions',async()=>{
  const env={TWILIO_ACCOUNT_SID:config.accountSid,TWILIO_AUTH_TOKEN:config.authToken,HIVE_SMS_FROM:config.from,HIVE_SMS_TO:config.to,HIVE_SMS_MAX_COST_USD:config.maxCostUsd,HIVE_SMS_DAILY_CAP_USD:config.dailyCapUsd};
  const configured=smsConfig(env)!;expect(configured).toBeTruthy();expect(smsSetupStatus(env).replyEnabled).toBe(false);
  await proposal();await db.query("UPDATE company SET approval_policy=approval_policy || '{\"smsEnabled\":true}'::jsonb WHERE id=1");
  let outbound='';const sms=new SmsService(service,configured,async(_url,options)=>{
    if(options?.method==='POST'){outbound=new URLSearchParams(String(options.body)).get('Body')??'';return new Response(JSON.stringify({sid:'SM'+'7'.repeat(32)}));}
    return new Response(JSON.stringify({price:'-0.01',price_unit:'USD'}));
  });
  await sms.tick();expect(outbound).toContain('Review in dashboard.');expect(outbound).not.toContain('Reply APPROVE');expect(verifyTwilioSignature(configured,'anything',{})).toBe(false);
  expect((await one(db,'SELECT status FROM actions')).status).toBe('PENDING');
});
it('reconciles an uncertain notification once without assuming delivery or authorizing its action',async()=>{
  const {id}=await proposal();const n=await one(db,'SELECT * FROM notifications WHERE action_id=$1',[id]);
  await db.query("UPDATE notifications SET status='UNCERTAIN',reserved=100000 WHERE id=$1",[n.id]);
  const receipt={amountUsd:'0.02',externalReference:'provider-statement-fixture',rationale:'Confirmed charge from provider statement'};
  await service.reconcileNotification(n.id,receipt);await service.reconcileNotification(n.id,receipt);
  expect((await one(db,'SELECT status,settled FROM notifications WHERE id=$1',[n.id]))).toMatchObject({status:'UNCERTAIN',settled:'20000'});
  expect((await one(db,'SELECT status FROM actions WHERE id=$1',[id])).status).toBe('PENDING');expect((await db.query('SELECT * FROM ledger WHERE notification_id=$1',[n.id])).rows).toHaveLength(1);
  await expect(service.reconcileNotification(n.id,{...receipt,amountUsd:'0.03'})).rejects.toThrow('different');
});
it('only applies a signed reply from the configured owner and ignores replay',async()=>{
  const{id}=await proposal();const n=await one(db,'SELECT * FROM notifications WHERE action_id=$1',[id]);const sms=new SmsService(service,config);
  const params={AccountSid:config.accountSid,From:config.to,To:config.from,MessageSid:'SM'+'2'.repeat(32),Body:`APPROVE ${n.code}`};
  await expect(sms.receive('invalid',params)).rejects.toThrow('Unverified');
  const stranger={...params,From:'+15550000003'};await expect(sms.receive(signed(stranger),stranger)).rejects.toThrow('Unverified');
  expect((await sms.receive(signed(params),params)).accepted).toBe(true);
  expect((await sms.receive(signed(params),params)).duplicate).toBe(true);
  expect((await one(db,'SELECT status FROM actions WHERE id=$1',[id])).status).toBe('APPROVED');expect((await db.query('SELECT * FROM approvals')).rows).toHaveLength(1);
});
it('will not apply a code to an expired or previously denied action',async()=>{
  const{id}=await proposal();const a=await one(db,'SELECT * FROM actions WHERE id=$1',[id]);const n=await one(db,'SELECT * FROM notifications WHERE action_id=$1',[id]);await service.approveAction(id,a.action_hash,'REJECT','Do not proceed');
  const params={AccountSid:config.accountSid,From:config.to,To:config.from,MessageSid:'SM'+'3'.repeat(32),Body:`APPROVE ${n.code}`};
  expect((await new SmsService(service,config).receive(signed(params),params)).accepted).toBe(false);expect((await one(db,'SELECT status FROM actions WHERE id=$1',[id])).status).toBe('REJECTED');
});
it('does not send while disabled, sends once when enabled, and reconciles actual price',async()=>{
  await proposal();let sends=0;
  const fetcher:typeof fetch=async(_url,options)=>{if(options?.method==='POST'){sends++;return Response.json({sid:'SM'+'4'.repeat(32)});}return Response.json({price:'-0.015',price_unit:'USD'});};
  const sms=new SmsService(service,config,fetcher);await sms.tick();expect(sends).toBe(0);
  await db.query("UPDATE company SET approval_policy=approval_policy || '{\"smsEnabled\":true}'::jsonb WHERE id=1");
  await sms.tick();await sms.tick();expect(sends).toBe(1);const n=await one(db,'SELECT * FROM notifications');expect(n.status).toBe('SENT');expect(BigInt(n.settled)).toBe(15000n);
  expect((await service.snapshot()).metrics.operatingCostsUsd).toBe('0.015000');
});
it('keeps an uncertain SMS reservation and never blindly resends',async()=>{
  await proposal();await db.query("UPDATE company SET approval_policy=approval_policy || '{\"smsEnabled\":true}'::jsonb WHERE id=1");let sends=0;
  const sms=new SmsService(service,config,async()=>{sends++;throw new Error('timeout');});await sms.tick();await sms.tick();expect(sends).toBe(1);const n=await one(db,'SELECT * FROM notifications');expect(n.status).toBe('UNCERTAIN');expect(n.settled).toBeNull();const snapshot=await service.snapshot();expect(snapshot.metrics.reservedUsd).toBe('0.100000');expect(snapshot.notifications[0]).toMatchObject({settled:null,reserved:'100000',action_status:'PENDING',action_type:'OTHER_EXTERNAL',target:'A proposed vendor'});
});
