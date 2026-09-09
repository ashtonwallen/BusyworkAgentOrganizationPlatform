import type { GenerateRequest, GenerateResult, ModelProvider } from "./provider.js";

export type HttpProviderKind = "openai" | "anthropic" | "gemini" | "lmstudio";
export class ProviderFailure extends Error {
  constructor(message: string, readonly definitelyNotCharged = false) { super(message); }
}

/** Credentials stay in this adapter closure. No raw HTTP errors/bodies enter agent context. */
export class HttpProvider implements ModelProvider {
  readonly providerId: HttpProviderKind;
  constructor(private readonly options: { kind: HttpProviderKind; apiKey: string; baseUrl?: string; allowLan?: boolean; timeoutMs?: number; fetch?: typeof fetch }) {
    this.providerId = options.kind;
    if (options.baseUrl) {
      const url = new URL(options.baseUrl);
      if (url.username || url.password || url.search || url.hash) throw new Error("Provider URL cannot contain credentials or query parameters.");
      if (options.kind !== "lmstudio") throw new Error("Remote providers use fixed official endpoints.");
      const parts = url.hostname.split('.').map(Number);
      const privateV4 = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((!local && !(options.allowLan && privateV4)) || !["http:", "https:"].includes(url.protocol)) {
        throw new Error("Local provider must use loopback or an explicitly enabled private LAN IPv4 endpoint.");
      }
    }
  }
  async listModels() {
    if (this.providerId !== "lmstudio") return [];
    const url = `${(this.options.baseUrl ?? "http://127.0.0.1:1234/v1").replace(/\/$/, "")}/models`;
    const response = await (this.options.fetch ?? fetch)(url, { headers: this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}, signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new ProviderFailure("Local model discovery failed.", true);
    const raw = await response.json() as { data?: { id: string }[] };
    return (raw.data ?? []).filter(m => typeof m.id === 'string').map(m => ({ provider: "lmstudio", modelId: m.id, capabilities: ["structured_output" as const] }));
  }

  /**
   * The context a local model is actually loaded with, which is often far smaller than
   * the config claims. LM Studio reports it on its native endpoint; a declared limit
   * larger than the loaded one produces an opaque HTTP 400 on the first real prompt.
   * Returns undefined when the server does not report one.
   */
  async loadedContextLength(modelId: string): Promise<number | undefined> {
    if (this.providerId !== "lmstudio") return undefined;
    const base = this.options.baseUrl ?? "http://127.0.0.1:1234/v1";
    let origin: string;
    try { origin = new URL(base).origin; } catch { return undefined; }
    try {
      const response = await (this.options.fetch ?? fetch)(`${origin}/api/v0/models`, {
        headers: this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {},
        signal: AbortSignal.timeout(5000), redirect: "error",
      });
      if (!response.ok) return undefined;
      const raw = await response.json() as { data?: { id?: string; loaded_context_length?: number; max_context_length?: number }[] };
      const entry = (raw.data ?? []).find((m) => m.id === modelId);
      const length = entry?.loaded_context_length ?? entry?.max_context_length;
      return typeof length === "number" && length > 0 ? length : undefined;
    } catch { return undefined; }
  }

  async generate<T = unknown>(request: GenerateRequest): Promise<GenerateResult<T>> {
    if (!request.maxOutputTokens || !request.outputSchema) throw new ProviderFailure("A token limit and output schema are required.", true);
    const { kind, apiKey } = this.options;
    const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const schema = JSON.parse(JSON.stringify(request.outputSchema)); delete schema.$schema;
    if (kind === 'openai') {
      // Strict Responses schemas require every property, including fields whose
      // runtime validator supplies a default. Models must emit [] or null explicitly.
      const requireProperties = (value: any): void => {
        if (!value || typeof value !== 'object') return;
        if (value.type === 'object' && value.properties) {
          value.required = Object.keys(value.properties);
          value.additionalProperties = false;
        }
        // Zod email patterns contain lookaheads that provider grammar compilers
        // may reject. Keep the supported email format; runtime validates fully.
        if (value.format === 'email') delete value.pattern;
        delete value.default;
        for (const child of Object.values(value)) if (typeof child === 'object') {
          if (Array.isArray(child)) child.forEach(requireProperties); else requireProperties(child);
        }
      };
      requireProperties(schema);
    }
    const system = request.system ?? "Return the requested JSON object.";
    let url: string;
    let body: Record<string, unknown>;
    if (kind === "openai") {
      url = "https://api.openai.com/v1/responses";
      headers.Authorization = `Bearer ${apiKey}`;
      body = {
        model: request.model, instructions: system, input, max_output_tokens: request.maxOutputTokens,
        store: false, text: { format: { type: "json_schema", name: "hive_output", strict: true, schema } }
      };
    } else if (kind === "anthropic") {
      url = "https://api.anthropic.com/v1/messages";
      headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01";
      body = {
        model: request.model, system, messages: [{ role: "user", content: input }],
        max_tokens: request.maxOutputTokens,
        tools: [{ name: "submit_result", description: "Submit the required structured result.", input_schema: schema }],
        tool_choice: { type: "tool", name: "submit_result" }
      };
    } else if (kind === "gemini") {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent`;
      headers["x-goog-api-key"] = apiKey;
      body = {
        systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: input }] }],
        generationConfig: { maxOutputTokens: request.maxOutputTokens, responseMimeType: "application/json", responseJsonSchema: schema }
      };
    } else {
      url = `${(this.options.baseUrl ?? "http://127.0.0.1:1234/v1").replace(/\/$/, "")}/chat/completions`;
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      body = {
        model: request.model, messages: [{ role: "system", content: system }, { role: "user", content: input }],
        max_tokens: request.maxOutputTokens, response_format: { type: "json_schema", json_schema: { name: "hive_output", strict: true, schema } }
      };
    }
    const start = Date.now();
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method: "POST", headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 90000), redirect: "error"
      });
    } catch { throw new ProviderFailure("Provider connection ended without a confirmed result; reconcile before retrying."); }
    if (!response.ok) {
      let detail = '';
      try {
        const raw = await response.json() as any;
        const code = raw?.error?.code;
        // Only fixed descriptions cross the adapter boundary, never raw provider text.
        if (code === 'invalid_json_schema') detail = ' The structured response schema was rejected.';
        else if (code === 'model_not_found') detail = ' The configured model is unavailable.';
        else if (code === 'context_length_exceeded') detail = ' The request exceeds the model context limit.';
        else if (code === 'unsupported_parameter') detail = ' A request parameter is unsupported by this model.';
      } catch { /* Preserve the HTTP status when there is no structured error. */ }
      throw new ProviderFailure(`Provider returned HTTP ${response.status}.${detail}`, [400, 401, 403, 404, 413, 422, 429].includes(response.status));
    }
    let raw: any;
    try { raw = await response.json(); } catch { throw new ProviderFailure("Provider returned an unreadable response; usage is uncertain."); }
    let truncated = false;
    let output: unknown; let inputTokens: number | undefined; let outputTokens: number | undefined;
    if (kind === "openai") {
      truncated = raw.status === "incomplete" && raw.incomplete_details?.reason === "max_output_tokens";
      output = raw.output?.filter((o: any) => o.type === "message").flatMap((o: any) => o.content ?? [])
        .filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("");
      inputTokens = raw.usage?.input_tokens; outputTokens = raw.usage?.output_tokens;
    } else if (kind === "anthropic") {
      truncated = raw.stop_reason === "max_tokens";
      output = raw.content?.find((c: any) => c.type === "tool_use" && c.name === "submit_result")?.input;
      inputTokens = raw.usage?.input_tokens; outputTokens = raw.usage?.output_tokens;
    } else if (kind === "gemini") {
      truncated = raw.candidates?.[0]?.finishReason === "MAX_TOKENS";
      output = raw.candidates?.[0]?.content?.parts?.filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("");
      inputTokens = raw.usageMetadata?.promptTokenCount;
      const candidates = raw.usageMetadata?.candidatesTokenCount;
      outputTokens = typeof candidates === "number" ? candidates + (raw.usageMetadata?.thoughtsTokenCount ?? 0) : undefined;
    } else {
      const choice = raw.choices?.[0];
      truncated = choice?.finish_reason === "length";
      output = choice?.message?.content;
      inputTokens = raw.usage?.prompt_tokens; outputTokens = raw.usage?.completion_tokens;
      // Reasoning models spend the same budget thinking. Hitting the limit mid-thought
      // returns empty content, which would otherwise surface as a puzzling schema error.
      if (choice?.finish_reason === "length" && !output) {
        output = { __truncated: "The reply was cut off before any answer was produced. Answer directly and briefly; do not think at length before responding." };
      }
    }
    if (typeof output === "string") { try { output = JSON.parse(output); } catch { /* Keep invalid text for the runtime validator; usage must still settle. */ } }
    return {
      truncated, output: output as T, usage: { inputTokens, outputTokens },
      providerRequestId: raw.id ?? raw.responseId ?? response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined,
      rawModelId: raw.model ?? raw.modelVersion ?? request.model, latencyMs: Date.now() - start
    };
  }
}
