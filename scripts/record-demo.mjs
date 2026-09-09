import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';

const url=process.env.HIVE_FIXTURE_URL||'http://127.0.0.1:3099';
const token=process.env.HIVE_FIXTURE_TOKEN||'dev-fixture-access-key-not-a-secret';
const fixture=await fetch(new URL('/fixture-info',url)).then(response=>response.json());
if(fixture.synthetic!==true||fixture.workersStarted!==false||fixture.persistentData!==false)throw new Error('Recording requires the isolated fixture server.');
await mkdir('artifacts',{recursive:true});
const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:'artifacts',size:{width:1440,height:1000}}});
const page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const caption=async text=>page.evaluate(text=>{
 let banner=document.getElementById('demo-caption');
 if(!banner){banner=document.createElement('div');banner.id='demo-caption';banner.style.cssText='position:fixed;left:20px;bottom:12px;z-index:10000;max-width:1080px;background:#142438;color:white;padding:14px 22px;border-radius:8px;font:18px system-ui;pointer-events:none';document.body.append(banner);}
 banner.textContent='SYNTHETIC DEMO — '+text;
},text);
try {
 await page.goto(url);await page.locator('#owner-key').fill(token);await page.getByRole('button',{name:'Open dashboard',exact:true}).click();await page.locator('#content').waitFor();
 const before=await page.evaluate(()=>fetch('/v1/snapshot').then(r=>r.json()));
 const proposal=before.actions.find(action=>action.id==='act-2');
 if(proposal?.status!=='PENDING'||!/^[a-f0-9]{64}$/.test(proposal.action_hash))throw new Error('Restart the fixture for a fresh purchase proposal with a full action hash.');
 await caption('An agent organization proposes work; the owner controls external execution.');await page.waitForTimeout(10000);
 await page.locator('nav [data-page=inbox]').click();await caption('A worker requests a $35 data export. Nothing has been purchased.');await page.waitForTimeout(10000);
 await page.locator('[data-proposal="act-2"]').first().click();await caption('Review the exact destination, reason, payload and maximum cost.');await page.waitForTimeout(14000);
 await page.locator('#modal [name=rationale]').fill('Synthetic demonstration: approve only this exact export, once, with a maximum cost of $35.');
 await caption('The decision submits the displayed action hash and records the owner’s reasoning.');await page.waitForTimeout(9000);
 await page.locator('#modal button[type=submit]').click();await page.waitForTimeout(1000);
 const after=await page.evaluate(()=>fetch('/v1/snapshot').then(r=>r.json()));
 const approved=after.actions.find(action=>action.id===proposal.id);
 if(approved?.status!=='APPROVED'||approved.action_hash!==proposal.action_hash)throw new Error('Exact approval did not persist.');
 await page.locator('[data-proposal="act-2"]').first().click();await caption('Approved is not executed. This purchase has no installed automatic executor.');await page.waitForTimeout(13000);
 await caption('No money moved. Real outcomes require recorded evidence. All data in this walkthrough is fictional.');await page.waitForTimeout(8000);
 if(errors.length)throw new Error(errors.join('\n'));
 await writeFile('artifacts/demo-receipt.json',JSON.stringify({synthetic:true,proposalId:proposal.id,actionHash:approved.action_hash,status:approved.status,maxCostMicroUsd:approved.max_cost,externalExecution:false},null,2));
} finally {
 await context.close();await page.video()?.saveAs('artifacts/busywork-approval-demo.webm');await browser.close();
}
console.log('Saved artifacts/busywork-approval-demo.webm (synthetic, approximately 65 seconds).');
