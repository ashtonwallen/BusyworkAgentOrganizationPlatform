import { parseUsd, type ActionIntent, type EffectClass, type PolicyDecision } from "@hive/core";

const EFFECTS = new Set<EffectClass>([
  "READ_ONLY", "INTERNAL_REVERSIBLE", "EXTERNAL_REVERSIBLE",
  "EXTERNAL_IRREVERSIBLE", "MONEY", "ACCOUNT", "CREDENTIAL"
]);

export interface PolicyContext {
  companyStatus: "RUNNING" | "PAUSED" | "KILLED";
  dailySpendRemainingUsd: string;
  companyCapitalRemainingUsd: string;
  /** Trusted runtime inputs; never copied from a model's proposal. */
  allowedActionTypes: readonly string[];
  registeredEffects: Readonly<Record<string, EffectClass>>;
  now: Date;
}

/** Preliminary eligibility only. ALLOW is not a reservation or execution permit. */
export function evaluateAction(
  intent: ActionIntent,
  context: PolicyContext
): PolicyDecision {
  if (context.companyStatus !== "RUNNING") {
    return { decision: "DENY", reason: `Company is ${context.companyStatus}.` };
  }

  const deny = (reason: string): PolicyDecision => ({ decision: "DENY", reason });
  // Require canonical UTC timestamps; reject Date's normalization of invalid dates.
  const expiry = typeof intent.expiresAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(intent.expiresAt)
    ? Date.parse(intent.expiresAt) : NaN;
  const now = context.now.getTime();
  if (!Number.isFinite(now) || !Number.isFinite(expiry)) {
    return deny("Invalid action expiry or policy clock.");
  }
  const canonical = intent.expiresAt.replace(/(?<=:\d{2})Z$/, ".000Z");
  if (new Date(expiry).toISOString() !== canonical || expiry <= now) {
    return deny("Action intent expired or has an invalid calendar date.");
  }

  if (!EFFECTS.has(intent.effectClass) ||
      !Object.hasOwn(context.registeredEffects, intent.actionType) ||
      context.registeredEffects[intent.actionType] !== intent.effectClass) {
    return deny("Unknown action or effect class does not match the trusted tool registry.");
  }
  if (!context.allowedActionTypes.includes(intent.actionType)) {
    return deny("Agent lacks permission for this action type.");
  }
  try {
    const cost = parseUsd(intent.maxCostUsd);
    const remaining = parseUsd(intent.effectClass === "MONEY"
      ? context.companyCapitalRemainingUsd : context.dailySpendRemainingUsd);
    if (cost > remaining) return deny("Maximum action cost exceeds available budget.");
  } catch {
    return deny("Missing or invalid cost bound or available budget.");
  }
  if (intent.effectClass === "READ_ONLY" || intent.effectClass === "INTERNAL_REVERSIBLE") {
    return { decision: "ALLOW", reason: "Internal action passed preliminary checks; reserve before dispatch." };
  }
  return {
    decision: "REQUIRE_APPROVAL",
    reason: "No verified external authorization is available in this scaffold. Scoped grants are not implemented yet."
  };
}
