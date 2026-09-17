// Synthetic scenarios only. No worker, provider or network dispatch.
import {createMission,activateMission,writeDocument,confirmMissionCompletion,missionTemplates} from '../packages/runtime/dist/index.js';
import {requestMissionCompletion} from '../packages/runtime/dist/mission-lifecycle.js';

export async function seedMissionExamples(service,{review=false}={}) {
  const db=service.db;
  // Temporarily park the populated business fixture while recording a finite example.
  await db.query("UPDATE missions SET status='STOPPED',onboarding_completed=true WHERE id='legacy-business'");
  const template=missionTemplates.find(t=>t.id==='content');
  const {id}=await createMission(service,{
    template:template.id,title:'Prepare a volunteer onboarding checklist',
    objective:'Produce an internal checklist for welcoming a new volunteer; identify assumptions for the coordinator.',
    definitionOfDone:['Deliver a versioned checklist with an explicit quality check and limitations.'],
    boundaries:'Synthetic demonstration. No real contacts, purchases or external execution.',
    kind:'FINITE',budgetUsd:'5.00',capabilities:template.capabilities,deliverable:'An onboarding checklist and quality note',
  });
  await activateMission(service,id);
  const request=await db.transaction(async tx=>{
    await tx.query(`INSERT INTO tasks(id,root_id,objective,role,depth,status,phase,budget,token_budget,expires_at,model_id,review_model_id,employee_id)
      VALUES('fixture-mission-task','fixture-mission-task','Prepare and check the volunteer checklist','CEO',0,'COMPLETED','REVIEW',5000000,60000,now()+interval '1 day','mock-worker','mock-worker','ceo')`);
    const doc=await writeDocument(tx,{
      path:'deliverables/volunteer-checklist.md',title:'Volunteer onboarding checklist (synthetic)',expectedVersion:0,
      content:'# Volunteer onboarding checklist\n\n- Confirm the volunteer has a named coordinator.\n- Explain the shift and escalation route.\n- Review the role-specific safety guidance.\n- Arrange a first-shift check-in.\n\n## Quality check\nEach step names an observable action. No contact has been made.\n\n## Limitations\nThis illustrative checklist has not been validated with an actual organization. Local requirements need review.',
      claims:[{text:'A named coordinator may reduce confusion on a first shift.',kind:'HYPOTHESIS',sourceIds:[]}],
    },'ceo','fixture-mission-task');
    const task=(await tx.query("SELECT * FROM tasks WHERE id='fixture-mission-task'")).rows[0];
    return requestMissionCompletion(tx,task,{conditions:[{conditionIndex:0,evidence:[{kind:'DOCUMENT',id:doc.path,version:doc.version}]}],deliverable:{path:doc.path,version:doc.version}});
  });
  if(!review){
    await confirmMissionCompletion(service,request.id,request.hash,true);
    await db.query("UPDATE missions SET status='ACTIVE',budget=50000000,objective=$1,boundaries=$2 WHERE id='legacy-business'",[
      'Validate a permit-expiry digest with a small, paid customer test.',
      'Synthetic demonstration. Every expense and external action requires owner approval.',
    ]);
  }
  const research=missionTemplates.find(t=>t.id==='research');
  await createMission(service,{template:research.id,title:'Compare accessible meeting-note tools',objective:'Compare three tools against a documented accessibility checklist.',definitionOfDone:research.definitionOfDone,boundaries:'Use recorded public sources; no outreach or purchases.',kind:research.kind,budgetUsd:'10.00',capabilities:research.capabilities,deliverable:research.deliverable});
}
