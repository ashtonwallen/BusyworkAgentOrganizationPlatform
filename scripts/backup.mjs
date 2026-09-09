import {mkdir,open,readFile,writeFile,readdir,lstat,copyFile,unlink,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,relative,dirname,isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase,event} from '../packages/runtime/dist/index.js';

async function files(root,sub=''){
  if((await lstat(root)).isSymbolicLink())throw new Error('Backup trees must not contain symbolic links.');
  const result=[];
  for(const entry of await readdir(join(root,sub),{withFileTypes:true})){
    const name=join(sub,entry.name),info=await lstat(join(root,name));
    if(info.isSymbolicLink())throw new Error('Backup trees must not contain symbolic links.');
    if(info.isDirectory())result.push(name+sep,...await files(root,name));
    else if(info.isFile())result.push(name);
    else throw new Error('Unsupported database file type.');
  }
  return result.sort();
}
async function inventory(root){
  const records=[];
  for(const name of await files(root)){
    if(name.endsWith(sep)){records.push({path:name.replaceAll('\\','/'),directory:true});continue;}
    const hash=createHash('sha256');let size=0;
    for await(const chunk of createReadStream(join(root,name))){hash.update(chunk);size+=chunk.length;}
    records.push({path:name.replaceAll('\\','/'),size,sha256:hash.digest('hex')});
  }
  return records;
}
async function copyTree(source,target){
  await mkdir(target);
  for(const name of await files(source)){
    if(name.endsWith(sep)){await mkdir(join(target,name),{recursive:true});continue;}
    await mkdir(dirname(join(target,name)),{recursive:true});
    await copyFile(join(source,name),join(target,name));
  }
}
async function freshDestination(source,target){
  const parent=await realpath(dirname(resolve(target)));
  const destination=join(parent,relative(dirname(resolve(target)),resolve(target)));
  const inside=relative(await realpath(source),destination);
  if(!inside||(inside!=='..'&&!inside.startsWith('..'+sep)&&!isAbsolute(inside)))throw new Error('Destination must be outside the source directory.');
  await mkdir(destination); // Deliberately fail if it already exists; never overwrite.
  return destination;
}
export async function backup(dataDirectory,destination){
  const data=await realpath(dataDirectory),lockPath=join(data,'server.lock');
  let lock;
  try{lock=await open(lockPath,'wx');}catch(error){if(error.code==='EEXIST')throw new Error('Stop Hive cleanly before backing up; server.lock must be absent.');throw error;}
  await lock.writeFile(String(process.pid));
  try{
    const target=await freshDestination(data,destination);
    await copyTree(join(data,'postgres'),join(target,'postgres'));
    const workspaceSource=join(data,'workspaces'),workspaceTarget=join(target,'workspaces');
    let workspaceExists=true;try{await lstat(workspaceSource);}catch(error){if(error.code==='ENOENT')workspaceExists=false;else throw error;}
    if(workspaceExists)await copyTree(workspaceSource,workspaceTarget);else await mkdir(workspaceTarget);
    const workspaceFiles=await inventory(workspaceTarget);
    if(workspaceExists&&JSON.stringify(await inventory(workspaceSource))!==JSON.stringify(workspaceFiles))throw new Error('Workspace changed during backup; stop all workspace writers and retry to a new destination.');
    const manifest={format:'hive-offline-backup',version:2,createdAt:new Date().toISOString(),files:await inventory(join(target,'postgres')),workspaceFiles};
    if(!manifest.files.length)throw new Error('Database backup is empty.');
    await writeFile(join(target,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
    return {directory:target,files:manifest.files.length,workspaceFiles:manifest.workspaceFiles?.filter(f=>!f.directory).length??0};
  }finally{await lock.close();await unlink(lockPath);}
}
export async function restore(backupDirectory,destination){
  const source=await realpath(backupDirectory);
  const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));
  if(manifest.format!=='hive-offline-backup'||![1,2].includes(manifest.version)||!Array.isArray(manifest.files)||!manifest.files.length)throw new Error('Unsupported or incomplete backup manifest.');
  const verify=async root=>{if(JSON.stringify(await inventory(root))!==JSON.stringify(manifest.files))throw new Error('Backup integrity verification failed.');};
  await verify(join(source,'postgres'));
  const verifyWorkspaces=async root=>{if(!Array.isArray(manifest.workspaceFiles)||JSON.stringify(await inventory(root))!==JSON.stringify(manifest.workspaceFiles))throw new Error('Workspace backup integrity verification failed.');};
  if(manifest.version===2)await verifyWorkspaces(join(source,'workspaces'));
  const target=await freshDestination(source,destination);
  const lock=await open(join(target,'server.lock'),'wx');await lock.writeFile(String(process.pid));
  try{
    await copyTree(join(source,'postgres'),join(target,'postgres'));await verify(join(target,'postgres'));
    if(manifest.version===2){await copyTree(join(source,'workspaces'),join(target,'workspaces'));await verifyWorkspaces(join(target,'workspaces'));}
    const db=await openDatabase(join(target,'postgres'));
    try{await db.transaction(async tx=>{
      await tx.query("UPDATE company SET status='PAUSED',revision=revision+1 WHERE id=1");
      await event(tx,'company.restored','company',{backupCreatedAt:manifest.createdAt,status:'PAUSED'},'owner');
    });}finally{await db.close();}
    return {directory:target,status:'PAUSED',files:manifest.files.length,workspaceFiles:manifest.workspaceFiles?.filter(f=>!f.directory).length??0};
  }finally{await lock.close();await unlink(join(target,'server.lock'));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [command,source,destination]=process.argv.slice(2);
  if(!['backup','restore'].includes(command)||!source||!destination){
    console.error('Usage: node scripts/backup.mjs backup|restore SOURCE_DIRECTORY NEW_DESTINATION_DIRECTORY');process.exitCode=1;
  }else try{console.log(JSON.stringify(await (command==='backup'?backup:restore)(source,destination)));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
