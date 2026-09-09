/** Standard text-token rates verified against official provider pages on 2026-09-08.
 * Explicit entries only: never infer prices from a similar model name. */
const rates = [
  {provider:'openai',model:'gpt-6-astra',input:'10',output:'50',source:'https://developers.openai.com/api/docs/models/gpt-6-astra',maxInputTokens:272000},
  {provider:'openai',model:'gpt-5.6-terra',input:'2',output:'12',source:'https://developers.openai.com/api/docs/models/gpt-5.6-terra',maxInputTokens:272000},
  {provider:'anthropic',model:'claude-sonnet-5',input:'2',output:'10',source:'https://platform.claude.com/docs/en/about-claude/pricing',maxInputTokens:200000},
  {provider:'gemini',model:'gemini-3.5-flash-lite',input:'0.30',output:'2.50',source:'https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite',maxInputTokens:1000000},
];
export function publishedPrice(provider:string, model:string) {
  // Accept common display-name casing and the owner's unambiguous Gemini punctuation.
  const normalized = model.trim().toLowerCase().replace(/^gemini-3-5-/, 'gemini-3.5-');
  return rates.find(r => r.provider === provider && r.model === normalized);
}
