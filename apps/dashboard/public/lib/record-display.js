import {state} from './state.js';
import {esc,badge,titleCase} from './format.js';
import {helpTip} from './ui.js';
const uuid=/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
export const opportunityTitle=e=>String(e?.title||'Opportunity').replace(/^DRAFT:\s*/i,'');
function entities(){
 const data=state.data||{};
 return new Map([
  ...(data.experiments||[]).map(e=>[e.id,{name:opportunityTitle(e),attribute:'data-experiment'}]),
  ...(data.requests||[]).map(r=>[r.id,{name:r.title,attribute:'data-request'}]),
  ...(data.tasks||[]).map(t=>[t.id,{name:typeof t.artifact?.title==='string'?t.artifact.title:t.role+' objective',attribute:'data-task'}]),
  ...(data.employees||[]).map(e=>[e.id,{name:e.name,attribute:'data-employee'}]),
 ]);
}
export function namedText(text){const lookup=entities();return String(text??'').replace(uuid,id=>lookup.get(id)?.name||id);}
export function linkedText(text){
 const lookup=entities(),value=String(text??'');let end=0;const parts=[];
 for(const match of value.matchAll(uuid)){parts.push(esc(value.slice(end,match.index)));const entity=lookup.get(match[0]);parts.push(entity?`<button class="text-link inline" ${entity.attribute}="${esc(match[0])}">${esc(entity.name)}</button>`:esc(match[0]));end=match.index+match[0].length;}
 parts.push(esc(value.slice(end)));return parts.join('');
}
export function objectiveTitle(task){
 const title=typeof task.artifact?.title==='string'?task.artifact.title.trim():'';
 return namedText(title||task.objective);
}
export const actionOutcomeText={
 APPROVED:'Authorized; execution has not yet been confirmed.',
 EXECUTED:'Execution was confirmed. Open the proposal for recorded evidence.',
 UNCERTAIN:'Execution could not be confirmed. It may have occurred; investigate the original attempt before retrying.',
 EXECUTING:'The action is in progress; no final result is confirmed yet.',
 REJECTED:'The owner declined this proposal.',
 AWAITING_COST:'Execution requires charge reconciliation before accounting can be finalized.',
};
export function actionOutcome(status){return badge(status,status==='EXECUTED'?'Completed':status==='REJECTED'?'Declined':titleCase(status))+helpTip(actionOutcomeText[status],titleCase(status));}
