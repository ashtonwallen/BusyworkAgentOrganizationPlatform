// An isolated, read-only UI smoke check. Never connects to a live installation.
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../',import.meta.url));
const listener=createServer();
await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
const port=listener.address().port;
await new Promise(resolve=>listener.close(resolve));
const url=`http://127.0.0.1:${port}`;
const token='isolated-dashboard-smoke-fixture';
const onboarding=process.argv.includes('--onboarding');
const missionReview=process.argv.includes('--mission-review');
const server=spawn(process.execPath,['scripts/dev-fixture.mjs','--port',String(port),...(onboarding?['--empty']:[]),...(missionReview?['--mission-review']:[])],{
 cwd:root,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,
 HIVE_FIXTURE_TOKEN:token,HIVE_BUSINESS_EMAIL:'busywork@example.com',HIVE_COMPANY_NAME:'Example team'},
});
let output='';server.stdout.on('data',data=>{output+=data;});server.stderr.on('data',data=>{output+=data;});
let browser;
try{
 const deadline=Date.now()+60000;
 while(true){
  try{const info=await fetch(url+'/fixture-info').then(r=>r.json());assert.equal(info.synthetic,true);assert.equal(info.workersStarted,false);break;}
  catch(error){if(server.exitCode!==null||Date.now()>deadline)throw new Error('Fixture failed to start: '+output);await new Promise(r=>setTimeout(r,200));}
 }
 browser=await chromium.launch();const page=await browser.newPage();const errors=[];
 page.on('pageerror',error=>{errors.push(error.message);console.error('Dashboard error:',error.stack);});
 // The only permitted browser requests are to this disposable fixture.
 await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
 await page.goto(url);await page.locator('#owner-key').fill(token);
 await page.getByRole('button',{name:'Open dashboard',exact:true}).click();
 await page.locator('#content .page-title').waitFor();
 if(!onboarding){
  const snapshot=await page.evaluate(()=>fetch('/v1/snapshot').then(r=>r.json()));
  assert.equal(snapshot.mission.status,missionReview?'COMPLETING':'ACTIVE');
  assert.ok(snapshot.missions.some(m=>m.title==='Compare accessible meeting-note tools'&&m.status==='DRAFT'));
  assert.ok(snapshot.missions.some(m=>m.template==='content'&&m.status===(missionReview?'COMPLETING':'COMPLETED')));
 }
 if(onboarding){
  await page.getByRole('heading',{name:/^What should your team work on/}).waitFor();
  await page.locator('[data-mission-template="research"]').click();
  await page.locator('[name="title"]').fill('Synthetic research mission');
  await page.locator('[name="objective"]').fill('Answer a synthetic fixture question with recorded evidence.');
  await page.getByRole('button',{name:'Create mission',exact:true}).click();
  await page.locator('#modal').waitFor({state:'hidden'});
  await page.getByRole('heading',{name:'Synthetic research mission',exact:true}).waitFor();
  const snapshot=await page.evaluate(()=>fetch('/v1/snapshot').then(r=>r.json()));
  assert.equal(snapshot.company.status,'PAUSED');assert.equal(snapshot.mission.template,'research');
  assert.equal(snapshot.mission.status,'ACTIVE');assert.equal(snapshot.tasks.length,0);
 }

 const seeded=await page.evaluate(async()=>{const response=await fetch('/v1/documents',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'smoke/report.md',title:'Synthetic report',content:'A synthetic hypothesis for UI verification.',expectedVersion:0,claims:[{text:'Synthetic hypothesis.',kind:'HYPOTHESIS',sourceIds:[]}]})});return response.status;});
 assert.equal(seeded,200,'Synthetic document could not be created');
 const pages=await page.locator('nav [data-page]').evaluateAll(nodes=>nodes.map(node=>node.dataset.page));
 for(const name of pages){
  await page.locator(`nav [data-page="${name}"]`).click();
  await page.waitForFunction(expected=>document.querySelector('nav [aria-current="page"]')?.dataset.page===expected,name);
  assert.ok((await page.locator('#content').innerText()).trim().length>30,`${name} is blank`);
  assert.ok(await page.locator('#content .card, #content .page-title').count(),`${name} did not render`);
 }
 await page.locator('nav [data-page="documents"]').click();
 await page.locator('#content [data-document]').first().click();
 await page.getByRole('heading',{name:'Claims and citations',exact:true}).waitFor();
 if(missionReview){
  const result=await page.evaluate(async()=>{
   const snapshot=await fetch('/v1/snapshot').then(r=>r.json());
   const mission=snapshot.missions.find(m=>m.status==='COMPLETING');
   const response=await fetch('/v1/missions/completion/'+mission.completion.requestId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hash:mission.completion.hash,accept:true})});
   const after=await fetch('/v1/snapshot').then(r=>r.json());
   return {status:response.status,completed:after.missions.find(m=>m.id===mission.id).status};
  });
  assert.equal(result.status,200);assert.equal(result.completed,'COMPLETED');
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({pages:pages.length,documentDetail:true,onboarding,missionReview,browserErrors:0,synthetic:true}));
}finally{
 await browser?.close();
 if(server.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve));}
}
