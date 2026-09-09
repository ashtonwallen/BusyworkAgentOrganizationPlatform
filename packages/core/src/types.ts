export type CompanyStatus = "RUNNING" | "PAUSED" | "KILLED";

export type AgentStatus =
  | "CREATED"
  | "PLAN_PENDING"
  | "READY"
  | "RUNNING"
  | "REVIEW"
  | "COMPLETED"
  | "BLOCKED_APPROVAL"
  | "BLOCKED_BUDGET"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

export type EffectClass =
  | "READ_ONLY"
  | "INTERNAL_REVERSIBLE"
  | "EXTERNAL_REVERSIBLE"
  | "EXTERNAL_IRREVERSIBLE"
  | "MONEY"
  | "ACCOUNT"
  | "CREDENTIAL";

export interface Money {
  amount: string;
  currency: string;
}

export interface AgentBudget {
  maxUsd: string;
  tokenBudget?: number;
  expiresAt: string;
}

export interface AgentDescriptor {
  id: string;
  roleId: string;
  parentAgentId?: string;
  taskId: string;
  depth: number;
  status: AgentStatus;
  budget: AgentBudget;
}

export interface DelegationPlan {
  understanding: string;
  steps: string[];
  expectedCalls: number;
  estimatedCostUsd: string;
  toolsNeeded: string[];
  risksOrUnknowns: string[];
  successCheck: string;
}

export interface ActionIntent {
  id: string;
  agentId: string;
  taskId?: string;
  projectId?: string;
  actionType: string;
  effectClass: EffectClass;
  target: string;
  payload: Record<string, unknown>;
  businessRationale: string;
  /** Upper bound including fees. Use "0" only for known free actions. */
  maxCostUsd: string;
  expiresAt: string;
}

export type PolicyDecision =
  | { decision: "ALLOW"; reason: string }
  | { decision: "DENY"; reason: string }
  | { decision: "REQUIRE_APPROVAL"; reason: string };
