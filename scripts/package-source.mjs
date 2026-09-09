// Package reviewed source only. Installed dependencies, data and private config
// remain local even if this command is run from a working business installation.
import {readdir,readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {resolve,relative,sep,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const topFiles=new Set(['README.md','LICENSE','SECURITY.md','CONTRIBUTING.md','CODE_OF_CONDUCT.md','CHANGELOG.md','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json','vitest.config.ts','.env.example','.gitignore','Payment_Info_Venmo_Crypto.example.txt']);
const directories=new Set(['apps','packages','tests','scripts','docs','config','.github']);
const excluded=new Set(['node_modules','dist','data','backups','artifacts','.git','coverage','test-results','playwright-report','recordings']);
const privateNames=new Set(['RESUME.md','TODO.txt','GOAL.md','OWNER_MANDATE.md','Payment_Info_Venmo_Crypto.txt','server.lock','owner-token.txt','email-token.key']);
const files=[];
async function walk(directory){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  if(excluded.has(entry.name))continue;
  const path=join(directory,entry.name),name=relative(root,path).split(sep).join('/');
  if(entry.isSymbolicLink())throw new Error('Source package refuses symlinks: '+name);
  if(entry.isDirectory()){await walk(path);continue;}
  if(privateNames.has(entry.name)||entry.name.startsWith('.env')&&entry.name!=='.env.example')throw new Error('Private file in source tree: '+name);
  if(name.startsWith('config/')&&!entry.name.includes('.example.'))continue;
  if(!entry.isFile())throw new Error('Non-regular file: '+name);
  files.push(name);
 }
}
for(const entry of await readdir(root,{withFileTypes:true})){
 if(entry.isDirectory()&&directories.has(entry.name))await walk(join(root,entry.name));
 else if(entry.isFile()&&topFiles.has(entry.name))files.push(entry.name);
}
files.sort();
const inventory=[];
for(const path of files){
 const data=await readFile(join(root,path));
 if(data.includes(Buffer.from(['-----BEGIN','PRIVATE KEY-----'].join(' '))))throw new Error('Private key material found in '+path);
 inventory.push({path,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
}
const output=resolve(root,'artifacts','source-package');
await mkdir(output,{recursive:true});
await writeFile(join(output,'source-manifest.json'),JSON.stringify({files:inventory,containsGitHistory:false,containsInstanceData:false},null,2));
await writeFile(join(output,'files.txt'),files.join('\n')+'\n');
const archive=join(output,'busywork-source-candidate.tar.gz');
execFileSync('tar',['-czf',archive,'-C',root,'-T',join(output,'files.txt')],{stdio:'inherit'});
console.log(JSON.stringify({archive,files:files.length,bytes:(await lstat(archive)).size,sha256:createHash('sha256').update(await readFile(archive)).digest('hex')}));
