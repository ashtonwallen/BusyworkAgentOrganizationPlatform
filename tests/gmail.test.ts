import {it,expect} from 'vitest';
import {randomBytes} from 'node:crypto';
import {GmailEmailProvider,GmailOAuth,BusinessEmail,openDatabase,HiveService,createModels,one,businessMailbox} from '../packages/runtime/src/index.js';
it('normalizes Gmail content, address names, threading and attachment metadata without fetching attachments',async()=>{
 const paths:string[]=[];const provider=new GmailEmailProvider(async()=>'fixture',async(url)=>{paths.push(String(url));return new Response(JSON.stringify({id:'m1',threadId:'t1',internalDate:'1788900000000',labelIds:['INBOX'],payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:'Buyer Name <buyer@example.com>'},{name:'To',value:businessMailbox},{name:'Subject',value:'=?UTF-8?B?SGVsbG8=?='},{name:'Message-ID',value:'<m1@example.com>'},{name:'In-Reply-To',value:'<old@example.com>'}],parts:[{mimeType:'text/plain',body:{data:Buffer.from('Hello').toString('base64url'),size:5}},{mimeType:'text/html',body:{data:Buffer.from('<p>Hello</p>').toString('base64url'),size:12}},{filename:'brief.pdf',partId:'2',mimeType:'application/pdf',body:{attachmentId:'a1',size:1000}}]}}));});
 const message=await provider.get('m1');expect(message).toMatchObject({from:['buyer@example.com'],subject:'Hello',text:'Hello',html:'<p>Hello</p>',threadId:'t1',attachments:[{filename:'brief.pdf',providerAttachmentId:'a1',size:1000}]});expect(message?.headers['in-reply-to']).toBe('<old@example.com>');expect(paths).toHaveLength(1);
});
it('does not retry Gmail sends and normalizes HTTP errors without secret leakage',async()=>{
 let calls=0;const provider=new GmailEmailProvider(async()=>'private-token',async()=>{calls++;throw new Error('private-token');});await expect(provider.send('raw')).rejects.toMatchObject({uncertain:true,message:expect.not.stringContaining('private-token')});expect(calls).toBe(1);
 const rejected=new GmailEmailProvider(async()=>'fixture',async()=>new Response('{}',{status:403}));await expect(rejected.send('raw')).rejects.toMatchObject({status:403,uncertain:false});
});
it('uses OAuth state/PKCE, verifies the mailbox, encrypts refresh tokens and refreshes access',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({}));let refreshes=0;
 const fetcher:typeof fetch=async(url,options)=>{if(String(url).includes('/token')){const body=String(options?.body);if(body.includes('refresh_token'))refreshes++;return new Response(JSON.stringify({access_token:'access-fixture',refresh_token:'refresh-private-fixture',expires_in:3600}));}return new Response(JSON.stringify({emailAddress:businessMailbox,historyId:'123'}));};
 const oauth=new GmailOAuth(service,'fixture-id','fixture-secret','http://127.0.0.1:3001/email/oauth/callback',randomBytes(32),fetcher);const url=new URL(oauth.begin());expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(url.searchParams.get('scope')).toContain('gmail.send');
 await expect(oauth.complete('code','invalid')).rejects.toThrow('INVALID_AUTH_STATE');await oauth.complete('code',url.searchParams.get('state')!);await expect(oauth.complete('code',url.searchParams.get('state')!)).rejects.toThrow('INVALID_AUTH_STATE');
 const box=await one(db,'SELECT * FROM email_mailboxes');expect(box.credential_ciphertext).not.toContain('refresh-private-fixture');expect(JSON.stringify(await service.snapshot())).not.toContain('refresh-private-fixture');expect(JSON.stringify(await service.snapshot())).not.toContain(box.credential_ciphertext);
 expect(await oauth.accessToken()).toBe('access-fixture');await oauth.accessToken();expect(refreshes).toBe(1);
 const wrong=new GmailOAuth(service,'id','secret','http://127.0.0.1/callback',randomBytes(32),async url=>new Response(JSON.stringify(String(url).includes('/token')?{access_token:'token'}:{emailAddress:'wrong@example.com',historyId:'1'})));await expect(wrong.connectRefreshToken('refresh')).rejects.toThrow('WRONG_MAILBOX');
 }finally{await db.close();}
});

it('binds the OAuth callback to an owner-initiated browser state cookie',async()=>{
 const db=await openDatabase();const {buildApp}=await import('../apps/api/src/app.js');let app:any;try{
 const service=new HiveService(db,createModels({}));let calls=0;const oauth=new GmailOAuth(service,'id','secret','http://127.0.0.1:3001/email/oauth/callback',randomBytes(32),async url=>{calls++;return new Response(JSON.stringify(String(url).includes('/token')?{access_token:'access',refresh_token:'refresh',expires_in:3600}:{emailAddress:businessMailbox,historyId:'1'}));});app=buildApp({service,emailOAuth:oauth,ownerToken:'fixture-owner-token',logger:false});
 expect((await app.inject({method:'POST',url:'/v1/email/connect'})).statusCode).toBe(401);const begin=await app.inject({method:'POST',url:'/v1/email/connect',headers:{authorization:'Bearer fixture-owner-token'}});expect(begin.statusCode).toBe(200);const state=new URL(begin.json().url).searchParams.get('state');const callback='/email/oauth/callback?code=fixture&state='+state;
 expect((await app.inject({url:callback})).statusCode).toBe(400);expect(calls).toBe(0);expect((await app.inject({url:callback,headers:{cookie:'hive_email_oauth='+state}})).statusCode).toBe(302);expect(calls).toBe(2);expect((await app.inject({url:callback,headers:{cookie:'hive_email_oauth='+state}})).statusCode).toBe(400);
 }finally{await app?.close();await db.close();}
});

it('rejects malformed Gmail pages without advancing the mailbox cursor and recovers on the same page',async()=>{
 const db=await openDatabase();try{
 const service=new HiveService(db,createModels({}));await db.query("INSERT INTO email_mailboxes(address,provider,enabled,sync_state) VALUES($1,'gmail',true,$2)",[businessMailbox,JSON.stringify({historyId:'100',pageToken:'page-one'})]);let malformed=true;const requests:string[]=[];
 const provider=new GmailEmailProvider(async()=>'fixture',async url=>{requests.push(String(url));return new Response(JSON.stringify(String(url).endsWith('/profile')?{emailAddress:businessMailbox,historyId:'200'}:malformed?{history:'not-an-array',historyId:'200'}:{history:[],historyId:'200'}));}),email=new BusinessEmail(service,provider);
 await expect(email.sync()).rejects.toMatchObject({code:'INVALID_PAGE'});let box=await one(db,'SELECT * FROM email_mailboxes');expect(box.sync_state).toEqual({historyId:'100',pageToken:'page-one'});expect(box.last_synced_at).toBeNull();
 malformed=false;await email.sync();box=await one(db,'SELECT * FROM email_mailboxes');expect(box.sync_state).toEqual({historyId:'200'});expect(box.error).toBeNull();expect(requests.filter(u=>u.includes('/history?')).every(u=>u.includes('pageToken=page-one'))).toBe(true);
 for(const value of [null,[],{messages:[{}]},{messages:[{id:42}]},{messages:[],nextPageToken:''}]){const invalid=new GmailEmailProvider(async()=>'fixture',async()=>new Response(JSON.stringify(value)));await expect(invalid.list()).rejects.toMatchObject({uncertain:false});}
 expect((await db.query('SELECT * FROM email_messages')).rows).toHaveLength(0);
 }finally{await db.close();}
});
