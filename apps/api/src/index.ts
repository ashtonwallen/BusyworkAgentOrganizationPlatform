import './environment.js';
import {configuredSearch,runtimeToolRegistry} from '@hive/runtime';
import {instanceSettings,sandboxAvailable} from '@hive/runtime';
import {resetBusiness} from '@hive/runtime';
import { buildApp } from "./app.js";
import { openDatabase, browserAvailable, HiveService, Workspaces, GmailOAuth, GmailEmailProvider, BusinessEmail, hostingSetup, StaticPublisher, NetlifyDeploymentClient, Worker, createModels, discoverLocalModels, event, smsConfig, SmsService,ToolGateway,ToolRegistry,publicPageTool, candidatePoolSchema } from "@hive/runtime";
import { mkdir, readFile, writeFile, open, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root=fileURLToPath(new URL("../../../",import.meta.url));
const configDir=resolve(root,process.env.HIVE_CONFIG_DIR??'config');
const dataDir=resolve(root,process.env.HIVE_DATA_DIR??"data");
await mkdir(dataDir,{recursive:true});
const lockPath=resolve(dataDir,"server.lock");
try {
  const previous=Number(await readFile(lockPath,"utf8"));
  if(Number.isInteger(previous)&&previous>0){try{process.kill(previous,0);throw new Error("Hive is already running for this data directory.");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}}
  await unlink(lockPath);
} catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
const lock=await open(lockPath,"wx");await lock.writeFile(String(process.pid));await lock.close();
let db:Awaited<ReturnType<typeof openDatabase>>|undefined;
try {
  let ownerToken=process.env.HIVE_OWNER_TOKEN;
  if(!ownerToken){const tokenPath=resolve(dataDir,"owner-token.txt");try{ownerToken=(await readFile(tokenPath,"utf8")).trim();}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;ownerToken=randomBytes(24).toString("hex");await writeFile(tokenPath,ownerToken,{mode:0o600,flag:"wx"});}}
  if(ownerToken.length<16)throw new Error("HIVE_OWNER_TOKEN must contain at least 16 characters.");
  db=await openDatabase(resolve(dataDir,"postgres"));
  let registry:unknown=[];
  try{registry=JSON.parse(await readFile(resolve(configDir,"models.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const models=createModels(process.env,registry).filter(model=>model.provider!=='mock');await discoverLocalModels(models);
  const service=new HiveService(db,models);service.browserAvailable=await browserAvailable();service.sandboxReady=await sandboxAvailable();service.workspaces=new Workspaces(resolve(dataDir,"workspaces"));service.hosting=hostingSetup(process.env);
  const lastReset=(await db.query<{payload:{archive?:string}}>("SELECT payload FROM events WHERE type='company.reset' ORDER BY sequence DESC LIMIT 1")).rows[0];
  if(lastReset?.payload.archive&&/^business_archive_[a-f0-9]{32}$/.test(lastReset.payload.archive))service.workspaces=new Workspaces(resolve(dataDir,'workspaces','generations',lastReset.payload.archive));
  let resetting=false;
  const publisher=service.hosting.ready?new StaticPublisher(service,service.hosting.siteId!,new NetlifyDeploymentClient(process.env.HIVE_NETLIFY_TOKEN!)):undefined;
  await service.loadModelSettings();
  // People the CEO and its managers can hire. Absent config just means an empty pool.
  try{service.candidates=candidatePoolSchema.parse(JSON.parse(await readFile(resolve(configDir,"candidates.json"),"utf8")));}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}const worker=new Worker(service);await worker.recover();
  const search=configuredSearch(process.env);service.searchTool=search.tool;service.searchSetup=search.setup;
  await new ToolGateway(service,runtimeToolRegistry(service)).recover();
  try{
    const reminders=JSON.parse(await readFile(resolve(configDir,"owner-reminders.json"),"utf8")) as {id:string;title:string;details:string}[];
    await db.transaction(async(tx)=>{for(const reminder of reminders){const existing=await tx.query("SELECT id FROM owner_requests WHERE id=$1",[reminder.id]);if(!existing.rows.length){await tx.query("INSERT INTO owner_requests(id,title,details) VALUES($1,$2,$3)",[reminder.id,reminder.title,reminder.details]);await event(tx,"owner.reminder_created",reminder.id,{title:reminder.title},"owner");}}});
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  // What the company owns and is bound by. Seeded once by id, so owner edits survive restarts.
  try{
    const records=JSON.parse(await readFile(resolve(configDir,"company-records.json"),"utf8")) as {id:string;kind:string;title:string;body:string}[];
    await db.transaction(async(tx)=>{for(const record of records){const existing=await tx.query("SELECT id FROM company_records WHERE id=$1",[record.id]);if(!existing.rows.length){await tx.query("INSERT INTO company_records(id,kind,title,body) VALUES($1,$2,$3,$4)",[record.id,record.kind,record.title,record.body]);await event(tx,"company.record_added",record.id,{kind:record.kind,title:record.title},"owner");}}});
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const smsSettings=smsConfig();const sms=smsSettings?new SmsService(service,smsSettings):undefined;await sms?.recover();
  const gmailClientId=process.env.HIVE_GMAIL_CLIENT_ID??process.env.GOOGLE_OAUTH_CLIENT_ID,gmailClientSecret=process.env.HIVE_GMAIL_CLIENT_SECRET??process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const emailOAuth=instanceSettings.mailbox&&gmailClientId&&gmailClientSecret?new GmailOAuth(service,gmailClientId,gmailClientSecret,process.env.HIVE_GMAIL_REDIRECT_URI??`http://127.0.0.1:${process.env.PORT??3001}/email/oauth/callback`,await GmailOAuth.localKey(dataDir)):undefined;
  const email=emailOAuth?new BusinessEmail(service,new GmailEmailProvider(()=>emailOAuth.accessToken())):undefined;await email?.recover();
  const app=buildApp({service,worker,isResetting:()=>resetting,resetBusiness:async revision=>{
    if(resetting)throw new Error('Reset already in progress.');resetting=true;
    try{
      await worker.stop();await Promise.all([smsPending,publishingPending,emailSendPending,emailSyncPending]);
      return await resetBusiness(service,revision,resolve(dataDir,'workspaces','generations'));
    }finally{resetting=false;if(process.env.HIVE_WORKER_ENABLED!=='false')worker.start();}
  },sms,email,emailOAuth,ownerToken,dashboardAuthDisabled:process.env.HIVE_DASHBOARD_AUTH_DISABLED==='true',dashboardRoot:resolve(root,"apps/dashboard/public"),paymentInfoPath:resolve(root,process.env.HIVE_PAYMENT_INFO_FILE??"Payment_Info_Venmo_Crypto.txt")});
  const port=Number(process.env.PORT??3001);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error("PORT must be between 1 and 65535.");
  await app.listen({port,host:"127.0.0.1"});
  if(process.env.HIVE_WORKER_ENABLED!=="false")worker.start();
  let smsPending:Promise<void>|undefined;
  const smsTimer=sms?setInterval(()=>{if(!resetting&&!smsPending)smsPending=sms.tick().catch(()=>{app.log.warn('SMS worker needs attention; inspect notification records.');}).finally(()=>{smsPending=undefined;});},15000):undefined;
  smsTimer?.unref();
  let emailSendPending:Promise<void>|undefined,emailSyncPending:Promise<void>|undefined;
  const emailSendTimer=email&&process.env.HIVE_WORKER_ENABLED!=='false'?setInterval(()=>{if(!resetting&&!emailSendPending)emailSendPending=email.sendNext().catch(()=>{app.log.warn('Business email sending needs attention.');}).finally(()=>{emailSendPending=undefined;});},15000):undefined;
  const emailSyncTimer=email?setInterval(()=>{if(!resetting&&!emailSyncPending)emailSyncPending=email.sync().catch(()=>{app.log.warn('Mailbox sync needs attention.');}).finally(()=>{emailSyncPending=undefined;});},180000):undefined;
  emailSendTimer?.unref();emailSyncTimer?.unref();
  let publishingPending:Promise<void>|undefined;
  const publishingTimer=publisher&&process.env.HIVE_WORKER_ENABLED!=='false'?setInterval(()=>{if(!resetting&&!publishingPending)publishingPending=publisher.tick().catch(()=>{app.log.warn('Publishing needs attention; inspect deployment records.');}).finally(()=>{publishingPending=undefined;});},15000):undefined;
  publishingTimer?.unref();
  app.log.info("Owner access key is in data/owner-token.txt (or HIVE_OWNER_TOKEN). Provider keys remain server-side.");
  let closing=false;
  for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{if(closing)return;closing=true;void(async()=>{if(smsTimer)clearInterval(smsTimer);if(publishingTimer)clearInterval(publishingTimer);if(emailSendTimer)clearInterval(emailSendTimer);if(emailSyncTimer)clearInterval(emailSyncTimer);await Promise.all([smsPending,publishingPending,emailSendPending,emailSyncPending,worker.stop()]);await app.close();await db!.close();await unlink(lockPath);})().catch(()=>{process.exitCode=1;});});
} catch(error){await db?.close();await unlink(lockPath).catch(()=>undefined);throw error;}
