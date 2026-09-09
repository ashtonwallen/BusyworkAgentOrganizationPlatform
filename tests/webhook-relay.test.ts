import {it,expect,vi} from 'vitest';
import {createWebhookRelay} from '../apps/api/src/webhook-relay.js';

it('exposes only the SMS callback and forwards its original signed form without owner credentials',async()=>{
  const upstream=vi.fn(async()=>new Response('<Response></Response>',{status:200}));
  const relay=createWebhookRelay('http://127.0.0.1:3001',upstream as typeof fetch);
  await new Promise<void>(resolve=>relay.listen(0,'127.0.0.1',resolve));
  const address=relay.address() as {port:number};const origin=`http://127.0.0.1:${address.port}`;
  try{
    for(const path of ['/','/v1/snapshot','/v1/auth/login','/webhooks/twilio?extra=1'])expect((await fetch(origin+path)).status).toBe(404);
    expect((await fetch(origin+'/webhooks/twilio',{method:'POST',body:'Body=APPROVE'})).status).toBe(403);expect(upstream).not.toHaveBeenCalled();
    const body='Body=APPROVE+ABC123&From=%2B15550000000&Extra=preserve%2Bthis';
    const response=await fetch(origin+'/webhooks/twilio',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':'fixture-signature',Authorization:'Bearer never-forward-owner-key',Cookie:'hive_session=private'},body});
    expect(response.status).toBe(200);expect(await response.text()).toBe('<Response></Response>');expect(upstream).toHaveBeenCalledTimes(1);
    const [url,options]=upstream.mock.calls[0] as unknown as [URL,RequestInit];expect(String(url)).toBe('http://127.0.0.1:3001/webhooks/twilio');expect(options.body).toBe(body);expect(options.headers).toEqual({'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':'fixture-signature'});
  }finally{relay.closeAllConnections();await new Promise<void>((resolve,reject)=>relay.close(error=>error?reject(error):resolve()));}
});
it('refuses a remote relay target',()=>{expect(()=>createWebhookRelay('https://example.com')).toThrow('loopback');});
