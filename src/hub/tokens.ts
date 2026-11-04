/**
 * Token estimates for budgets (tool list size, result size). Real tokenizers differ by model, so
 * this is a deliberately simple, slightly pessimistic approximation: ~3.5 characters per token for
 * ASCII (JSON, English) and ~2 per token for other scripts (Cyrillic needs more tokens per letter).
 * The live eval (`npm run eval:live`) reports exact counts from the model API for calibration.
 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3.5 + other / 2);
}

/** Characters that fit into a token budget for mostly-ASCII text (inverse of the estimate). */
export function charsForTokens(tokens: number): number {
  return Math.floor(tokens * 3.5);
}

export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
}

/**
 * Approximate tokens the tool list costs in the model context. Clients pass a tool to the model as
 * name + description + input schema (Anthropic `tools`, OpenAI `functions`); `title` and
 * `annotations` stay in the client UI, so they are not counted.
 */
export function toolListTokens(tools: readonly ListedTool[]): number {
  return estimateTokens(
    tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  );
}
