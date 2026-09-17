/** Pure registry shared by prompt/schema construction and execution guards. */
export const families={
 core:['COMPLETE_MISSION','PROPOSE_DEPARTMENT','CANCEL_ASSIGNED_WORK','SCHEDULE_BACKLOG_WORK','CANCEL_BACKLOG_SCHEDULE','READ_CONSULTATIONS','READ_BACKLOG','PLAN_WORK','START_BACKLOG_WORK','FOLLOW_UP','CANCEL_FOLLOW_UP','CONFIGURE_MODEL','REGISTER_MODEL','LIST_CAPABILITIES','READ_ACTION_RESULT','REQUEST_REPLY','FIND_MESSAGES','READ_MESSAGE','RECONCILE_LOCAL_CALL','READ_TASK_RESULT','HIRE','ASSIGN_TASK','SET_MODEL','SET_DIRECTION','MESSAGE','ESCALATION','MEETING','REQUEST_OWNER','WAIT'],
 documents:['WORKSPACE_COPY','WORKSPACE_WRITE','WORKSPACE_READ','WORKSPACE_LIST','WRITE_DOCUMENT','READ_DOCUMENT','FIND_DOCUMENTS'],
 research:['READ_SOURCE','SEARCH_WEB','READ_BROWSER_PAGE','READ_PUBLIC_PAGE'],
 outreach:['IMPORT_EMAIL_ATTACHMENT','BUSINESS_ENTITY_FIND','BUSINESS_ENTITY_SET','BUSINESS_EMAIL_ACCESS','BUSINESS_EMAIL_SEND','BUSINESS_EMAIL_WITHDRAW','BUSINESS_EMAIL_READ'],
 commerce:['SAVE_ORDER','READ_ORDER','CREATE_EXPERIMENT','UPDATE_EXPERIMENT','LINK_TASK_EXPERIMENT'],
 accounting:['READ_ACCOUNTING','READ_LEDGER_ENTRY'],code:['RUN_PYTHON'],deployment:['PREPARE_RELEASE'],
} as const;
export type Family=keyof typeof families;
export const allFamilies=Object.keys(families) as Family[];
export const operationFamilies=Object.fromEntries(Object.entries(families).flatMap(([family,names])=>names.map(name=>[name,family]))) as Record<string,Family>;
export const readFamilies:Record<string,Family>={DOCUMENT:'documents',DOCUMENT_FIND:'documents',WORKSPACE:'documents',WORKSPACE_LIST:'documents',MESSAGE:'core',MESSAGE_FIND:'core',STAFF_FIND:'core',TASK_RESULT:'core',ACTION_RESULT:'core',BACKLOG:'core',EMAIL:'outreach',EMAIL_INBOX:'outreach',EMAIL_FIND:'outreach',ENTITY_FIND:'outreach',ORDER:'commerce',ORDER_FIND:'commerce'};
export function externalFamily(type:string):Family{
 if(['READ_PUBLIC_PAGE','SEARCH_WEB','READ_BROWSER_PAGE'].includes(type))return 'research';
 if(type==='SEND_MESSAGE')return 'outreach';if(type==='PUBLISH')return 'deployment';
 if(['PURCHASE','SANDBOX_PURCHASE','CREATE_ACCOUNT','OTHER_EXTERNAL'].includes(type))return 'commerce';
 if(type==='MODEL_CALL')return 'core';throw new Error('Unknown external operation: '+type);
}
export function requiredFamilies(op:{type:string;externalActionType?:string|null;orderReference?:unknown;experimentId?:unknown;order?:unknown;backlogItem?:any;email?:any}):Family[]{
 const family=op.type==='PROPOSE_EXTERNAL'?externalFamily(op.externalActionType??'OTHER_EXTERNAL'):operationFamilies[op.type];
 if(!family)throw new Error('Unknown operation: '+op.type);
 const needed=new Set<Family>([family]);
 if(op.orderReference||op.experimentId||op.backlogItem?.orderId||op.backlogItem?.experimentId)needed.add('commerce');
 if(op.email?.documentAttachments?.length||op.email?.workspaceAttachments?.length||op.type==='RUN_PYTHON'||op.type==='IMPORT_EMAIL_ATTACHMENT'||op.type==='PREPARE_RELEASE')needed.add('documents');
 return [...needed];
}
export function requireFamilies(enabled:readonly string[],needed:readonly string[],operation:string){
 const missing=needed.filter(family=>!enabled.includes(family));if(missing.length)throw new Error(`${operation} requires disabled mission capability: ${missing.join(', ')}.`);
}
export function enabledOperations(enabled:readonly string[]){return Object.entries(operationFamilies).filter(([,family])=>enabled.includes(family)).map(([name])=>name).concat(enabled.some(f=>['outreach','commerce','deployment'].includes(f))?['PROPOSE_EXTERNAL']:[]);}
