import {createServer,type Server} from 'node:http';

/** A public tunnel can target this listener without exposing the owner API or dashboard. */
export function createWebhookRelay(targetOrigin:string,fetcher:typeof fetch=fetch):Server {
  const target=new URL(targetOrigin);
  if(target.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.username||target.password||target.pathname!=='/'||target.search||target.hash)throw new Error('Webhook relay target must be a loopback HTTP origin.');
  const server=createServer(async(request,response)=>{
    response.setHeader('Cache-Control','no-store');
    if(request.url!=='/webhooks/twilio'||request.method!=='POST'){response.writeHead(404);response.end();return;}
    const signature=request.headers['x-twilio-signature'];
    if(typeof signature!=='string'||signature.length>256){response.writeHead(403);response.end();return;}
    if(!String(request.headers['content-type']??'').toLowerCase().startsWith('application/x-www-form-urlencoded')){response.writeHead(415);response.end();return;}
    const chunks:Buffer[]=[];let bytes=0;
    try{
      for await(const chunk of request){
        bytes+=chunk.length;
        if(bytes>32768){response.writeHead(413);response.end();return;}
        chunks.push(Buffer.from(chunk));
      }
      const result=await fetcher(new URL('/webhooks/twilio',target),{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':signature},
        body:Buffer.concat(chunks).toString('utf8'),redirect:'error',signal:AbortSignal.timeout(10000),
      });
      // The API authenticates the complete callback. Forward only its acknowledgement.
      response.writeHead(result.status,{'Content-Type':'text/xml; charset=utf-8'});
      response.end(result.ok?'<Response></Response>':'');
      await result.body?.cancel();
    }catch{if(!response.headersSent)response.writeHead(502);response.end();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxConnections=32;
  return server;
}
