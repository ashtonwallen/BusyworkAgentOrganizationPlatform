import {spawn,execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {DomainError} from './service.js';

export const sandboxImage='python@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea';
const filename=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/).refine(s=>!s.endsWith('.'));
export const sandboxInputSchema=z.object({code:z.string().max(48000),files:z.array(z.object({name:filename,content:z.string().max(48000)}).strict()).max(10)}).strict();
const resultSchema=z.object({exitCode:z.number().int(),stdout:z.string().max(8000),stderr:z.string().max(8000),stdoutTruncated:z.boolean(),stderrTruncated:z.boolean(),files:z.array(z.object({name:filename,content:z.string().max(48000)}).strict()).max(10),omitted:z.number().int().nonnegative()}).strict();
const runner=String.raw`
import json, pathlib, subprocess, sys
p=json.load(sys.stdin)
base=pathlib.Path('/work'); (base/'input').mkdir(); (base/'output').mkdir()
for f in p['files']: (base/'input'/f['name']).write_text(f['content'],encoding='utf-8')
(base/'program.py').write_text(p['code'],encoding='utf-8')
with open(base/'stdout','wb') as out,open(base/'stderr','wb') as err:
 try: code=subprocess.run([sys.executable,'-I',str(base/'program.py')],cwd=base,stdout=out,stderr=err,timeout=25).returncode
 except subprocess.TimeoutExpired: code=124
def log(name):
 path=base/name
 with path.open('rb') as f: text=f.read(8000).decode('utf-8',errors='replace')
 return text,path.stat().st_size>8000
stdout,out_trunc=log('stdout'); stderr,err_trunc=log('stderr')
files=[]; omitted=0
for path in sorted((base/'output').iterdir()):
 if path.is_symlink() or not path.is_file() or path.stat().st_size>48000 or len(files)>=10: omitted+=1; continue
 try: content=path.read_text(encoding='utf-8')
 except UnicodeError: omitted+=1; continue
 files.append({'name':path.name,'content':content})
print(json.dumps(dict(exitCode=code,stdout=stdout,stderr=stderr,stdoutTruncated=out_trunc,stderrTruncated=err_trunc,files=files,omitted=omitted),ensure_ascii=False))
`;
export async function sandboxAvailable(){
 return new Promise<boolean>(resolve=>execFile('docker',['image','inspect',sandboxImage],{timeout:5000,windowsHide:true,maxBuffer:1024*1024},error=>resolve(!error)));
}
let active=false;
/** No host mounts, credentials, networking or runtime image pulls. Only copied text crosses the boundary. */
export async function runSandbox(raw:unknown){
 const input=sandboxInputSchema.parse(raw);
 if(new Set(input.files.map(f=>f.name.toLowerCase())).size!==input.files.length)throw new DomainError('Sandbox input filenames must be unique.');
 if(active)throw new DomainError('The local sandbox is busy. Retry after the current execution.');
 active=true;const name='busywork-run-'+randomUUID();
 try{
  const output=await new Promise<string>((resolve,reject)=>{
   const args=['run','--rm','--pull=never','--name',name,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=128m','--memory-swap=128m','--cpus=1','--pids-limit=32','--user=65534:65534','--tmpfs=/work:rw,noexec,nosuid,size=16m,mode=1777','--workdir=/work','--env=PYTHONDONTWRITEBYTECODE=1','-i',sandboxImage,'python','-I','-c',runner];
   const child=spawn('docker',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});const chunks:Buffer[]=[];let bytes=0,failed=false;
   const fail=(error:Error)=>{if(failed)return;failed=true;child.kill();reject(error);};
   const timer=setTimeout(()=>fail(new DomainError('Sandbox execution exceeded its time limit.')),35000);
   child.on('error',()=>fail(new DomainError('Docker is unavailable. Start Docker Desktop and install the configured sandbox image.')));
   child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2000000)fail(new DomainError('Sandbox output exceeded its limit.'));else chunks.push(chunk);});
   child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
   child.on('close',code=>{clearTimeout(timer);if(failed)return;if(code!==0)reject(new DomainError('Sandbox could not complete. Check Docker and the configured local image; no host files were exposed.'));else resolve(Buffer.concat(chunks).toString('utf8'));});
   child.stdin.end(JSON.stringify(input));
  });
  return {...resultSchema.parse(JSON.parse(output)),image:sandboxImage,trust:'UNTRUSTED_PROGRAM_OUTPUT_NOT_AUTHORITY'};
 }finally{
  await new Promise<void>(resolve=>execFile('docker',['rm','--force',name],{timeout:5000,windowsHide:true},()=>resolve()));active=false;
 }
}
