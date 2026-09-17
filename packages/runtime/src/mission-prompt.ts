import {z} from 'zod';
import {artifactSchema,conversationArtifactSchema} from './contracts.js';
import {internalReadInput} from './internal-read-input.js';
import {enabledOperations,readFamilies,requiredFamilies,requireFamilies} from './operation-families.js';

const fieldFamilies:Record<string,string[]>={campaign:['outreach'],search:['research'],documentClaims:['documents'],order:['commerce'],orderReference:['commerce'],experimentId:['commerce'],workspaceSource:['documents'],workspaceInputs:['code'],businessEntity:['outreach'],email:['outreach'],emailAccess:['outreach'],releaseId:['deployment'],publishingMode:['deployment'],releaseFiles:['deployment'],ledgerBefore:['accounting']};
export function missionArtifactSchema(enabled:readonly string[],conversation=false){
 const names=enabledOperations(enabled),base=conversation?conversationArtifactSchema:artifactSchema;
 const omitted=Object.fromEntries(Object.entries(fieldFamilies).filter(([,families])=>families.some(f=>!enabled.includes(f))).map(([key])=>[key,true]));
 let operation:any=artifactSchema.shape.operations.element.omit(omitted as any).extend({type:z.enum(names as [string,...string[]])});
 const external=['PURCHASE','SEND_MESSAGE','PUBLISH','CREATE_ACCOUNT','OTHER_EXTERNAL'].filter(type=>enabled.includes(type==='SEND_MESSAGE'?'outreach':type==='PUBLISH'?'deployment':'commerce'));
 operation=external.length?operation.extend({externalActionType:z.enum(external as [string,...string[]]).nullish()}):operation.omit({externalActionType:true});
 if(!enabled.includes('commerce'))operation=operation.extend({backlogItem:artifactSchema.shape.operations.element.shape.backlogItem.unwrap().unwrap().omit({orderId:true,experimentId:true}).nullish()});
 const reads=Object.keys(readFamilies).filter(type=>enabled.includes(readFamilies[type]));
 const result=base.extend({operations:z.array(operation).max(8),readRequest:internalReadInput.extend({type:z.enum(reads as [string,...string[]])}).nullish()});
 const neutral=!conversation&&!enabled.includes('commerce')?result.omit({customer:true,problem:true,offer:true,channel:true,priceHypothesis:true,validationTest:true,successCriteria:true,killCriteria:true,estimatedTestCostUsd:true} as any):result;
 return z.preprocess((value:any,ctx)=>{for(const [index,op] of (Array.isArray(value?.operations)?value.operations:[]).entries()){try{requireFamilies(enabled,requiredFamilies(op),op.type);}catch(error){ctx.addIssue({code:'custom',path:['operations',index],message:(error as Error).message});}}if(value?.readRequest?.type&&readFamilies[value.readRequest.type]){try{requireFamilies(enabled,[readFamilies[value.readRequest.type]],value.readRequest.type);}catch(error){ctx.addIssue({code:'custom',path:['readRequest'],message:(error as Error).message});}}return value;},neutral) as unknown as typeof artifactSchema;
}

/** Split combined legacy guide lines at operation boundaries before selecting families. */
export function missionGuide(guide:string,enabled:readonly string[],phase:string){
 const names=new Set(enabledOperations(enabled));
 const shared=guide.slice(0,guide.indexOf('RECONCILE_LOCAL_CALL:')).replace('Task token allocations are planning estimates. Track actual usage and costs; model context/output limits, spending policy, deadlines and concurrency remain enforced.','Delegated allocations must fit the parent remaining money and tokens. Track actual usage and cost; mission and provider caps, deadlines and concurrency remain enforced.');
 const tail=guide.slice(guide.indexOf('Select models for the work.'));
 if(phase==='PLAN')return `${shared}\nDuring PLAN return only the plan schema. toolsNeeded describes dependencies, not execution. Enabled operation names for later WORK: ${[...names].join(', ')}. Installed adapters and employee permissions still determine availability.\n${tail}`;
 const body=guide.slice(guide.indexOf('RECONCILE_LOCAL_CALL:'),guide.indexOf('Select models for the work.'));
 const chunks=body.replace(/(?<![A-Z_])([A-Z][A-Z_]+(?:\/[A-Z_]+)*):/g,'\n$1:').split('\n');
 const selected=chunks.filter(line=>{
  const match=line.match(/^([A-Z][A-Z_/]+):/);if(match)return match[1].split('/').some(name=>names.has(name));
  if(line.startsWith('Research deliverables:'))return enabled.includes('research')&&enabled.includes('documents');
  return !line.startsWith('WORK operations:');
 });
 // Free-standing combined PROPOSE_EXTERNAL instructions include deployment specifics.
 const filtered=selected.map(line=>!enabled.includes('commerce')&&line.startsWith('PLAN_WORK:')?'PLAN_WORK: target=new or backlog UUID; backlogItem={title,instructions,successCriteria,priority:HIGH|NORMAL|LOW,employeeId,dependsOn:[],cancelled:false,expectedVersion:0 for new or the current version}. Plan distinct work, inspect existing backlog to avoid duplicates, and read the current version before editing. Planning alone starts no task.':line.startsWith('PROPOSE_EXTERNAL:')?`PROPOSE_EXTERNAL: externalActionType=${[enabled.includes('outreach')?'SEND_MESSAGE':null,enabled.includes('commerce')?'PURCHASE|CREATE_ACCOUNT|OTHER_EXTERNAL':null,enabled.includes('deployment')?'PUBLISH':null].filter(Boolean).join('|')}; target=exact destination, instructions=complete proposed action, budgetUsd=maximum charge. Approval alone does not execute an action. ${enabled.includes('deployment')?'For PUBLISH bind releaseId to its exact site target; NETLIFY_AUTOMATIC requires hosting.ready, hosting.siteId and hosting.maxDeploymentUsd. Otherwise use OWNER_ASSISTED.':''}`:line);
 return [shared,...filtered,tail].join('\n');
}
export function missionSystem(base:string,enabled:readonly string[]){
 const start=base.indexOf('During WORK you may set readRequest='),end=base.indexOf('For a plan, toolsNeeded');
 const reads=Object.keys(readFamilies).filter(type=>enabled.includes(readFamilies[type]));
 const retrieval=`During WORK use readRequest={type:${reads.join('|')},target,offset:0,version:null,before:null,section:summary,index:0} for local retrieval. Keep operations and deliverables empty during a read and retain working notes in summary. Use target=* or literal search text for discovery; target=existing ID/path for records. Follow nextOffset/nextBefore and matching hashes to read all pages; previews are not inspected content. ${enabled.includes('documents')?'DOCUMENT uses exact version or null for latest; WORKSPACE uses private/path or shared/path. ':''}TASK_RESULT section selects summary/evidence/deliverable/operation. ACTION_RESULT never retries execution. Set readRequest=null for finished work. Existing access, call costs, deadlines and approvals still apply.\n`;
 return (base.slice(0,start)+retrieval+base.slice(end)).replace('Task dollar budgets and plan costs are estimates, not spending permission or ceilings. Actual spending follows company caps and approval gates. Token limits still bound execution.','Root task costs are estimates; delegated work cannot exceed its parent remaining money or tokens. Mission and provider spending caps and approval gates remain binding.');
}
export function filterMissionContext(input:Record<string,unknown>,enabled:readonly string[]){
 const fields:Record<string,string[]>={commerce:['experiments','customerOrders','orderAttention','experimentEconomics'],outreach:['businessEntities','businessEmail'],research:['search','browser','sourceRecords'],documents:['workspace','referencedDocuments','sharedDocuments'],deployment:['hosting','publishingReleases'],accounting:['ownerEffort']};
 for(const [family,keys] of Object.entries(fields))if(!enabled.includes(family))for(const key of keys)delete input[key];
}
