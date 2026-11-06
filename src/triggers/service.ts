import type { ConnectorResolver } from '../connectors/registry.js';
import type { AccountRow, AccountService } from '../core/accounts.js';
import type { Principal } from '../core/principal.js';
import type { TriggerSource } from '../db/schema.js';
import type {
  CheckedEvent,
  TriggerChange,
  TriggerDo,
  TriggerInfo,
  TriggerWhen,
  WorkspaceTriggers,
} from '../hub/trigger-tools.js';
import { badRequest } from '../lib/errors.js';
import type { AgentHub } from './ai/agent.js';
import type { AiKeyStore, AiKeyView } from './ai-keys.js';
import type { TriggerEngine } from './engine.js';
import { clip } from './match.js';
import { DEFAULT_DAILY_RUNS, type TriggerAction, type TriggerFilter, type TriggerSpec } from './spec.js';
import type { Trigger, TriggerEvent, TriggerStore } from './store.js';

/** How long a check may spend reading mailboxes before it answers with what it has. */
const CHECK_SCAN_MS = 20_000;

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
      ['task', 'tool', 'args', 'instructions', 'tools', 'aiKey', 'askBeforeRisky', 'notify'].some(
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
    for (const source of ['message', 'mail'] as const) {
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

  async aiKeys(workspaceId: string) {
    return (await this.deps.keys.list(workspaceId)).map((k) => ({
      label: k.label,
      provider: k.providerName,
      model: k.model,
    }));
  }

  /** The accounts each source can watch, for the dashboard's picker. */
  async watchable(workspaceId: string): Promise<Record<TriggerSource, AccountRow[]>> {
    const [message, mail] = await Promise.all([
      this.deps.engine.sourceAccounts('message', workspaceId),
      this.deps.engine.sourceAccounts('mail', workspaceId),
    ]);
    return { message, mail };
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
        `No ${source === 'mail' ? 'mailbox' : 'messenger account'} "${value}". ${known.length ? `Use one of: ${known.join(', ')}` : `Connect one first.`}`,
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
        return {
          action: {
            kind: 'ai',
            instructions,
            tools,
            confirmRisky: change.askBeforeRisky ?? prev?.confirmRisky ?? true,
            notify: change.notify ?? prev?.notify ?? true,
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
      filter: Object.fromEntries(Object.entries(trigger.spec.filter).filter(([, v]) => v)) as Record<
        string,
        string
      >,
      do: action.kind,
      action:
        action.kind === 'tool'
          ? action.tool
          : action.kind === 'ai'
            ? `AI (${key ? `${key.label}, ${key.model}` : 'no key'}; tools: ${action.tools.join(', ') || 'none'})`
            : action.kind,
      ...(action.kind === 'check' && action.task ? { task: action.task } : {}),
      ...(action.kind === 'ai' ? { askBeforeRisky: action.confirmRisky } : {}),
      dailyLimit: trigger.dailyRuns,
      runsToday,
    };
  }
}

export function filterOf(input: TriggerChange['filter']): TriggerFilter {
  const out: TriggerFilter = {};
  for (const key of ['from', 'chat', 'subject', 'text'] as const) {
    const value = input?.[key]?.trim();
    if (value) out[key] = value;
  }
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
  return trigger.source === 'mail' ? 'all mail' : 'all messages';
}

function checked(event: TriggerEvent, trigger: Trigger): CheckedEvent {
  const item = event.item!;
  const action = trigger.spec.action;
  return {
    trigger: trigger.name,
    service: item.service,
    account: item.account,
    id: item.id,
    ...(item.chat ? { chat: item.chat } : {}),
    ...(item.from ? { from: item.from } : {}),
    ...(item.subject || item.chatTitle ? { title: (item.subject ?? item.chatTitle)! } : {}),
    preview: clip(item.text, 280),
    at: item.at,
    ...(action.kind === 'check' && action.task ? { task: action.task } : {}),
  };
}
