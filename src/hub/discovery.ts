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
 * most useful tools that still fit the budget: the most used, unified reads, each service's entry
 * reads, then hub setup tools. The model finds the rest on demand, so the context
 * spent on tools stays flat however many services and accounts are connected.
 */

/** Hub tools listed in direct mode (the others only make sense in discovery). */
const DIRECT_BUILTINS: ReadonlySet<BuiltinToolId> = new Set(['list_accounts', 'call_tools']);

/** Unified tools that run over every account (search, list) cover the most tasks per token. */
const isFanOutRead = (tool: CatalogTool) =>
  tool.target.kind === 'capability' && getCapability(tool.target.capabilityId)?.kind === 'list';

/**
 * A service's own entry point: a read that implements a shared list capability (`gmail_search`,
 * `gcal_list_events`, `telegram_list_chats`), so one listed tool answers "what's new there".
 */
const isEntryRead = (tool: CatalogTool) =>
  tool.target.kind === 'action' &&
  tool.risk === 'read' &&
  (tool.implements ?? []).some((id) => getCapability(id)?.kind === 'list');

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
  // Then each service's entry reads, unless a unified tool already covers that capability: a new
  // workspace (no usage yet) would otherwise list only hub tools and need a search for every task.
  const unifiedIds = new Set(
    input.unified.flatMap((t) => (t.target.kind === 'capability' ? [t.target.capabilityId] : [])),
  );
  const entries = input.serviceTools.filter(
    (t) => uses(t) === 0 && isEntryRead(t) && !(t.implements ?? []).every((id) => unifiedIds.has(id)),
  );
  for (const candidate of [...used, ...unused, ...entries]) {
    if (fits([...listed, candidate])) listed.push(candidate);
  }
  // Setup tools last: rarer than everyday tasks, and the server instructions name them.
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
//
// In discovery mode this search is how the model finds almost every tool, and people phrase tasks
// the way they talk ("what meetings do I have this week"). Ranking, in short:
// - words are lowercased, filler words dropped and endings stripped ("meetings" ~ "meet");
// - each query word scores in the best field it hits (name > title/keywords > description),
//   synonyms and prefixes at a discount;
// - rare words weigh more than common ones (IDF over the searched tools), so "unread" or "reply"
//   decides between Gmail tools and "gmail" or "email" does not.
// Connectors improve their ranking with `keywords` on actions (search only, never sent to the AI).

/** Words people use for the same thing, so "email" finds `mail_*` and "dm" finds messenger tools. */
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
  wrote: ['message', 'mail', 'new'],
  write: ['send', 'message'],
  written: ['message', 'mail'],
  sent: ['send'],
  send: ['post', 'create', 'reply'],
  reply: ['send', 'answer'],
  answer: ['reply'],
  find: ['search', 'list', 'get'],
  search: ['find', 'list', 'query'],
  look: ['search', 'find'],
  show: ['list', 'get', 'read'],
  check: ['list', 'search', 'read'],
  read: ['get', 'open', 'show'],
  open: ['read', 'get'],
  event: ['calendar', 'meeting'],
  meeting: ['event', 'calendar'],
  appointment: ['event', 'calendar'],
  call: ['meeting', 'event'],
  agenda: ['event', 'calendar'],
  schedule: ['calendar', 'event'],
  reschedule: ['update', 'event'],
  postpone: ['update'],
  move: ['update'],
  change: ['update'],
  edit: ['update'],
  rename: ['update'],
  cancel: ['delete', 'remove'],
  available: ['free', 'busy'],
  file: ['files', 'document', 'drive'],
  document: ['file', 'doc', 'page'],
  doc: ['document', 'file'],
  task: ['tasks', 'todo', 'issue'],
  todo: ['task'],
  done: ['complete'],
  finish: ['complete'],
  issue: ['task', 'ticket'],
  ticket: ['issue'],
  pr: ['pull', 'request'],
  contact: ['contacts', 'person', 'people'],
  person: ['contact'],
  people: ['contact'],
  payment: ['invoice', 'charge'],
  invoice: ['payment', 'bill'],
  delete: ['remove', 'trash'],
  remove: ['delete'],
  create: ['add', 'new'],
  add: ['create', 'append'],
  notify: ['alert', 'trigger'],
  ping: ['notify', 'alert'],
};

const RISK_ORDER = { read: 0, write: 1, dangerous: 2 } as const;

/** Filler words that say nothing about which tool is meant. */
const STOP = new Set(
  (
    'the a an to of in on at by for and or with from into about as so if then than ' +
    'my mine me i you your we us our it its this that these those there here ' +
    'what whats which who whom whose where why how do does did doing is are was were be been am ' +
    'have has had having can could would should will shall may might must please just also too very ' +
    'all any some last latest'
  ).split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Drops a doubled final consonant left by a stripped ending ("planned" → "plann" → "plan"). */
const undouble = (t: string) => (/([^aeiouylsz])\1$/.test(t) ? t.slice(0, -1) : t);

/**
 * A light English stemmer: enough that "meetings", "meeting" and "meet", or "archived" and
 * "archive", meet in the index. Applied to the index and the query alike.
 */
export function stem(token: string): string {
  let t = token;
  if (t.length <= 3) return t;
  if (t.endsWith('ies') && t.length > 4) t = `${t.slice(0, -3)}y`;
  else if (/(ch|sh|x|z|ss)es$/.test(t)) t = t.slice(0, -2);
  else if (t.endsWith('s') && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);
  if (t.endsWith('ied') && t.length > 4) t = `${t.slice(0, -3)}y`;
  else if (t.endsWith('ing') && t.length > 5) t = undouble(t.slice(0, -3));
  else if (t.endsWith('ed') && t.length > 4) t = undouble(t.slice(0, -2));
  if (t.endsWith('e') && t.length > 4) t = t.slice(0, -1);
  return t;
}

const STEMMED_SYNONYMS: ReadonlyMap<string, string[]> = new Map(
  Object.entries(SYNONYMS).map(([word, list]) => [stem(word), [...new Set(list.map(stem))]]),
);

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
  const field = (text: string, weight: number) => ({ tokens: new Set(tokenize(text).map(stem)), weight });
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

/** How specific each word is among the searched tools: rare words decide, common ones barely count. */
function inverseFrequency(entries: readonly Indexed[]): (token: string) => number {
  const frequency = new Map<string, number>();
  for (const entry of entries) {
    const seen = new Set<string>();
    for (const { tokens } of entry.fields) for (const t of tokens) seen.add(t);
    for (const t of seen) frequency.set(t, (frequency.get(t) ?? 0) + 1);
  }
  const total = entries.length;
  return (token) => Math.log(1 + total / (frequency.get(token) ?? 1));
}

/** Relevance of a tool for a query: weighted, IDF-scaled matches, synonyms and prefixes at a discount. */
function score(entry: Indexed, query: string[], idf: (token: string) => number): number {
  let total = 0;
  for (const token of query) {
    const variants = [token, ...(STEMMED_SYNONYMS.get(token) ?? [])];
    let best = 0;
    for (const { tokens, weight } of entry.fields) {
      for (const [i, variant] of variants.entries()) {
        const factor = i === 0 ? 1 : 0.6;
        if (tokens.has(variant)) best = Math.max(best, weight * factor * idf(variant));
        else if (variant.length >= 5) {
          // Prefix matches catch what the stemmer leaves: "deploy" ~ "deployments".
          for (const t of tokens) {
            if (t.length >= 5 && (t.startsWith(variant) || variant.startsWith(t))) {
              best = Math.max(best, weight * factor * 0.6 * idf(t));
            }
          }
        }
      }
    }
    total += best;
  }
  // Unified tools cover several services: prefer them when they match about as well. Hub setup
  // tools give way to service tools on a near tie: everyday tasks are far more common.
  const kind = entry.tool.target.kind;
  return kind === 'capability' ? total * 1.15 : kind === 'workspace' ? total * 0.8 : total;
}

/** Ranks the callable tools for a free-text task description. Hub meta tools are never returned. */
export function searchTools(
  tools: readonly CatalogTool[],
  query: string,
  options: { service?: string; limit?: number } = {},
): CatalogTool[] {
  const terms = [...new Set(tokenize(query).map(stem))];
  const candidates = tools.filter(
    (t) =>
      t.target.kind !== 'builtin' &&
      (!options.service ||
        t.service === options.service ||
        (t.target.kind === 'capability' &&
          t.target.implementations.some((i) => i.connectorId === options.service))),
  );
  if (terms.length === 0) return candidates.slice(0, options.limit ?? 5);
  const entries = candidates.map(index);
  const idf = inverseFrequency(entries);
  return (
    entries
      .map((entry) => ({ tool: entry.tool, score: score(entry, terms, idf) }))
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
