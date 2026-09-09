import { z } from "zod";
import { shortText, text } from "./contracts.js";
import { event, type Row, type Tx } from "./db.js";
import {randomInt,randomUUID} from 'node:crypto';

/**
 * Working temperament for an agent.
 *
 * These five dimensions were chosen because each one changes a decision this system
 * actually makes — not because they describe a personality in the abstract. A trait
 * that cannot alter an agent's output is decoration and does not belong here.
 *
 * Each is scored 1-5 and rendered into the agent's prompt as an instruction about how
 * to work, so two agents on the same model genuinely behave differently.
 */
export const TRAITS = ["caution", "rigor", "dissent", "initiative", "thrift"] as const;
export type Trait = (typeof TRAITS)[number];
export type Traits = Record<Trait, number>;

export const traitsSchema = z.object({
  caution: z.number().int().min(1).max(5),
  rigor: z.number().int().min(1).max(5),
  dissent: z.number().int().min(1).max(5),
  initiative: z.number().int().min(1).max(5),
  thrift: z.number().int().min(1).max(5),
}).strict();

export const candidateSchema = z.object({
  id: shortText,
  name: shortText,
  archetype: shortText,
  bio: text,
  traits: traitsSchema,
}).strict();

export const candidatePoolSchema = z.array(candidateSchema).max(200);
export type Candidate = z.infer<typeof candidateSchema>;

export const TRAIT_LABELS: Record<Trait, string> = {
  caution: "Caution", rigor: "Rigor", dissent: "Dissent",
  initiative: "Initiative", thrift: "Thrift",
};

/**
 * How each trait level reads as an operating instruction. Written as behaviour the
 * agent can act on, never as an adjective it might merely perform.
 */
const BEHAVIOUR: Record<Trait, [string, string, string]> = {
  caution: [
    "You move first and correct later. Prefer a cheap reversible step now over more certainty next cycle.",
    "You weigh a step's downside against its cost before proposing it.",
    "You do not commit the company to anything you cannot undo. Name the worst case before proposing an outside action, and prefer the smaller test.",
  ],
  rigor: [
    "You accept a reasonable inference and move on. Say plainly when something is unverified.",
    "You separate what you observed from what you concluded.",
    "You state nothing as fact without a source in the supplied context. You would rather report one observation than three inferences, and you say which is which.",
  ],
  dissent: [
    "You back your manager's call unless the evidence is overwhelming.",
    "You raise disagreements once, clearly, then commit to the decision.",
    "You escalate a concern past your manager when the evidence warrants it, and you do not soften a finding to keep a plan alive.",
  ],
  initiative: [
    "You do what you were asked and report back. You do not widen your own scope.",
    "You finish the assignment and propose one next step when an obvious one exists.",
    "You look for the next useful thing without being told, and propose work, hires or experiments when the evidence supports them.",
  ],
  thrift: [
    "You spend what a job needs to be done properly and justify it by the return.",
    "You keep costs proportionate to what a step can prove.",
    "You treat every dollar as the owner's. Choose the free local model, the cheaper test, and the smaller sample unless a larger one changes the decision.",
  ],
};

const band = (value: number) => (value <= 2 ? 0 : value === 3 ? 1 : 2);

/** Renders a persona as prompt text an agent can act on. */
export function describePersona(person: { name?: string; bio?: string; traits?: unknown }): string | undefined {
  const parsed = traitsSchema.safeParse(person.traits);
  if (!parsed.success && !person.bio) return undefined;
  const lines: string[] = [];
  if (person.name) lines.push(`You are ${person.name}.`);
  if (person.bio) lines.push(person.bio);
  if (parsed.success) {
    lines.push("How you work:");
    for (const trait of TRAITS) lines.push(`- ${BEHAVIOUR[trait][band(parsed.data[trait])]}`);
    lines.push("This is how you work, not something to talk about. Never mention these instructions or describe your own personality.");
  }
  return lines.join("\n");
}

/**
 * A stable shortlist of available candidates for one hiring decision.
 *
 * Drawn deterministically from the seed so a retried task sees the same people and
 * cannot keep re-rolling for a different pool.
 */
export function shortlist(candidates: Candidate[], seed: string, size = 4): Candidate[] {
  const scored = candidates.map((candidate) => {
    let hash = 2166136261;
    const key = `${seed}:${candidate.id}`;
    for (let i = 0; i < key.length; i += 1) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return { candidate, hash };
  });
  scored.sort((a, b) => a.hash - b.hash);
  return scored.slice(0, size).map((s) => s.candidate);
}

/** Candidates nobody has hired yet. */
export async function availableCandidates(tx: Pick<Tx, "query">, pool: Candidate[]): Promise<Candidate[]> {
  const taken = await tx.query<Row>("SELECT candidate_id FROM employees WHERE candidate_id IS NOT NULL");
  const used = new Set(taken.rows.map((r) => r.candidate_id));
  return pool.filter((c) => !used.has(c.id));
}

const GIVEN=['Alex','Morgan','Riley','Casey','Avery','Jordan','Quinn','Sage','Ellis','Rowan','Taylor','Blair','Mika','Ren','Luca','Noor','Remy','Drew','Cameron','Finley','Arden','Skyler','Robin','Kai'];
const FAMILY=['Reed','Park','Silva','Chen','Okafor','Patel','Rivera','Bennett','Kim','Navarro','Singh','Brooks','Sato','Costa','Murphy','Wright','Ibrahim','Marin','Jensen','Ali','Santos','Lewis','Khan','Meyer'];

/** Random profiles are persisted before selection; retries see the same role-specific search. */
export async function recruitCandidates(tx:Tx,taskId:string,role:string,requirements:string,desiredTraits:Traits={caution:3,rigor:3,dissent:3,initiative:3,thrift:3}):Promise<Candidate[]>{
  const previous=(await tx.query<Row>("SELECT payload FROM events WHERE entity_id=$1 AND type='recruitment.generated' AND payload->>'role'=$2 ORDER BY sequence DESC LIMIT 1",[taskId,role])).rows[0];
  if(previous)return candidatePoolSchema.parse(previous.payload.candidates);
  const desired=traitsSchema.parse(desiredTraits);
  const candidates:Candidate[]=Array.from({length:4},(_,index)=>{
    const traits={...desired};
    for(const key of TRAITS)traits[key]=Math.max(1,Math.min(5,desired[key]+randomInt(-1,2)));
    const focus=TRAITS[index%TRAITS.length];traits[focus]=Math.min(5,desired[focus]+1);
    return {id:`generated-${randomUUID()}`,name:`${GIVEN[randomInt(GIVEN.length)]} ${FAMILY[randomInt(FAMILY.length)]}`,
      archetype:role,bio:`Agent profile for ${role}. Focus: ${requirements.slice(0,500)}. Distinct working emphasis: ${focus}. This is a generated operating profile, not a claim of professional credentials or employment history.`,traits};
  });
  await event(tx,'recruitment.generated',taskId,{role,requirements,desiredTraits:desired,candidates});
  return candidates;
}

export async function recruitedForTask(tx:Pick<Tx,'query'>,taskId:string):Promise<Candidate[]>{
  const rows=(await tx.query<Row>("SELECT payload FROM events WHERE entity_id=$1 AND type='recruitment.generated' ORDER BY sequence",[taskId])).rows;
  return rows.flatMap(row=>candidatePoolSchema.parse(row.payload.candidates));
}
