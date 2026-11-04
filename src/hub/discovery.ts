import { getCapability } from '../connectors/capabilities.js';
import type { BuiltinToolId } from './builtin-tools.js';
import type {
  CatalogStats,
  CatalogTool,
  ClientProfile,
  ListingMode,
  ListingSetting,
} from './catalog-types.js';
import { toolListTokens } from './tokens.js';

/**
 * Discovery: when listing every tool would cost too much context (or exceed a client's tool
 * limit), `tools/list` shows a handful of meta tools — search, describe, call, batch — plus the
 * most useful tools that still fit the budget. The model finds the rest on demand, so the context
 * spent on tools stays flat however many services and accounts are connected.
 */

/** Hub tools listed in direct mode (the others only make sense in discovery). */
const DIRECT_BUILTINS: ReadonlySet<BuiltinToolId> = new Set(['list_accounts', 'call_tools']);

/** Unified tools that run over every account (search, list) cover the most tasks per token. */
const isFanOutRead = (tool: CatalogTool) =>
  tool.target.kind === 'capability' && getCapability(tool.target.capabilityId)?.kind === 'list';

const builtinId = (tool: CatalogTool) => (tool.target.kind === 'builtin' ? tool.target.id : undefined);

export function chooseListing(input: {
  builtins: CatalogTool[];
  unified: CatalogTool[];
  serviceTools: CatalogTool[];
  /** Hub setup tools: listed in either mode while they still fit, never a reason to switch. */
  setupTools?: CatalogTool[];
  setting: ListingSetting;
  profile: ClientProfile;
  usage: Record<string, number>;
}): { listing: ListingMode; listed: CatalogTool[]; stats: Omit<CatalogStats, 'totalTools'> } {
  const { profile } = input;
  const direct = [
    ...input.builtins.filter((t) => DIRECT_BUILTINS.has(builtinId(t)!)),
    ...input.unified,
    ...input.serviceTools,
  ];
  const directTokens = toolListTokens(direct);
  const fits = (tools: CatalogTool[], tokens = toolListTokens(tools)) =>
    tokens <= profile.tokenBudget && (profile.maxTools === undefined || tools.length <= profile.maxTools);

  const useDirect = input.setting === 'direct' || (input.setting === 'auto' && fits(direct, directTokens));
  const setupTools = input.setupTools ?? [];
  /** Adds setup tools while they fit (all of them when the user asked for every tool). */
  const withSetup = (listed: CatalogTool[], all: boolean) => {
    for (const tool of setupTools) if (all || fits([...listed, tool])) listed.push(tool);
    return listed;
  };
  if (useDirect) {
    const listed = withSetup([...direct], input.setting === 'direct');
    return {
      listing: 'direct',
      listed,
      stats: { directTokens, listedTokens: toolListTokens(listed), budget: profile.tokenBudget },
    };
  }

  // Discovery: meta tools first, then featured tools while they fit.
  const listed = [...input.builtins];
  const uses = (t: CatalogTool) => input.usage[t.name] ?? 0;
  // Tools the workspace actually uses come first, most used first.
  const used = [...input.unified, ...input.serviceTools]
    .filter((t) => uses(t) > 0)
    .sort((a, b) => uses(b) - uses(a));
  // Then unused unified tools: reads over every account first (they cover the most tasks per token).
  const unused = input.unified
    .filter((t) => uses(t) === 0)
    .map((tool, order) => ({ tool, order, rank: isFanOutRead(tool) ? 0 : tool.risk === 'read' ? 2 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((x) => x.tool);
  for (const candidate of [...used, ...unused]) {
    if (fits([...listed, candidate])) listed.push(candidate);
  }
  withSetup(listed, false);
  return {
    listing: 'discovery',
    listed,
    stats: { directTokens, listedTokens: toolListTokens(listed), budget: profile.tokenBudget },
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** A few common synonyms, so "email" finds `mail_*` and "dm" finds messenger tools. */
const SYNONYMS: Record<string, string[]> = {
  email: ['mail', 'inbox', 'message'],
  mail: ['email', 'inbox'],
  letter: ['mail', 'email'],
  inbox: ['mail', 'email'],
  message: ['messages', 'chat', 'send'],
  messages: ['message', 'chat'],
  chat: ['message', 'messages'],
  dm: ['message', 'chat'],
  text: ['message'],
  send: ['post', 'create', 'reply'],
  reply: ['send', 'answer'],
  find: ['search', 'list', 'get'],
  search: ['find', 'list', 'query'],
  look: ['search', 'find'],
  show: ['list', 'get', 'read'],
  read: ['get', 'open', 'show'],
  open: ['read', 'get'],
  event: ['calendar', 'meeting'],
  meeting: ['event', 'calendar'],
  schedule: ['calendar', 'event'],
  file: ['files', 'document', 'drive'],
  document: ['file', 'doc', 'page'],
  doc: ['document', 'file'],
  task: ['tasks', 'todo', 'issue'],
  todo: ['task'],
  issue: ['task', 'ticket'],
  contact: ['contacts', 'person', 'people'],
  person: ['contact'],
  people: ['contact'],
  payment: ['invoice', 'charge'],
  invoice: ['payment', 'bill'],
  delete: ['remove'],
  remove: ['delete'],
  create: ['add', 'new'],
  add: ['create'],
};

const RISK_ORDER = { read: 0, write: 1, dangerous: 2 } as const;

const STOP = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'in',
  'on',
  'for',
  'and',
  'or',
  'my',
  'all',
  'with',
  'from',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function singular(token: string): string {
  return token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
}

interface Indexed {
  tool: CatalogTool;
  fields: Array<{ tokens: Set<string>; weight: number }>;
}

function index(tool: CatalogTool): Indexed {
  const accounts =
    tool.target.kind === 'action'
      ? tool.target.accounts.flatMap((a) => [a.name, a.label, a.identity ?? ''])
      : tool.target.kind === 'capability'
        ? tool.target.implementations.flatMap((i) => [i.connectorId, i.connectorName])
        : [];
  const field = (text: string, weight: number) => ({ tokens: new Set(tokenize(text).map(singular)), weight });
  return {
    tool,
    fields: [
      field(tool.name.replace(/_/g, ' '), 3),
      field(tool.title, 2),
      field(tool.service ?? '', 3),
      field(tool.keywords ?? '', 2),
      field(accounts.join(' '), 2),
      field(tool.description, 1),
    ],
  };
}

/** Relevance of a tool for a query: weighted token matches, with prefixes and synonyms at a discount. */
function score(entry: Indexed, query: string[]): number {
  let total = 0;
  for (const raw of query) {
    const token = singular(raw);
    const variants = [token, ...(SYNONYMS[token] ?? []).map(singular)];
    let best = 0;
    for (const { tokens, weight } of entry.fields) {
      for (const [i, variant] of variants.entries()) {
        const factor = i === 0 ? 1 : 0.7;
        if (tokens.has(variant)) best = Math.max(best, weight * factor);
        else if (variant.length >= 5) {
          // Prefix matches stand in for stemming: "deploy" ~ "deployments", "invoic" ~ "invoices".
          for (const t of tokens) {
            if (t.length >= 5 && (t.startsWith(variant) || variant.startsWith(t))) {
              best = Math.max(best, weight * factor * 0.6);
            }
          }
        }
      }
    }
    total += best;
  }
  // Unified tools cover several services: prefer them on ties.
  if (total > 0 && entry.tool.target.kind === 'capability') total += 0.5;
  return total;
}

/** Ranks the callable tools for a free-text task description. Hub meta tools are never returned. */
export function searchTools(
  tools: readonly CatalogTool[],
  query: string,
  options: { service?: string; limit?: number } = {},
): CatalogTool[] {
  const terms = tokenize(query);
  const candidates = tools.filter(
    (t) =>
      t.target.kind !== 'builtin' &&
      (!options.service ||
        t.service === options.service ||
        (t.target.kind === 'capability' &&
          t.target.implementations.some((i) => i.connectorId === options.service))),
  );
  if (terms.length === 0) return candidates.slice(0, options.limit ?? 5);
  return (
    candidates
      .map((tool) => ({ tool, score: score(index(tool), terms) }))
      .filter((r) => r.score > 0)
      // Ties: reads before writes (safer and more often what is meant), then by name.
      .sort(
        (a, b) =>
          b.score - a.score ||
          RISK_ORDER[a.tool.risk] - RISK_ORDER[b.tool.risk] ||
          a.tool.name.localeCompare(b.tool.name),
      )
      .slice(0, options.limit ?? 5)
      .map((r) => r.tool)
  );
}
