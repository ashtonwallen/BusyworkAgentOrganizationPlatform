import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runSandbox} from '../packages/runtime/src/sandbox.js';
import {openDatabase,HiveService,createModels,Organization,Workspaces} from '../packages/runtime/src/index.js';
import {MockProvider} from '../packages/providers/src/index.js';

it.skipIf(process.env.HIVE_SANDBOX_TEST!=='1')('executes reviewed Python transformations in Docker with no host credentials, network, or writable root',async()=>{
 const db=await openDatabase(),root=await mkdtemp(join(tmpdir(),'busywork-sandbox-test-'));try{
  const service=new HiveService(db,createModels({}));service.workspaces=new Workspaces(root);service.sandboxReady=true;
  const org=new Organization(service),ceo=await db.transaction(tx=>org.ensureCEO(tx));
  const code=`import csv,json,os,pathlib,socket
assert os.getuid()==65534
assert 'HIVE_SANDBOX_TEST' not in os.environ
assert 'OPENAI_API_KEY' not in os.environ
try:
 pathlib.Path('/etc/busywork-test').write_text('not allowed')
 raise AssertionError('root writable')
except (PermissionError,OSError): pass
try:
 s=socket.create_connection(('1.1.1.1',443),timeout=0.2)
 s.close()
 raise AssertionError('network available')
except OSError: pass
rows=list(csv.DictReader(open('input/data.csv')))
unique=sorted(set(r['name'].strip() for r in rows))
pathlib.Path('output/cleaned.csv').write_text('name\\n'+'\\n'.join(unique)+'\\n')
print(json.dumps({'input':len(rows),'unique':len(unique)}))
`;
  await service.workspaces.write(ceo.id,'clean.py',code);await service.workspaces.write(ceo.id,'data.csv','name\nAlice\nBob\nAlice\n');
  const source=await service.createTask({objective:'Clean copied CSV',employeeId:ceo.id});const artifact=(await new MockProvider().generate({input:{phase:'WORK'}} as any)).output as any;
  artifact.operations=[{type:'RUN_PYTHON',target:'private/clean.py',title:'Clean CSV',instructions:'Transform copied input only.',workspaceInputs:[{path:'private/data.csv',name:'data.csv'}],budgetUsd:'0',tokenBudget:60000,modelId:'mock-worker',participants:[],scheduledAt:null}];
  await db.query("UPDATE tasks SET status='COMPLETED',artifact=$2 WHERE id=$1",[source.id,JSON.stringify(artifact)]);await service.setStatus('RUNNING');await org.applyOperations(source.id);await org.applyOperations(source.id);
  const messages=(await db.query("SELECT body FROM messages WHERE task_id=$1 AND subject='Python execution result'",[source.id])).rows;expect(messages).toHaveLength(1);
  const result=JSON.parse(messages[0]!.body);expect(result.exitCode).toBe(0);expect(JSON.parse(result.stdout)).toEqual({input:3,unique:2});expect(result.files).toHaveLength(1);
  expect((await service.workspaces.read(ceo.id,result.files[0].path)).content).toBe('name\nAlice\nBob\n');expect((await db.query('SELECT * FROM calls')).rows).toHaveLength(0);
  const timed=await runSandbox({code:'while True: pass',files:[]});expect(timed.exitCode).toBe(124);
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});
