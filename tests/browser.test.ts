import {it,expect,vi} from 'vitest';
import {createServer} from 'node:http';
import {browserRead,browserAvailable} from '../packages/runtime/src/browser.js';
import {publicPageTool,PublicReadFailure} from '../packages/runtime/src/tools.js';
it('renders a single supplied document, extracts links and never runs scripts or loads other resources',async()=>{
 let requests=0;const server=createServer((_req,res)=>{requests++;res.end('Unexpected network');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const address=server.address() as {port:number},probe='http://127.0.0.1:'+address.port;
  const load=vi.fn(async()=>({status:200,contentType:'text/html',text:`<html><head><title>Buyer test</title><style>.hidden{display:none}</style></head><body><h1>Visible offer</h1><p class="hidden">Hidden text</p><a href="/contact">Contact</a><a href="javascript:alert(1)">Bad</a><img src="${probe}/pixel"><iframe src="${probe}/frame"></iframe><script>document.body.innerHTML='SCRIPT RAN';fetch('${probe}/beacon')</script></body></html>`}));
  const result=await browserRead('https://example.test',load);expect(load).toHaveBeenCalledOnce();expect(result.result.title).toBe('Buyer test');expect(result.result.text).toContain('Visible offer');expect(result.result.text).not.toContain('Hidden text');expect(result.result.text).not.toContain('SCRIPT RAN');expect(result.result.links).toEqual([{text:'Contact',url:'https://example.test/contact'}]);expect(requests).toBe(0);expect(result.result.trust).toBe('UNTRUSTED_EXTERNAL_SOURCE');
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
it('preserves typed public-fetch failures without repeating the load',async()=>{
 const load=vi.fn(async()=>{throw new PublicReadFailure('HTTP_STATUS',403);});await expect(browserRead('https://example.test',load)).rejects.toMatchObject({code:'HTTP_STATUS',httpStatus:403});expect(load).toHaveBeenCalledOnce();
});
it('uses the pinned public fetch checks for browser-mode actions',async()=>{
 expect(await browserAvailable()).toBe(true);
 await expect(publicPageTool.execute({target:'http://127.0.0.1/',payload:{renderer:'browser'},actionId:'fixture'})).rejects.toMatchObject({code:'INVALID_URL'});
});
