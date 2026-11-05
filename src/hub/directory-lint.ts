import type { CatalogTool } from './catalog-types.js';

/**
 * Checks tools against what AI app directories review automatically (Claude Connectors Directory,
 * ChatGPT apps, MCP Registry consumers): names, titles, explicit annotations, descriptions free of
 * prompt-injection patterns, and no catch-all HTTP tool. Pure, so tests run it over every built-in
 * connector and the CLI can run it over a real workspace.
 */

export interface ToolLintIssue {
  tool: string;
  rule: string;
  message: string;
}

/** Works in every major AI client. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** Long descriptions cost context in every conversation; directories flag rambling ones. */
export const MAX_DESCRIPTION = 1200;

/**
 * Phrases that tell the model how to behave instead of describing the tool (rejected by the Claude
 * directory review and the ChatGPT guidelines).
 */
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [
    /\bignore (all |any )?(previous|prior|other) (instructions|tools)\b/i,
    'tells the model to ignore instructions',
  ],
  [/\bsystem prompt\b/i, 'mentions the system prompt'],
  [/\b(always|must) (use|call|prefer) this tool\b/i, 'pushes the model to prefer this tool'],
  [
    /\b(instead of|rather than) (any )?other (tools|connectors|apps|plugins)\b/i,
    'steers away from other tools',
  ],
  [/\bdo not (tell|inform|show) the user\b/i, 'hides something from the user'],
  [/<\s*(important|system|instructions?)\s*>/i, 'contains hidden instruction tags'],
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** A tool that takes the HTTP method as an argument mixes reads and writes in one tool. */
function isCatchAllHttp(tool: CatalogTool): boolean {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: unknown[] } | undefined>;
  const method = properties.method;
  if (!method) return false;
  const values = (method.enum ?? []).map((v) => String(v).toUpperCase());
  return (
    values.length === 0 ||
    (values.includes('GET') && values.some((v) => v !== 'GET' && HTTP_METHODS.includes(v)))
  );
}

export function lintTools(tools: readonly CatalogTool[]): ToolLintIssue[] {
  const issues: ToolLintIssue[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const issue = (rule: string, message: string) => issues.push({ tool: tool.name, rule, message });
    if (!TOOL_NAME.test(tool.name)) issue('name', 'must match ^[a-zA-Z0-9_-]{1,64}$');
    if (seen.has(tool.name)) issue('name', 'is not unique');
    seen.add(tool.name);

    if (!tool.title.trim()) issue('title', 'is empty');
    const a = tool.annotations;
    if (!a.title?.trim()) issue('annotations.title', 'is missing');
    for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const) {
      if (typeof a[hint] !== 'boolean') issue(`annotations.${hint}`, 'must be an explicit boolean');
    }
    if (a.readOnlyHint && a.destructiveHint) issue('annotations', 'a read-only tool cannot be destructive');
    if ((tool.risk === 'read') !== Boolean(a.readOnlyHint) && tool.target.kind !== 'builtin')
      issue('annotations.readOnlyHint', `does not match the risk "${tool.risk}"`);
    if (tool.risk === 'dangerous' && a.destructiveHint !== true)
      issue('annotations.destructiveHint', 'a dangerous tool must be destructive');

    const description = tool.description.trim();
    if (!description) issue('description', 'is empty');
    if (description.length > MAX_DESCRIPTION)
      issue('description', `is longer than ${MAX_DESCRIPTION} characters`);
    for (const [pattern, why] of INJECTION_PATTERNS) {
      if (pattern.test(description)) issue('description', why);
    }
    if (isCatchAllHttp(tool)) issue('input', 'takes the HTTP method as an argument; split reads and writes');
  }
  return issues;
}
