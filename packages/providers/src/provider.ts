export type Capability =
  | "structured_output"
  | "tool_use"
  | "vision"
  | "web"
  | "coding"
  | "reasoning"
  | "long_context";

export interface GenerateRequest {
  model: string;
  system?: string;
  input: unknown;
  outputSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  correlationId: string;
}

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  estimatedCostUsd?: string;
  actualCostUsd?: string;
}

export interface GenerateResult<T = unknown> {
  /** The model hit its output limit before producing an answer. */
  truncated?: boolean;
  output: T;
  usage: NormalizedUsage;
  providerRequestId?: string;
  rawModelId: string;
  latencyMs: number;
}

export interface ModelDescriptor {
  provider: string;
  modelId: string;
  capabilities: Capability[];
  contextLimit?: number;
}

export interface ModelProvider {
  readonly providerId: string;
  listModels(): Promise<ModelDescriptor[]>;
  /** Context the model is actually loaded with, when the server reports one. */
  loadedContextLength?(modelId: string): Promise<number | undefined>;
  generate<T = unknown>(request: GenerateRequest): Promise<GenerateResult<T>>;
}
