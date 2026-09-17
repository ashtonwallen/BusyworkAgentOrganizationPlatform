import {one,type Tx} from './db.js';
import {currentMission} from './missions.js';
import {requireFamilies,requiredFamilies,externalFamily,readFamilies} from './operation-families.js';
import {DomainError} from './service.js';
export async function assertMissionCapability(tx:Pick<Tx,'query'>,missionId:string|null|undefined,needed:string[],operation:string){
 const mission=missionId?await one(tx,'SELECT capabilities FROM missions WHERE id=$1',[missionId]):await currentMission(tx);
 try{requireFamilies(mission?.capabilities??[],needed,operation);}catch(error){throw new DomainError((error as Error).message);}
}
export async function assertMissionOperation(tx:Pick<Tx,'query'>,missionId:string|null|undefined,operation:Parameters<typeof requiredFamilies>[0]){
 await assertMissionCapability(tx,missionId,requiredFamilies(operation),operation.type);
}
export async function assertMissionExternal(tx:Pick<Tx,'query'>,missionId:string|null|undefined,type:string){await assertMissionCapability(tx,missionId,[externalFamily(type)],type);}
export async function assertMissionRead(tx:Pick<Tx,'query'>,type:string){await assertMissionCapability(tx,null,[readFamilies[type]],type);}
