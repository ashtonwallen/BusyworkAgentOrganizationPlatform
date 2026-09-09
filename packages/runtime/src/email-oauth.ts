import {randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {businessMailbox,EmailProviderError} from './email-provider.js';
import {GmailEmailProvider} from './gmail.js';
import {type HiveService} from './service.js';
import {event,one} from './db.js';
export const gmailScopes=['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'];
export class GmailOAuth {
 private cached?:{token:string;expires:number};private refreshing?:Promise<string>;private states=new Map<string,{expires:number;verifier:string}>();
 constructor(private service:HiveService,private clientId:string,private clientSecret:string,private redirectUri:string,private key:Buffer,private fetcher:typeof fetch=fetch){if(key.length!==32)throw new Error('Email encryption key must be 32 bytes.');}
 static async localKey(dataDir:string){const path=join(dataDir,'email-token.key');try{await writeFile(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}const key=await readFile(path);if(key.length!==32)throw new Error('Invalid email encryption key file.');return key;}
 private encrypt(value:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv),data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
 private decrypt(value:string){const data=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');}
 begin(){
  if(!businessMailbox)throw new EmailProviderError('MAILBOX_NOT_CONFIGURED');
  for(const [key,value] of this.states)if(value.expires<Date.now())this.states.delete(key);if(this.states.size>20)throw new EmailProviderError('TOO_MANY_AUTH_ATTEMPTS');
  const state=randomBytes(32).toString('hex'),verifier=randomBytes(48).toString('base64url');this.states.set(state,{expires:Date.now()+600000,verifier});
  return 'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({client_id:this.clientId,redirect_uri:this.redirectUri,response_type:'code',scope:gmailScopes.join(' '),access_type:'offline',prompt:'consent',login_hint:businessMailbox,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
 }
 private async token(body:Record<string,string>){let response:Response;try{response=await this.fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...body,client_id:this.clientId,client_secret:this.clientSecret}),redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new EmailProviderError('AUTH_CONNECTION_FAILED');}if(!response.ok)throw new EmailProviderError('AUTH_REQUIRED',response.status);const data=await response.json() as any;if(typeof data.access_token!=='string')throw new EmailProviderError('INVALID_AUTH_RESPONSE');return data;}
 async complete(code:string,state:string){const pending=this.states.get(state);this.states.delete(state);if(!pending||pending.expires<Date.now())throw new EmailProviderError('INVALID_AUTH_STATE');const token=await this.token({grant_type:'authorization_code',code,redirect_uri:this.redirectUri,code_verifier:pending.verifier});if(typeof token.refresh_token!=='string')throw new EmailProviderError('REFRESH_TOKEN_REQUIRED');await this.connectRefreshToken(token.refresh_token,token.access_token);}
 async connectRefreshToken(refreshToken:string,accessToken?:string){
  const token=accessToken??(await this.token({grant_type:'refresh_token',refresh_token:refreshToken})).access_token;
  const profile=await new GmailEmailProvider(async()=>token,this.fetcher).profile();if(!businessMailbox||profile.emailAddress.toLowerCase()!==businessMailbox)throw new EmailProviderError('WRONG_MAILBOX');
  await this.service.db.transaction(async tx=>{await tx.query("INSERT INTO email_mailboxes(address,provider,enabled,credential_ciphertext) VALUES($1,'gmail',true,$2) ON CONFLICT(address) DO UPDATE SET credential_ciphertext=$2,enabled=true,error=NULL",[businessMailbox,this.encrypt(refreshToken)]);await event(tx,'email.mailbox_connected',businessMailbox,{provider:'gmail'},'owner');});this.cached=undefined;
 }
 async accessToken(){if(this.cached&&this.cached.expires>Date.now())return this.cached.token;if(this.refreshing)return this.refreshing;this.refreshing=this.refresh().finally(()=>{this.refreshing=undefined;});return this.refreshing;}
 private async refresh(){const box=await one(this.service.db,'SELECT enabled,credential_ciphertext FROM email_mailboxes WHERE address=$1',[businessMailbox]);if(!box.enabled||!box.credential_ciphertext)throw new EmailProviderError('MAILBOX_DISABLED');let refreshToken:string;try{refreshToken=this.decrypt(box.credential_ciphertext);}catch{throw new EmailProviderError('CREDENTIAL_DECRYPTION_FAILED');}const data=await this.token({grant_type:'refresh_token',refresh_token:refreshToken});this.cached={token:data.access_token,expires:Date.now()+Math.max(0,Number(data.expires_in??3600)-60)*1000};return this.cached.token;}
}
