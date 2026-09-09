import type { GenerateRequest } from '@hive/providers';

export const estimatedInputTokens = (request: GenerateRequest) => Math.ceil(Buffer.byteLength(JSON.stringify(request), 'utf8') / 3) + 512;

/** Drop oldest optional context before rejecting a request. Never truncate instructions,
 * owner records, the current plan/artifact, or the output schema. */
export function fitPrompt(request: GenerateRequest, limit: number): GenerateRequest {
  const fitted = JSON.parse(JSON.stringify(request)) as GenerateRequest;
  const input = fitted.input as Record<string, unknown>;
  const omitted: Record<string, number> = {};
  for (const key of ['recentWork', 'businessEntities', 'customerOrders', 'workBacklog', 'messages', 'experiments', 'hiringShortlist', 'delegatedWork', 'sharedDocuments', 'publishingReleases', 'operationResults', 'ownerConversation', 'ownAssignments']) {
    const rows = input[key];
    if (!Array.isArray(rows)) continue;
    while (rows.length && estimatedInputTokens(fitted) > limit) {
      rows.pop();
      omitted[key] = (omitted[key] || 0) + 1;
      input.omittedContext = omitted;
      if(key==='customerOrders'||key==='workBacklog'){
        const retrieval=(input.contextRetrieval??={}) as Record<string,string>;
        retrieval[key]=key==='customerOrders'?'Use ORDER_FIND to discover the full register and ORDER for an exact record. Omitted orders are not absent orders.':'Use BACKLOG target=* for register metadata or a specific ID for full instructions. Omitted plans are not absent plans.';
      }
    }
  }
  const documents=(input.referencedDocuments as {documents?:{content?:string;complete:boolean;reason?:string}[]}|undefined)?.documents;
  // Prefer relevant document text over optional background; if it still cannot
  // fit, retain explicit version/provenance metadata instead of a silent excerpt.
  for(const doc of [...(documents??[])].reverse()){
    if(estimatedInputTokens(fitted)<=limit)break;
    if(doc.content!==undefined){delete doc.content;doc.complete=false;doc.reason='Content omitted to fit model context. Read the document before judging its contents.';}
  }
  return fitted;
}

/** Fit a smaller call inside the task's remaining allocation without discarding
 * mandatory context. Return null when even a minimal response cannot fit. */
export function fitRemainingAllocation(request: GenerateRequest, inputLimit: number, remaining: number) {
  const initialOutput = request.maxOutputTokens!;
  if (remaining >= inputLimit + initialOutput) return {request: fitPrompt(request, inputLimit), inputLimit};
  const minimumOutput = Math.min(initialOutput, 100);
  if (remaining <= minimumOutput) return null;
  // Try preserving answer capacity first. Only remove the established optional context.
  const preferredInput = Math.min(inputLimit, remaining - initialOutput);
  if (preferredInput > 0) {
    const preferred = fitPrompt(request, preferredInput);
    if (estimatedInputTokens(preferred) <= preferredInput) return {request: preferred, inputLimit: preferredInput};
  }
  const largestInput = Math.min(inputLimit, remaining - minimumOutput);
  const compact = fitPrompt(request, largestInput);
  const required = estimatedInputTokens(compact);
  if (required > largestInput) return null;
  const output = Math.min(initialOutput, remaining - required);
  compact.maxOutputTokens = output;
  return {request: compact, inputLimit: Math.min(inputLimit, remaining - output)};
}
