import { HttpProvider, MockProvider, type ModelProvider } from "@hive/providers";
import { parseUsd } from "@hive/core";
import { z } from "zod";
import { usd } from "./contracts.js";

export interface RuntimeModel {
  id: string; name: string; provider: string; model: string; family: string;
  ready: boolean; live: boolean; inputPerMillionUsd: string; outputPerMillionUsd: string;
  maxInputTokens: number; maxOutputTokens: number; adapter: ModelProvider;
  credentialsConfigured?: boolean;
  pricingSource?: string;
  pricingCheckedAt?: string;
  spendingCapsEnabled?: boolean;
  connectionId?: string;
}

export const paidModelSettingsSchema = z.object({
  model: z.string().trim().min(1).max(200),
  inputPerMillionUsd: usd.default('0'),
  outputPerMillionUsd: usd.default('0'),
  maxInputTokens: z.number().int().min(1000).max(1000000).default(16000),
  maxOutputTokens: z.number().int().min(100).max(100000).default(3000),
});

export const modelProfileSchema=paidModelSettingsSchema.extend({
 connectionId:z.string().min(1).max(100),name:z.string().trim().min(1).max(100)
}).strict();

export const modelRegistrySchema=z.array(z.object({
  id:z.string().min(1).max(100),name:z.string().min(1).max(100),provider:z.enum(['openai','anthropic','gemini','lmstudio']),
  model:z.string().min(1).max(200),family:z.string().min(1).max(100),enabled:z.boolean().default(false),
  apiKeyEnv:z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),baseUrl:z.string().url().optional(),allowLan:z.boolean().default(false),
  timeoutMs:z.number().int().min(5000).max(600000).optional(),
  inputPerMillionUsd:usd,outputPerMillionUsd:usd,maxInputTokens:z.number().int().min(1000).max(1000000),maxOutputTokens:z.number().int().min(100).max(100000)
}).strict()).max(100);

export function createModels(env: NodeJS.ProcessEnv = process.env, extraRegistry:unknown=[]): RuntimeModel[] {
  const mock = new MockProvider();
  const models: RuntimeModel[] = ["worker", "reviewer"].map((role) => ({ id: `mock-${role}`,
    name: `Test ${role}`, provider: "mock", model: `mock-${role}`, family: "mock", ready: true, live: false,
    inputPerMillionUsd: "0", outputPerMillionUsd: "0", maxInputTokens: 30000, maxOutputTokens: 3000, adapter: mock }));
  models.push({ id: "local-qwen", name: "Local worker", provider: "lmstudio",
    model: env.LMSTUDIO_MODEL ?? "auto", family: env.LMSTUDIO_MODEL_FAMILY??"local", ready: true, live: false,
    inputPerMillionUsd: "0", outputPerMillionUsd: "0", maxInputTokens: 16000, maxOutputTokens: 3000,
    adapter: new HttpProvider({ kind: "lmstudio", apiKey: env.LMSTUDIO_API_KEY ?? "", baseUrl: env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1", timeoutMs: 360000 }) });
  for (const provider of ["openai", "anthropic", "gemini"] as const) {
    const prefix = provider.toUpperCase();
    const key = env[`${prefix}_API_KEY`] ?? "";
    const model = env[`${prefix}_MODEL`] ?? "";
    const input = env[`${prefix}_INPUT_PER_MILLION_USD`] ?? "";
    const output = env[`${prefix}_OUTPUT_PER_MILLION_USD`] ?? "";
    let priced = false;
    try { priced = parseUsd(input) > 0n && parseUsd(output) > 0n; } catch { /* Unconfigured models cannot run. */ }
    models.push({ id: provider, name: provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : "Gemini",
      provider, model, family: provider, ready: !!key && !!model && priced, live: true, credentialsConfigured: !!key,
      inputPerMillionUsd: input || "0", outputPerMillionUsd: output || "0", maxInputTokens: 16000, maxOutputTokens: 3000,
      adapter: new HttpProvider({ kind: provider, apiKey: key }) });
  }
  for(const entry of modelRegistrySchema.parse(extraRegistry)){
    if(models.some(m=>m.id===entry.id))throw new Error(`Duplicate model registry ID: ${entry.id}`);
    const key=env[entry.apiKeyEnv??`${entry.provider.toUpperCase()}_API_KEY`]??'';
    const live=entry.provider!=='lmstudio';
    const priced=!live||(parseUsd(entry.inputPerMillionUsd)>0n&&parseUsd(entry.outputPerMillionUsd)>0n);
    models.push({...entry,live,credentialsConfigured:!!key,ready:entry.enabled&&priced&&(!live||!!key),adapter:new HttpProvider({kind:entry.provider,apiKey:key,baseUrl:entry.baseUrl,allowLan:entry.allowLan,timeoutMs:entry.timeoutMs ?? (entry.provider === "lmstudio" ? 360000 : 90000)})});
  }
  return models;
}

/**
 * Discover the currently loaded local model unless the owner explicitly pinned one, and
 * shrink its declared token limits to the context it is actually loaded with.
 *
 * A config that claims more context than the server has produces an opaque HTTP 400 on
 * the first real prompt, which reads like a broken integration rather than a setting.
 */
export async function discoverLocalModels(models:RuntimeModel[],env:NodeJS.ProcessEnv=process.env){
  for(const model of models.filter(m=>m.provider==='lmstudio'&&m.ready)){
    try{
      const available=await model.adapter.listModels();
      const pinned=model.id==='local-qwen'?env.LMSTUDIO_MODEL:model.model;
      const isAuto=!pinned||['auto','discover','REPLACE_WITH_DISCOVERED_MODEL_ID'].includes(pinned);
      const selected=isAuto?available[0]:available.find(m=>m.modelId===pinned);
      model.ready=!!selected;
      if(!selected)continue;
      model.model=selected.modelId;
      const context=await model.adapter.loadedContextLength?.(selected.modelId);
      if(context)applyContextLimit(model,context);
    }catch{model.ready=false;}
  }
}

/**
 * Fit input and output inside the real context without increasing configured caps.
 * Whatever remains is the input allowance. A context too small for both
 * marks the model unavailable rather than letting it fail on every call.
 */
export function applyContextLimit(model:RuntimeModel,context:number){
  if(!Number.isSafeInteger(context)||context<=0){model.ready=false;return;}
  const usable=Math.floor(context*0.92); // leave headroom for template and role tokens
  const output=Math.min(model.maxOutputTokens,Math.max(1200,Math.floor(usable*0.35)));
  const input=usable-output;
  if(input<2000){model.ready=false;return;}
  model.maxOutputTokens=output;
  model.maxInputTokens=Math.min(model.maxInputTokens,input);
}

export function priceTokens(model: RuntimeModel, input: number, output: number): bigint {
  if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid token usage.");
  const total = parseUsd(model.inputPerMillionUsd) * BigInt(input) + parseUsd(model.outputPerMillionUsd) * BigInt(output);
  return (total + 999999n) / 1000000n;
}
