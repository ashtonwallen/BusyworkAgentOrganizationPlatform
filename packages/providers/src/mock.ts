import type { GenerateRequest, GenerateResult, ModelProvider } from "./provider.js";

/** Fixed test fixtures, deliberately labelled as hypotheses; never produce fake revenue. */
export class MockProvider implements ModelProvider {
  readonly providerId = "mock";
  async listModels() { return [{ provider: "mock", modelId: "mock-worker", capabilities: ["structured_output" as const] }]; }
  async generate<T = unknown>(request: GenerateRequest): Promise<GenerateResult<T>> {
    const phase = (request.input as { phase?: string }).phase;
    let output: unknown;
    if (phase === "PLAN") {
      output = {
        understanding: "Prepare a bounded offer hypothesis and a measurable buyer test.",
        steps: ["State the buyer and problem", "Design the smallest validation test", "Identify evidence still needed"],
        estimatedCostUsd: "0", toolsNeeded: [], successCheck: "A concrete offer, cost bound, and stop rule are present."
      };
    } else if (phase === "REVIEW") {
      output = {
        decision: "PASS", findings: ["Fixture artifact is clearly labelled; no market demand is claimed."],
        nextAction: "Replace fixture assumptions with current evidence before launching a commercial experiment."
      };
    } else {
      output = {
        title: "Data cleanup service — test fixture", summary: "A deterministic example to verify Hive's workflow. This is not market research.",
        customer: "Small merchants with inconsistent catalog exports", problem: "Catalog exports may contain duplicate rows and inconsistent fields.",
        offer: "Fixed-scope cleanup with a validation report and reproducible transformation recipe.",
        channel: "A business-owned service listing or relevant cleared outreach channel", priceHypothesis: "$49 fixed pilot, unvalidated",
        evidence: [{ source: "Internal test fixture", observation: "No external market evidence was gathered.", kind: "HYPOTHESIS" }],
        validationTest: "Compare existing offers and seek qualified buyer responses to one precisely scoped pilot.",
        successCriteria: "One paid pilot delivered successfully within the cost and time bound.",
        killCriteria: "No buying intent after the defined audience test, or fulfillment cost exceeds price.",
        estimatedTestCostUsd: "10", ownerActions: ["Select and authorize a specific channel after reviewing evidence."],
        limitations: ["Mock provider output; not verified demand.", "No outreach, purchase, or account action has occurred."], operations: []
      };
    }
    return {
      output: output as T, usage: { inputTokens: 100, outputTokens: 200, actualCostUsd: "0" },
      rawModelId: request.model, providerRequestId: `mock-${request.correlationId}`, latencyMs: 1
    };
  }
}
