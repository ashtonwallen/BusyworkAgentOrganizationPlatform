import {createHash} from 'node:crypto';
import {z} from 'zod';

const pathSchema=z.string().min(1).max(180).refine(path=>
  !path.startsWith('/') && !path.includes('\\') && path.split('/').every(segment=>/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment) && segment!=='.' && segment!=='..') &&
  /\.(html|css|js|txt|json|svg|xml|webmanifest)$/i.test(path), 'Use a relative static-file path.');
const manifestSchema=z.object({
  siteId:z.string().uuid(),
  files:z.array(z.object({path:pathSchema,content:z.string().max(100000)}).strict()).min(1).max(50)
}).strict();
export interface StaticRelease {siteId:string;files:{path:string;content:string;sha1:string}[];sha256:string;}
/** Pure preparation only: no file reads, build scripts, credentials, or external requests. */
export function prepareStaticRelease(raw:unknown):StaticRelease {
  const input=manifestSchema.parse(raw);
  const paths=input.files.map(file=>file.path.toLowerCase());
  if(new Set(paths).size!==paths.length)throw new Error('Release paths must be unique, including case.');
  if(!input.files.some(file=>file.path==='index.html'))throw new Error('A static release requires index.html.');
  if(input.files.reduce((sum,file)=>sum+Buffer.byteLength(file.content,'utf8'),0)>500000)throw new Error('Release exceeds the 500 KB upload allowance.');
  const files=input.files.map(file=>({...file,sha1:createHash('sha1').update(file.content).digest('hex')})).sort((a,b)=>a.path.localeCompare(b.path,'en'));
  return {siteId:input.siteId,files,sha256:createHash('sha256').update(JSON.stringify({siteId:input.siteId,files})).digest('hex')};
}
export class DeploymentTransportError extends Error {
  constructor(message:string,readonly outcomeUncertain:boolean){super(message);}
}
const idSchema=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export interface DeploymentState {id:string;siteId:string;state:string;url?:string;required:string[];}
/** Transport foundation. The durable gateway must persist start() before uploading,
 * and retain an uncertain POST rather than automatically calling start() again.
 * No method returns a fabricated deployment price or treats acceptance as publication. */
export class NetlifyDeploymentClient {
  constructor(private readonly token:string,private readonly fetcher:typeof fetch=fetch){if(!token.trim())throw new Error('Netlify access token is required.');}
  private async request(path:string,method:string,body?:string,contentType='application/json') {
    let response:Response;
    try{response=await this.fetcher(`https://api.netlify.com/api/v1${path}`,{method,headers:{Authorization:`Bearer ${this.token}`,'Content-Type':contentType},body,redirect:'error',signal:AbortSignal.timeout(20000)});}
    catch{throw new DeploymentTransportError('Deployment request ended without a confirmed response.',method!=='GET');}
    if(!response.ok)throw new DeploymentTransportError(`Deployment provider returned HTTP ${response.status}.`,method!=='GET' && ![400,401,403,404,422,429].includes(response.status));
    return response;
  }
  private async state(response:Response,siteId:string):Promise<DeploymentState>{
    let raw:any;try{raw=await response.json();}catch{throw new DeploymentTransportError('Deployment provider returned an unreadable receipt.',true);}
    if(!idSchema.safeParse(raw.id).success || raw.site_id!==siteId || typeof raw.state!=='string' || !Array.isArray(raw.required??[]) || !(raw.required??[]).every((hash:unknown)=>typeof hash==='string'&&/^[a-f0-9]{40}$/.test(hash)))throw new DeploymentTransportError('Deployment receipt did not match the expected site or format.',true);
    let url:string|undefined;
    const receiptUrl=raw.deploy_ssl_url ?? raw.ssl_url;
    if(typeof receiptUrl==='string'){try{const parsed=new URL(receiptUrl);if(parsed.protocol==='https:'&&!parsed.username&&!parsed.password)url=parsed.href;}catch{}}
    return {id:raw.id,siteId,state:raw.state,url,required:raw.required??[]};
  }
  async start(release:StaticRelease):Promise<DeploymentState>{
    const checked=prepareStaticRelease({siteId:release.siteId,files:release.files.map(({path,content})=>({path,content}))});
    if(checked.sha256!==release.sha256)throw new Error('Release content changed after preparation.');
    const response=await this.request(`/sites/${checked.siteId}/deploys`,'POST',JSON.stringify({files:Object.fromEntries(checked.files.map(file=>[`/${file.path}`,file.sha1])),draft:false}));
    return this.state(response,checked.siteId);
  }
  async uploadRequired(release:StaticRelease,deployment:DeploymentState,beforeUpload?:()=>Promise<void>):Promise<void>{
    idSchema.parse(deployment.id);
    const checked=prepareStaticRelease({siteId:release.siteId,files:release.files.map(({path,content})=>({path,content}))});
    if(checked.sha256!==release.sha256 || deployment.siteId!==checked.siteId)throw new Error('Deployment does not match the prepared release.');
    const required=[...new Set(deployment.required)];
    if(required.some(hash=>!checked.files.some(file=>file.sha1===hash)))throw new Error('Deployment requested content outside the approved release.');
    for(const hash of required){await beforeUpload?.();const file=checked.files.find(file=>file.sha1===hash)!;await this.request(`/deploys/${deployment.id}/files/${file.path.split('/').map(encodeURIComponent).join('/')}`,'PUT',file.content,'application/octet-stream');}
  }
  async inspect(siteId:string,deploymentId:string):Promise<DeploymentState>{
    z.string().uuid().parse(siteId);idSchema.parse(deploymentId);
    const receipt=await this.state(await this.request(`/deploys/${deploymentId}`,'GET'),siteId);
    if(receipt.id!==deploymentId)throw new DeploymentTransportError('Deployment receipt did not match the requested deployment ID.',true);
    return receipt;
  }
}
