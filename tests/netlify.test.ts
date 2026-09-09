import {it,expect,vi} from 'vitest';
import {prepareStaticRelease,NetlifyDeploymentClient} from '../packages/runtime/src/netlify.js';
const siteId='22222222-2222-4222-8222-222222222222';
const release=()=>prepareStaticRelease({siteId,files:[{path:'index.html',content:'<h1>Offline fixture</h1>'},{path:'assets/main.css',content:'body{color:black}'}]});
it('freezes a deterministic complete static release without reading host files',()=>{
 const r=release();expect(r.sha256).toBe(prepareStaticRelease({siteId,files:[...r.files].reverse().map(({path,content})=>({path,content}))}).sha256);
 for(const path of ['../secret.txt','.env','C:/secret.txt','/index.html','index.HTML']){
  expect(()=>prepareStaticRelease({siteId,files:[{path,content:'x'}]})).toThrow();
 }
 expect(()=>prepareStaticRelease({siteId,files:[{path:'index.html',content:'x'},{path:'INDEX.html',content:'y'}]})).toThrow('unique');
});
it('uploads only required frozen content and checks readiness separately from acceptance',async()=>{
 const r=release();const calls:any[]=[];const fetcher=vi.fn(async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify({id:'deploy-1',site_id:siteId,state:options?.method==='GET'?'ready':'prepared',ssl_url:'https://fixture.netlify.app',required:options?.method==='POST'?[r.files[0].sha1]:[]}));});
 const client=new NetlifyDeploymentClient('fixture-secret',fetcher as any);const accepted=await client.start(r);expect(accepted.state).toBe('prepared');await client.uploadRequired(r,accepted);const ready=await client.inspect(siteId,accepted.id);expect(ready.state).toBe('ready');
 expect(calls.map(c=>c.method)).toEqual(['POST','PUT','GET']);expect(calls.every(c=>c.redirect==='error')).toBe(true);expect(calls[1].body).toBe(r.files[0].content);expect(calls[0].body).not.toContain('fixture-secret');
});
it('rejects changed or unexpected upload content before sending it',async()=>{
 const fetcher=vi.fn();const client=new NetlifyDeploymentClient('fixture',fetcher);const r=release();r.files[0].content='changed';await expect(client.start(r)).rejects.toThrow('changed');
 await expect(client.uploadRequired(release(),{id:'deploy-1',siteId,state:'prepared',required:['a'.repeat(40)]})).rejects.toThrow('outside');expect(fetcher).not.toHaveBeenCalled();
});
it('does not repeat an uncertain creation or expose credentials in errors',async()=>{
 const fetcher=vi.fn(async()=>{throw new Error('fixture-secret');});const client=new NetlifyDeploymentClient('fixture-secret',fetcher);
 await expect(client.start(release())).rejects.toMatchObject({outcomeUncertain:true,message:expect.not.stringContaining('fixture-secret')});expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rejects an inspection receipt for another deployment on the same site',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({id:'different-id',site_id:siteId,state:'ready',required:[]})));
 await expect(new NetlifyDeploymentClient('fixture',fetcher).inspect(siteId,'expected-id')).rejects.toThrow('requested deployment ID');
});

it('checks authorization before each individual upload',async()=>{
 const r=release();let checks=0;const fetcher=vi.fn(async()=>new Response('{}'));
 const client=new NetlifyDeploymentClient('fixture',fetcher);
 await expect(client.uploadRequired(r,{id:'deploy-1',siteId,state:'prepared',required:r.files.map(f=>f.sha1)},async()=>{checks++;if(checks===2)throw new Error('paused');})).rejects.toThrow('paused');
 expect(fetcher).toHaveBeenCalledTimes(1);expect(checks).toBe(2);
});
