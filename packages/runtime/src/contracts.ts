import {orderInput} from './order-input.js';
import {internalReadInput} from './internal-read-input.js';
import {backlogInput} from './backlog-input.js';
import {businessEntityInput} from './business-entities.js';
import {emailDraftSchema} from './email-provider.js';
import { z } from "zod";
import { usdPattern } from "@hive/core";

export const usd = z.string().regex(usdPattern, 'Use a nonnegative USD decimal string such as "0" or "12.50", with no currency symbol and at most six fractional digits.');
export const text = z.string().trim().min(1).max(12000);
export const shortText = z.string().trim().min(1).max(250);
export const timestamp = z.iso.datetime();
export const providerTestSchema = z.object({status:z.literal('ok')}).strict();
export const taskInput = z.object({
  objective: text, role: shortText.default("CEO"), budgetUsd: usd.default("1.00"),
  tokenBudget: z.number().int().min(100).max(1000000).default(60000),
  ttlMinutes: z.number().int().min(1).max(10080).default(120),
  modelId: shortText.default("mock-worker"), reviewModelId: shortText.optional(),
  parentId: shortText.optional(), employeeId: shortText.optional(),experimentId:shortText.optional()
}).strict();
export const planSchema = z.object({
  understanding: text, steps: z.array(shortText).min(1).max(10),
  estimatedCostUsd: usd, toolsNeeded: z.array(shortText).max(10), successCheck: text,
  hiringNeeds:z.array(z.object({role:shortText,requirements:shortText,desiredTraits:z.object({caution:z.number().int().min(1).max(5),rigor:z.number().int().min(1).max(5),dissent:z.number().int().min(1).max(5),initiative:z.number().int().min(1).max(5),thrift:z.number().int().min(1).max(5)}).strict()}).strict()).max(3).default([])
}).strict();
export const commercialArtifactSchema = z.object({
  title: shortText, summary: text, customer: text, problem: text, offer: text,
  channel: text, priceHypothesis: shortText,
  evidence: z.array(z.object({ source: shortText, observation: text, kind: z.enum(["OBSERVATION", "INFERENCE", "HYPOTHESIS"]) }).strict()).max(20),
  validationTest: text, successCriteria: text, killCriteria: text,
  estimatedTestCostUsd: usd, ownerActions: z.array(text).max(10), limitations: z.array(text).min(1).max(10),
  deliverables:z.array(z.object({filename:z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),mediaType:z.string().min(1).max(100),content:z.string().min(1).max(50000)}).strict()).max(10).default([]),
  readRequest:internalReadInput.nullish(),
  operations: z.array(z.object({
    type:z.enum(["PROPOSE_DEPARTMENT","CANCEL_ASSIGNED_WORK","SAVE_ORDER","READ_ORDER","SCHEDULE_BACKLOG_WORK","CANCEL_BACKLOG_SCHEDULE","READ_CONSULTATIONS","READ_ACCOUNTING","READ_LEDGER_ENTRY","LINK_TASK_EXPERIMENT","READ_BACKLOG","PLAN_WORK","START_BACKLOG_WORK","IMPORT_EMAIL_ATTACHMENT","RUN_PYTHON","FOLLOW_UP","CANCEL_FOLLOW_UP","CONFIGURE_MODEL","REGISTER_MODEL","LIST_CAPABILITIES","READ_ACTION_RESULT","REQUEST_REPLY","FIND_MESSAGES","READ_MESSAGE","RECONCILE_LOCAL_CALL","BUSINESS_ENTITY_FIND","BUSINESS_ENTITY_SET","READ_TASK_RESULT","READ_BROWSER_PAGE","WORKSPACE_COPY","WORKSPACE_WRITE","WORKSPACE_READ","WORKSPACE_LIST","BUSINESS_EMAIL_ACCESS","BUSINESS_EMAIL_SEND","BUSINESS_EMAIL_WITHDRAW","BUSINESS_EMAIL_READ","HIRE","ASSIGN_TASK","SET_MODEL","WRITE_DOCUMENT","READ_DOCUMENT","FIND_DOCUMENTS","PREPARE_RELEASE","SET_DIRECTION","MESSAGE","ESCALATION","MEETING","CREATE_EXPERIMENT","UPDATE_EXPERIMENT","READ_PUBLIC_PAGE","PROPOSE_EXTERNAL","REQUEST_OWNER","WAIT"]),
    target:shortText,title:shortText,instructions:text,budgetUsd:usd,tokenBudget:z.number().int().min(100).max(1000000),
    modelId:shortText,participants:z.array(shortText).max(20),scheduledAt:timestamp.nullable(),
    // HIRE only: which shortlisted person to bring on. Omitted, the best available fit is chosen.
    candidateId:shortText.nullish(),
    resultSection:z.enum(['summary','evidence','deliverable','operation']).nullish(),
    backlogItem:backlogInput.nullish(),
    order:orderInput.nullish(),
    workspaceSource:z.object({path:shortText,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().nullish(),
    workspaceInputs:z.array(z.object({path:shortText,name:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/)}).strict()).max(10).nullish(),
    modelSettings:z.object({model:z.string().trim().min(1).max(200),inputPerMillionUsd:usd.default('0'),outputPerMillionUsd:usd.default('0'),maxInputTokens:z.number().int().min(1000).max(1000000).default(16000),maxOutputTokens:z.number().int().min(100).max(100000).default(3000)}).strict().nullish(),
    modelProfile:z.object({name:z.string().trim().min(1).max(100),model:z.string().trim().min(1).max(200),inputPerMillionUsd:usd.default('0'),outputPerMillionUsd:usd.default('0'),maxInputTokens:z.number().int().min(1000).max(1000000).default(16000),maxOutputTokens:z.number().int().min(100).max(100000).default(3000)}).strict().nullish(),
    messageBefore:shortText.nullish(),
    consultationBefore:shortText.nullish(),
    ledgerBefore:shortText.nullish(),
    resultIndex:z.number().int().min(0).max(100).nullish(),
    resultOffset:z.number().int().min(0).max(10000000).nullish(),
    expectedVersion:z.number().int().min(0).nullish(),
    businessEntity:businessEntityInput.nullish(),
    email:emailDraftSchema.nullish(),
    orderReference:z.object({id:z.uuid(),version:z.number().int().positive()}).strict().nullish(),
    emailAccess:z.object({canRead:z.boolean(),canSend:z.boolean()}).strict().nullish(),
    releaseId:z.uuid().nullish(),
    publishingMode:z.enum(['OWNER_ASSISTED','NETLIFY_AUTOMATIC']).nullish(),
    releaseFiles:z.array(z.object({path:z.string().min(1).max(180),documentPath:z.string().min(1).max(250),version:z.number().int().min(1)}).strict()).min(1).max(50).nullish(),
    experimentId:shortText.nullish(),
    externalActionType:z.enum(["PURCHASE","SEND_MESSAGE","PUBLISH","CREATE_ACCOUNT","OTHER_EXTERNAL"]).nullish()
  }).strict()).max(8)
}).strict();
/** Commercial fields are optional for ordinary internal work. Experiment creation
 * separately validates the complete commercial brief before recording an experiment. */
export const artifactSchema = commercialArtifactSchema.extend({
  customer:text.nullish(),problem:text.nullish(),offer:text.nullish(),channel:text.nullish(),
  priceHypothesis:shortText.nullish(),validationTest:text.nullish(),successCriteria:text.nullish(),
  killCriteria:text.nullish(),estimatedTestCostUsd:usd.nullish(),
  ownerActions:z.array(text).max(10).default([])
});
export const conversationArtifactSchema = artifactSchema.pick({title:true,summary:true,limitations:true,deliverables:true,operations:true,readRequest:true}).strip();
export const reviewSchema = z.object({
  decision: z.enum(["PASS", "REVISE", "BLOCK"]), findings: z.array(text).max(10), nextAction: text
}).strict();
export const experimentInput = z.object({
  taskId: shortText.optional(), title: shortText, hypothesis: text, customer: text, offer: text,
  channel: text, price: shortText, maxLossUsd: usd, successCriteria: text, killCriteria: text, deadline: timestamp
}).strict();
export const actionInput = z.object({
  taskId: shortText.optional(), experimentId: shortText.optional(),
  actionType: z.enum(["SANDBOX_PURCHASE", "PURCHASE", "PUBLISH", "SEND_MESSAGE", "CREATE_ACCOUNT", "OTHER_EXTERNAL", "READ_PUBLIC_PAGE"]),
  target: shortText, payload: z.record(z.string(), z.unknown()), rationale: text, maxCostUsd: usd, expiresAt: timestamp
}).strict();
export const grantInput = z.object({
  actionType: z.enum(["SANDBOX_PURCHASE", "PURCHASE", "PUBLISH", "SEND_MESSAGE", "CREATE_ACCOUNT", "OTHER_EXTERNAL", "READ_PUBLIC_PAGE"]),
  target: shortText, experimentId: shortText.optional(), maxTransactionUsd: usd, totalCapUsd: usd,
  expiresAt: timestamp, rationale: text
}).strict();

export function jsonSchema(schema: z.ZodType) {
  // Describe model input before runtime normalization (e.g. null optional replies).
  return z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
}

export function formatUsd(value: bigint | string | number): string {
  const n = BigInt(value); const sign = n < 0n ? "-" : ""; const abs = n < 0n ? -n : n;
  return `${sign}${abs / 1000000n}.${(abs % 1000000n).toString().padStart(6, "0")}`;
}

/**
 * Something the owner knows that the agents should too: an asset the company already
 * owns, an account it has, or a constraint it operates under. Never credentials —
 * agents cannot use them and a compromised prompt should never carry one.
 */
export const companyRecordInput = z.object({
  kind: z.enum(["ASSET", "ACCOUNT", "CONSTRAINT", "NOTE"]),
  title: shortText,
  body: text,
}).strict();
