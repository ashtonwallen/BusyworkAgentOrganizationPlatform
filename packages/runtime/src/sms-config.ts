import {parseUsd} from '@hive/core';

export interface SmsConfig {
  accountSid:string;authToken:string;from:string;to:string;webhookUrl:string;maxCostUsd:string;dailyCapUsd:string;
  apiKeySid?:string;apiKeySecret?:string;
}
const required=['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','HIVE_SMS_FROM','HIVE_SMS_TO','HIVE_SMS_MAX_COST_USD','HIVE_SMS_DAILY_CAP_USD'] as const;
export function smsConfig(env:NodeJS.ProcessEnv=process.env):SmsConfig|undefined {
  if(required.some(key=>!env[key]))return;
  const config:SmsConfig={accountSid:env.TWILIO_ACCOUNT_SID!,authToken:env.TWILIO_AUTH_TOKEN!,from:env.HIVE_SMS_FROM!,to:env.HIVE_SMS_TO!,webhookUrl:env.HIVE_SMS_WEBHOOK_URL??'',maxCostUsd:env.HIVE_SMS_MAX_COST_USD!,dailyCapUsd:env.HIVE_SMS_DAILY_CAP_USD!,apiKeySid:env.TWILIO_API_KEY_SID||env.TWILIO_SID,apiKeySecret:env.TWILIO_API_KEY_SECRET||env.TWILIO_CLIENT_SECRET};
  if(!/^AC[a-fA-F0-9]{32}$/.test(config.accountSid)||![config.from,config.to].every(p=>/^\+[1-9][0-9]{7,14}$/.test(p)))throw new Error('Invalid SMS account or E.164 phone number configuration.');
  if((config.apiKeySid||config.apiKeySecret)&&(!/^SK[a-fA-F0-9]{32}$/.test(config.apiKeySid??'')||!config.apiKeySecret))throw new Error('SMS API authentication requires an SK API key SID and its matching secret.');
  if(config.webhookUrl){
    const url=new URL(config.webhookUrl);
    if(url.protocol!=='https:'||url.pathname!=='/webhooks/twilio'||url.search||url.hash||url.username||url.password)throw new Error('SMS webhook must be a public HTTPS URL ending in /webhooks/twilio with no credentials or query.');
  }
  if(parseUsd(config.maxCostUsd)<=0n||parseUsd(config.dailyCapUsd)<parseUsd(config.maxCostUsd))throw new Error('SMS requires a positive per-notification bound and a sufficient daily cap.');
  return config;
}
export function smsSetupStatus(env:NodeJS.ProcessEnv=process.env){
  const missingFields:string[]=required.filter(key=>!env[key]);
  if((env.TWILIO_API_KEY_SID||env.TWILIO_SID)&&!(env.TWILIO_API_KEY_SECRET||env.TWILIO_CLIENT_SECRET))missingFields.push('TWILIO_API_KEY_SECRET');
  if((env.TWILIO_API_KEY_SECRET||env.TWILIO_CLIENT_SECRET)&&!(env.TWILIO_API_KEY_SID||env.TWILIO_SID))missingFields.push('TWILIO_API_KEY_SID');
  try{return{configured:!!smsConfig(env),missingFields,replyEnabled:!!env.HIVE_SMS_WEBHOOK_URL,invalidConfiguration:false};}
  catch{return{configured:false,missingFields,replyEnabled:false,invalidConfiguration:true};}
}
export function smsAuthorization(config:SmsConfig){
  return `Basic ${Buffer.from(config.apiKeySid?`${config.apiKeySid}:${config.apiKeySecret}`:`${config.accountSid}:${config.authToken}`).toString('base64')}`;
}
