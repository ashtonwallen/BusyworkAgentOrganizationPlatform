import {chromium} from 'playwright';
import {access} from 'node:fs/promises';
import {PublicReadFailure} from './tools.js';
export async function browserAvailable(){try{await access(chromium.executablePath());return true;}catch{return false;}}
/** Browser rendering of one gateway-fetched document, with all further network blocked. */
export async function browserRead(target:string,load:(target:string)=>Promise<{status:number;contentType:string;text:string}>){
 let browser;try{browser=await chromium.launch({headless:true,timeout:15000});}catch{throw new PublicReadFailure('BROWSER_UNAVAILABLE');}
 try{
  const document=await load(target);
  const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false,offline:true,viewport:{width:1280,height:800}});
  let served=false,blockedResources=0;
  await context.route('**/*',async route=>{
   if(!served&&route.request().isNavigationRequest()&&route.request().url()===new URL(target).href){served=true;await route.fulfill({status:200,contentType:document.contentType,body:document.text,headers:{'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; frame-src 'none'; base-uri 'none'; sandbox"}});}
   else{blockedResources++;await route.abort();}
  });
  const page=await context.newPage();await page.goto(target,{waitUntil:'domcontentloaded',timeout:15000});
  const extracted=await page.evaluate(()=>{
   const doc=(globalThis as any).document;
   const text=String(doc.body?.innerText??'');
   const links=Array.from(doc.querySelectorAll('a[href]')).slice(0,200).map((a:any)=>({text:String(a.innerText??'').trim().slice(0,200),url:a.href})).filter((a:any)=>a.url.startsWith('https://'));
   return {title:String(doc.title??'').slice(0,500),text:text.slice(0,20000),truncated:text.length>20000,links};
  });
  return {result:{source:target,fetchedAt:new Date().toISOString(),status:document.status,renderer:'browser',...extracted,blockedResources,limitations:['Scripts, subresources, redirects and interactive actions are disabled.'],trust:'UNTRUSTED_EXTERNAL_SOURCE'},actualCostUsd:'0'};
 }finally{await browser.close();}
}
