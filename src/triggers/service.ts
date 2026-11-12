import type { ConnectorResolver } from '../connectors/registry.js';
import type { AccountRow, AccountService } from '../core/accounts.js';
import type { Principal } from '../core/principal.js';
import type { ArgumentLimits, TriggerSource } from '../db/schema.js';
import type {
  AiKeyInfo,
  CheckedEvent,
  TriggerChange,
  TriggerDo,
  TriggerInfo,
  TriggerRun,
  TriggerTried,
  TriggerWhen,
  WorkspaceTriggers,
} from '../hub/trigger-tools.js';
import { badRequest } from '../lib/errors.js';
import type { AgentHub } from './ai/agent.js';
import { AI_PROVIDER_IDS, AI_PROVIDERS } from './ai/providers.js';
import type { AiKeyStore, AiKeyView } from './ai-keys.js';
import type { TriggerEngine } from './engine.js';
import { clip } from './match.js';
import {
  ArgumentLimitsInput,
  DEFAULT_DAILY_RUNS,
  TRIGGER_SOURCES,
  type TriggerAction,
  type TriggerFilter,
  type TriggerItem,
  type TriggerSpec,
} from './spec.js';
import type { Trigger, TriggerEvent, TriggerStore } from './store.js';

/** How long a check may spend reading mailboxes before it answers with what it has. */
const CHECK_SCAN_MS = 20_000;
/** How long a test waits for its run before answering (it goes on; `manyplug_trigger_runs` shows it). */
const TEST_WAIT_MS = 45_000;

/**
 * The workspace-facing side of triggers: create and change them from the chat tools and the
 * dashboard (one set of rules for both), and hand matches to the AI app that checks.
 */
export class TriggerService implements WorkspaceTriggers {
  constructor(
    private readonly deps: {
      store: TriggerStore;
      keys: AiKeyStore;
      engine: TriggerEngine;
      accounts: AccountService;
      connectors: ConnectorResolver;
      hub: AgentHub;
      pageUrl: string;
      aiPageUrl: string;
    },
  ) {}

  get pageUrl(): string {
    return this.deps.pageUrl;
  }

  get aiPageUrl(): string {
    return this.deps.aiPageUrl;
  }

  async list(workspaceId: string): Promise<TriggerInfo[]> {
    const [triggers, runs, accounts, keys] = await Promise.all([
      this.deps.store.list(workspaceId),
      this.deps.store.runsTodayByTrigger(workspaceId),
      this.deps.accounts.list(workspaceId),
      this.deps.keys.list(workspaceId),
    ]);
    return triggers.map((t) => this.info(t, runs.get(t.id) ?? 0, accounts, keys));
  }

  async find(workspaceId: string, ref: string): Promise<TriggerInfo> {
    const trigger = await this.deps.store.find(workspaceId, ref);
    return this.describe(trigger);
  }

  async create(
    principal: Principal,
    input: TriggerChange & { name: string; when: TriggerWhen; do: TriggerDo },
  ): Promise<TriggerInfo> {
    const workspaceId = principal.workspaceId;
    const scope = await this.scope(workspaceId, input.when, input.account);
    const { action, aiKeyId } = await this.action(principal, input.do, input, undefined);
    const trigger = await this.deps.store.create(workspaceId, principal.userId, {
      name: input.name,
      source: input.when,
      ...scope,
      spec: { filter: filterOf(input.filter), action },
      dailyRuns: input.dailyLimit === undefined ? DEFAULT_DAILY_RUNS : input.dailyLimit,
      aiKeyId,
    });
    await this.deps.engine.prime(trigger);
    return this.describe(trigger);
  }

  async update(principal: Principal, ref: string, change: TriggerChange): Promise<TriggerInfo> {
    const workspaceId = principal.workspaceId;
    const current = await this.deps.store.find(workspaceId, ref);
    const when = change.when ?? current.source;
    const kind = change.do ?? current.spec.action.kind;
    const actionChanged =
      change.do !== undefined ||
      ['task', 'tool', 'args', 'instructions', 'tools', 'aiKey', 'askBeforeRisky', 'notify', 'allow'].some(
        (k) => change[k as keyof TriggerChange] !== undefined,
      );
    const scope =
      change.account !== undefined || change.when !== undefined
        ? await this.scope(workspaceId, when, change.account)
        : undefined;
    const next = actionChanged ? await this.action(principal, kind, change, current) : undefined;
    const spec: TriggerSpec | undefined =
      next || change.filter
        ? {
            filter: change.filter ? filterOf(change.filter) : current.spec.filter,
            action: next?.action ?? current.spec.action,
          }
        : undefined;
    const updated = await this.deps.store.update(workspaceId, current.id, {
      ...(change.name ? { name: change.name } : {}),
      ...(spec ? { spec } : {}),
      ...(next ? { aiKeyId: next.aiKeyId } : {}),
      ...(scope ? scope : {}),
      ...(change.dailyLimit !== undefined ? { dailyRuns: change.dailyLimit } : {}),
      ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
    });
    if (scope) await this.deps.engine.prime(updated);
    return this.describe(updated);
  }

  async delete(workspaceId: string, ref: string): Promise<void> {
    const found = await this.deps.store.find(workspaceId, ref);
    await this.deps.store.delete(workspaceId, found.id);
  }

  async check(
    principal: Principal,
    options: { trigger?: string; limit: number; signal: AbortSignal },
  ): Promise<{ events: CheckedEvent[]; more: boolean }> {
    const workspaceId = principal.workspaceId;
    const all = await this.deps.store.list(workspaceId);
    const only = options.trigger ? [await this.deps.store.find(workspaceId, options.trigger)] : undefined;
    // This request can open the owner's vault: read mailboxes the background cannot, and catch up on
    // messages a lost notification may have left behind. Bounded, so the check stays quick.
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(CHECK_SCAN_MS)]);
    for (const source of TRIGGER_SOURCES) {
      if (!all.some((t) => t.source === source && t.enabled)) continue;
      await this.deps.engine.scanAll(source, { workspaceId, background: false, signal }).catch(() => {});
    }
    const { events, more } = await this.deps.store.takeNew(workspaceId, {
      ...(only ? { triggerIds: only.map((t) => t.id) } : {}),
      limit: options.limit,
    });
    const byId = new Map(all.map((t) => [t.id, t]));
    return {
      events: events.flatMap((e) => {
        const trigger = byId.get(e.triggerId);
        return e.item && trigger ? [checked(e, trigger)] : [];
      }),
      more,
    };
  }

  async test(
    principal: Principal,
    ref: string,
    options: { item?: string; run: boolean; force: boolean; signal: AbortSignal },
  ): Promise<TriggerTried> {
    const trigger = await this.deps.store.find(principal.workspaceId, ref);
    // A trigger the user turned off does not act, not even as a test.
    const run = options.run && trigger.enabled;
    const tried = await this.deps.engine.test(trigger, {
      ...(options.item ? { itemId: options.item } : {}),
      run,
      force: options.force,
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(TEST_WAIT_MS)]),
    });
    // A calendar is tried on what lies ahead, the other sources on what already arrived.
    const ahead = trigger.source === 'calendar';
    const note = !tried.item
      ? options.item
        ? ahead
          ? `No event "${options.item}" among the ${tried.looked} that start in the next day in the calendars this trigger watches.`
          : `No message or email "${options.item}" among the last day's ${tried.looked} on the accounts this trigger watches.`
        : ahead
          ? 'No event with a start time in the next day in the calendars this trigger watches.'
          : 'Nothing arrived on the accounts this trigger watches in the last day.'
      : options.run && !trigger.enabled
        ? 'The trigger is off, so it did not run. Turn it on to try its action.'
        : !tried.matched && !tried.ran
          ? options.item
            ? 'The filter does not match this item, so the trigger would skip it. force: true runs it anyway.'
            : ahead
              ? 'None of the next day’s events match the filter; this is the next one. force: true runs it anyway.'
              : 'None of the last day’s items match the filter; this is the newest. force: true runs it anyway.'
          : tried.event?.status === 'running'
            ? 'Still running: manyplug_trigger_runs shows the outcome.'
            : undefined;
    return {
      looked: tried.looked,
      matched: tried.matched,
      ran: tried.ran,
      ...(tried.item ? { item: itemView(tried.item) } : {}),
      ...(tried.event ? { run: runOf(tried.event, trigger.name) } : {}),
      ...(note ? { note } : {}),
    };
  }

  async runs(workspaceId: string, options: { trigger?: string; limit: number }): Promise<TriggerRun[]> {
    const only = options.trigger ? await this.deps.store.find(workspaceId, options.trigger) : undefined;
    const [events, all] = await Promise.all([
      this.deps.store.events(workspaceId, { limit: options.limit, ...(only ? { triggerId: only.id } : {}) }),
      only ? Promise.resolve([only]) : this.deps.store.list(workspaceId),
    ]);
    const names = new Map(all.map((t) => [t.id, t.name]));
    return events.map((e) => runOf(e, names.get(e.triggerId) ?? e.triggerId));
  }

  async aiKeys(workspaceId: string): Promise<AiKeyInfo[]> {
    return (await this.deps.keys.list(workspaceId)).map(keyInfo);
  }

  async findAiKey(workspaceId: string, ref: string): Promise<AiKeyInfo | undefined> {
    const found = await this.deps.keys.find(workspaceId, ref);
    return found ? keyInfo(found) : undefined;
  }

  async updateAiKey(
    workspaceId: string,
    ref: string,
    patch: { label?: string; model?: string; dailyRuns?: number | null },
  ): Promise<AiKeyInfo> {
    const found = await this.aiKeyByRef(workspaceId, ref);
    return keyInfo(await this.deps.keys.update(workspaceId, found.id, patch));
  }

  async deleteAiKey(workspaceId: string, ref: string): Promise<AiKeyInfo> {
    const found = await this.aiKeyByRef(workspaceId, ref);
    await this.deps.keys.delete(workspaceId, found.id);
    return keyInfo(found);
  }

  get aiProviders(): Array<{ id: string; name: string; defaultModel: string }> {
    return AI_PROVIDER_IDS.map((id) => ({
      id,
      name: AI_PROVIDERS[id].name,
      defaultModel: AI_PROVIDERS[id].defaultModel,
    }));
  }

  private async aiKeyByRef(workspaceId: string, ref: string): Promise<AiKeyView> {
    const found = await this.deps.keys.find(workspaceId, ref);
    if (found) return found;
    const keys = await this.deps.keys.list(workspaceId);
    throw badRequest(
      keys.length
        ? `Unknown AI key "${ref}". Use one of: ${keys.map((k) => k.label).join(', ')}`
        : `No AI key yet: the user adds one on ${this.deps.aiPageUrl}.`,
    );
  }

  /** The accounts each source can watch, for the dashboard's picker. */
  async watchable(workspaceId: string): Promise<Record<TriggerSource, AccountRow[]>> {
    const [message, mail, calendar] = await Promise.all(
      TRIGGER_SOURCES.map((source) => this.deps.engine.sourceAccounts(source, workspaceId)),
    );
    return { message: message ?? [], mail: mail ?? [], calendar: calendar ?? [] };
  }

  /** The latest events for the dashboard. */
  events(workspaceId: string, options: { limit?: number; triggerId?: string } = {}): Promise<TriggerEvent[]> {
    return this.deps.store.events(workspaceId, options);
  }

  // --- Building a trigger ----------------------------------------------------------

  /** Which accounts a trigger watches: one account, one service, or every account of the source. */
  private async scope(
    workspaceId: string,
    source: TriggerSource,
    ref: string | undefined,
  ): Promise<{ connectorId: string | null; accountIds: string[] }> {
    const value = ref?.trim();
    if (!value || value === 'all') return { connectorId: null, accountIds: [] };
    const [service, name] = value.includes(':')
      ? (value.split(':', 2) as [string, string])
      : [value, undefined];
    const readable = await this.deps.engine.sourceAccounts(source, workspaceId);
    const matches = readable.filter((a) => a.connectorId === service && (!name || a.name === name));
    if (!matches.length) {
      const known = [...new Set(readable.map((a) => `${a.connectorId}:${a.name}`))];
      throw badRequest(
        `No ${SOURCE_ACCOUNTS[source]} "${value}". ${known.length ? `Use one of: ${known.join(', ')}` : `Connect one first.`}`,
      );
    }
    return name
      ? { connectorId: service, accountIds: [matches[0]!.id] }
      : { connectorId: service, accountIds: [] };
  }

  private async action(
    principal: Principal,
    kind: TriggerDo,
    change: TriggerChange,
    current: Trigger | undefined,
  ): Promise<{ action: TriggerAction; aiKeyId: string | null }> {
    const was = current?.spec.action;
    switch (kind) {
      case 'check': {
        const task = change.task ?? (was?.kind === 'check' ? was.task : undefined);
        return { action: { kind: 'check', ...(task ? { task } : {}) }, aiKeyId: null };
      }
      case 'notify':
        return { action: { kind: 'notify' }, aiKeyId: null };
      case 'tool': {
        const tool = change.tool ?? (was?.kind === 'tool' ? was.tool : undefined);
        if (!tool) throw badRequest('do=tool needs "tool": the tool the hub calls, e.g. telegram_send');
        await this.assertTools(principal, [tool]);
        const args = change.args ?? (was?.kind === 'tool' ? was.args : {});
        return { action: { kind: 'tool', tool, args }, aiKeyId: null };
      }
      case 'ai': {
        const prev = was?.kind === 'ai' ? was : undefined;
        const instructions = change.instructions ?? prev?.instructions;
        if (!instructions)
          throw badRequest('do=ai needs "instructions": what the AI should do with each event');
        const key = await this.key(principal.workspaceId, change.aiKey, current?.aiKeyId ?? null);
        const tools = change.tools ?? prev?.tools ?? [];
        await this.assertTools(principal, tools);
        // Limits kept from before follow the tool list; new ones must name its tools.
        const allow =
          change.allow === undefined ? limitsOf(prev?.allow, tools, false) : limitsOf(change.allow, tools);
        return {
          action: {
            kind: 'ai',
            instructions,
            tools,
            confirmRisky: change.askBeforeRisky ?? prev?.confirmRisky ?? true,
            notify: change.notify ?? prev?.notify ?? true,
            ...(allow ? { allow } : {}),
          },
          aiKeyId: key.id,
        };
      }
    }
  }

  private async key(
    workspaceId: string,
    ref: string | undefined,
    currentId: string | null,
  ): Promise<AiKeyView> {
    const keys = await this.deps.keys.list(workspaceId);
    if (!keys.length) throw badRequest(`Add an AI API key first, on ${this.deps.aiPageUrl}.`);
    if (ref) {
      const found = await this.deps.keys.find(workspaceId, ref);
      if (!found)
        throw badRequest(`Unknown AI key "${ref}". Use one of: ${keys.map((k) => k.label).join(', ')}`);
      return found;
    }
    return keys.find((k) => k.id === currentId) ?? keys[0]!;
  }

  /** The tools must exist for the triggers' app (its access rules apply to what it can see). */
  private async assertTools(principal: Principal, tools: string[]): Promise<void> {
    if (!tools.length) return;
    const probe = await this.deps.engine.principal(
      { id: 'new', workspaceId: principal.workspaceId, userId: principal.userId },
      'probe',
      tools,
      true,
    );
    const catalog = await this.deps.hub.getCatalog(probe);
    const names = new Set(catalog.tools.filter((t) => t.target.kind !== 'workspace').map((t) => t.name));
    const unknown = tools.filter((t) => !names.has(t));
    if (unknown.length)
      throw badRequest(
        `Unknown tool ${unknown.join(', ')}. Use the service tools by their exact names (find them with manyplug_search_tools).`,
      );
  }

  // --- Views ------------------------------------------------------------------

  private async describe(trigger: Trigger): Promise<TriggerInfo> {
    const [runs, accounts, keys] = await Promise.all([
      this.deps.store.runsToday(trigger.id),
      this.deps.accounts.list(trigger.workspaceId),
      this.deps.keys.list(trigger.workspaceId),
    ]);
    return this.info(trigger, runs, accounts, keys);
  }

  info(trigger: Trigger, runsToday: number, accounts: AccountRow[], keys: AiKeyView[]): TriggerInfo {
    const action = trigger.spec.action;
    const key = keys.find((k) => k.id === trigger.aiKeyId);
    return {
      id: trigger.id,
      name: trigger.name,
      enabled: trigger.enabled,
      paused: trigger.pausedReason,
      when: trigger.source,
      accounts: accountsLabel(trigger, accounts),
      everyAccount: !trigger.connectorId && trigger.accountIds.length === 0,
      // Zero minutes before an event is a setting too; empty words and switched-off flags are not.
      filter: Object.fromEntries(
        Object.entries(trigger.spec.filter).filter(([, v]) => v || v === 0),
      ) as Record<string, string | boolean | number>,
      do: action.kind,
      action:
        action.kind === 'tool'
          ? action.tool
          : action.kind === 'ai'
            ? `AI (${key ? `${key.label}, ${key.model}` : 'no key'}; tools: ${action.tools.join(', ') || 'none'})`
            : action.kind,
      ...(action.kind === 'check' && action.task ? { task: action.task } : {}),
      ...(action.kind === 'ai' ? { askBeforeRisky: action.confirmRisky } : {}),
      ...(action.kind === 'ai' && action.allow ? { allow: action.allow } : {}),
      dailyLimit: trigger.dailyRuns,
      runsToday,
    };
  }
}

/**
 * Argument limits, checked: only tools the trigger may use (`strict`: others are an error, else
 * dropped); none (null or empty) is no limit.
 */
export function limitsOf(
  input: TriggerChange['allow'] | undefined,
  tools: string[],
  strict = true,
): ArgumentLimits | undefined {
  if (!input) return undefined;
  const parsed = ArgumentLimitsInput.safeParse(input);
  if (!parsed.success) throw badRequest('allow: {"tool": {"argument": ["allowed value", …]}}');
  const extra = Object.keys(parsed.data).filter((t) => !tools.includes(t));
  if (extra.length && strict)
    throw badRequest(`allow names ${extra.join(', ')}, which is not in the trigger's tools`);
  const limits = Object.fromEntries(
    Object.entries(parsed.data).filter(
      ([tool, args]) => tools.includes(tool) && Object.keys(args).length > 0,
    ),
  );
  return Object.keys(limits).length ? limits : undefined;
}

/** What an account of each source is called, and the label of a trigger that watches all of them. */
const SOURCE_ACCOUNTS: Record<TriggerSource, string> = {
  message: 'messenger account',
  mail: 'mailbox',
  calendar: 'calendar',
};
const ALL_ACCOUNTS: Record<TriggerSource, string> = {
  message: 'all messages',
  mail: 'all mail',
  calendar: 'all calendars',
};

const FILTER_WORDS = [
  'from',
  'chat',
  'subject',
  'text',
  'not_from',
  'not_chat',
  'not_subject',
  'not_text',
] as const;

export function filterOf(input: TriggerChange['filter']): TriggerFilter {
  const out: TriggerFilter = {};
  for (const key of FILTER_WORDS) {
    const value = input?.[key]?.trim();
    if (value) out[key] = value;
  }
  if (input?.skip_bulk) out.skip_bulk = true;
  if (input?.spam) out.spam = true;
  if (typeof input?.minutes_before === 'number') out.minutes_before = input.minutes_before;
  return out;
}

export function accountsLabel(
  trigger: Pick<Trigger, 'source' | 'connectorId' | 'accountIds'>,
  accounts: AccountRow[],
) {
  if (trigger.accountIds.length) {
    return trigger.accountIds
      .map((id) => accounts.find((a) => a.id === id))
      .map((a) => (a ? `${a.connectorId}:${a.name}` : 'removed account'))
      .join(', ');
  }
  if (trigger.connectorId) return trigger.connectorId;
  return ALL_ACCOUNTS[trigger.source];
}

function checked(event: TriggerEvent, trigger: Trigger): CheckedEvent {
  const action = trigger.spec.action;
  return {
    trigger: trigger.name,
    ...itemView(event.item!),
    ...(action.kind === 'check' && action.task ? { task: action.task } : {}),
  };
}

function itemView(item: TriggerItem): Omit<CheckedEvent, 'trigger' | 'task'> {
  return {
    service: item.service,
    account: item.account,
    id: item.id,
    ...(item.chat ? { chat: item.chat } : {}),
    ...(item.from ? { from: item.from } : {}),
    ...(item.subject || item.chatTitle ? { title: (item.subject ?? item.chatTitle)! } : {}),
    preview: clip(item.text, 280),
    at: item.at,
  };
}

/** One event as `manyplug_trigger_runs` shows it. */
export function runOf(event: TriggerEvent, trigger: string): TriggerRun {
  const { item, result } = event;
  return {
    trigger,
    status: event.status,
    at: event.createdAt.toISOString(),
    ...(event.finishedAt
      ? { seconds: Math.round((event.finishedAt.getTime() - event.createdAt.getTime()) / 100) / 10 }
      : {}),
    ...(item
      ? {
          service: item.service,
          account: item.account,
          id: item.id,
          ...(item.from ? { from: item.from } : {}),
          ...(item.subject || item.chatTitle ? { title: clip((item.subject ?? item.chatTitle)!, 120) } : {}),
        }
      : {}),
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.skipped ? { skipped: result.skipped } : {}),
    ...(result.calls?.length ? { calls: result.calls } : {}),
    ...(event.tokens ? { tokens: event.tokens } : {}),
  };
}

function keyInfo(k: AiKeyView): AiKeyInfo {
  return {
    id: k.id,
    label: k.label,
    provider: k.providerName,
    model: k.model,
    dailyRuns: k.dailyRuns,
    runsToday: k.runsToday,
    tokensToday: k.tokensToday,
    lastUsedAt: k.lastUsedAt,
    lastError: k.lastError,
  };
}
