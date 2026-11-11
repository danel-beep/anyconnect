import type { ConnectorResolver } from '../connectors/registry.js';
import { connectorText, type FetchLike } from '../connectors/sdk.js';
import type { AccountRow, AccountService } from '../core/accounts.js';
import type { OwnerNotifier } from '../core/owner-notices.js';
import type { Principal } from '../core/principal.js';
import type { ArgumentLimits, TriggerSource } from '../db/schema.js';
import type { ToolCallResult } from '../hub/result.js';
import { mapLimit } from '../lib/concurrency.js';
import type { Logger } from '../logger.js';
import { VISIBILITY_LAG_MS } from '../messaging/store.js';
import type { AiClientService } from '../security/clients.js';
import { type AgentHub, runAgent } from './ai/agent.js';
import { AI_PROVIDERS, AiProviderError } from './ai/providers.js';
import type { AiKeyStore } from './ai-keys.js';
import { clip, matchesFilter, renderArgs } from './match.js';
import type { EventSource } from './sources.js';
import { counterpartOf, type TriggerItem } from './spec.js';
import type { EventResult, Trigger, TriggerEvent, TriggerStore } from './store.js';

/** Runs of one trigger for one other side in a short window before loop protection steps in. */
export const LOOP_RUNS = 5;
export const LOOP_WINDOW_MS = 10 * 60_000;
/** Accounts one pass reads at a time (a mailbox read is a request to the service). */
const SCAN_CONCURRENCY = 4;
/** An event still `running` after this was left by a process that stopped. */
const STALE_MS = 15 * 60_000;
/** How often a test run is checked for its outcome. */
const TEST_POLL_MS = 500;
/** How long one run may take (an AI wake with a few tool calls). */
const RUN_TIMEOUT_MS = 120_000;
/** What the event says when a call that waited for the user's OK did not go through. */
const CONFIRMATION_OUTCOMES: Record<string, string> = {
  denied: 'You declined the action',
  cancelled: 'You cancelled the action',
  expired: 'The confirmation was not answered in time',
  failed: 'The action failed after you confirmed it',
};
/** Identity of the AI app every trigger of a workspace acts as (one entry in the AI apps list). */
export const AUTOMATION_CLIENT = {
  matchKey: 'automation:triggers',
  name: 'Triggers',
  kind: 'automation',
} as const;

/** What trying a trigger on an item that already arrived found (see {@link TriggerEngine.test}). */
export interface TriggerTest {
  /** Items of the last day it looked at. */
  looked: number;
  item?: TriggerItem;
  matched: boolean;
  /** Whether the action ran (an event was recorded). */
  ran: boolean;
  /** The run's event: still `running` when the wait ran out. */
  event?: TriggerEvent;
}

export interface TriggerEngineDeps {
  store: TriggerStore;
  keys: AiKeyStore;
  sources: EventSource[];
  hub: AgentHub;
  accounts: AccountService;
  connectors: ConnectorResolver;
  aiClients: AiClientService;
  notifier: OwnerNotifier;
  /** Outbound network for the AI providers (the hub's network policy). */
  fetch: FetchLike;
  /** Hands a run to the job queue; without it (a process without jobs) runs happen in place. */
  enqueue?: (eventId: string) => Promise<boolean>;
  /** Where the user manages triggers, for notices. */
  pageUrl: string;
  logger: Logger;
  onError?: (error: unknown, context: Record<string, string | number | boolean | undefined>) => void;
}

/**
 * The trigger engine: reads new events from the sources, matches them against the user's rules and
 * runs what the rules say. Matching is free (the hub does it, no AI); only an `ai` action spends
 * tokens, on the user's own key. Every action that touches a service runs through the hub as the
 * trigger's own principal, so access rules, confirmations, limits and the audit log apply as for any
 * AI app. Daily limits the user picks and loop protection keep a runaway rule from costing money.
 */
/** How long after a new-message notification the read starts: just past the store's visibility lag. */
const INBOUND_DELAY_MS = VISIBILITY_LAG_MS + 200;

export class TriggerEngine {
  private readonly clients = new Map<string, string>();
  /** Accounts with a read scheduled after a notification (see {@link onInbound}). */
  private readonly inbound = new Map<string, { again: boolean; done: Promise<void> }>();
  /** Per source: when this process last read each account (see {@link scanAll}). */
  private readonly scanned = new Map<TriggerSource, Map<string, number>>();
  /** Shared reads in flight, by source and account (see {@link scanAccount}). */
  private readonly reading = new Set<string>();

  constructor(private readonly deps: TriggerEngineDeps) {}

  private source(source: TriggerSource): EventSource {
    const found = this.deps.sources.find((s) => s.source === source);
    if (!found) throw new Error(`No event source "${source}"`);
    return found;
  }

  // --- Reading events ----------------------------------------------------------

  /**
   * A message arrived for the account (in-process or via Postgres NOTIFY). Never throws. The store
   * shows a new message only after a short lag, so the read waits for it; notifications that come
   * in meanwhile join the same read, plus one more round so the latest message is visible too.
   * Resolves when the reads are done.
   */
  onInbound(accountId: string): Promise<void> {
    const waiting = this.inbound.get(accountId);
    if (waiting) {
      waiting.again = true;
      return waiting.done;
    }
    const state: { again: boolean; done: Promise<void> } = { again: false, done: Promise.resolve() };
    state.done = (async () => {
      do {
        state.again = false;
        await new Promise((resolve) => setTimeout(resolve, INBOUND_DELAY_MS));
        await this.readInbound(accountId);
      } while (state.again);
      this.inbound.delete(accountId);
    })();
    this.inbound.set(accountId, state);
    return state.done;
  }

  private async readInbound(accountId: string): Promise<void> {
    try {
      const row = await this.deps.accounts.byId(accountId);
      if (!row) return;
      const active = await this.deps.store.active('message', row.workspaceId);
      for (const trigger of active.filter((t) => this.watches(t, row))) await this.scan(trigger, row);
    } catch (error) {
      this.deps.onError?.(error, { source: 'trigger', step: 'inbound' });
    }
  }

  /**
   * Reads every active trigger of a source (the job backstop and mail polling). In the background
   * (`background: true`) accounts sealed in their owner's vault are skipped: only a request of the
   * owner can open them, which `manyplug_check_triggers` does for its own workspace.
   *
   * Built for many mailboxes: a few accounts are read at a time, the ones read longest ago first,
   * so when a pass runs out of time (`signal`) the next one starts with what this one left, and a
   * mailbox is fetched once however many triggers watch it.
   */
  async scanAll(
    source: TriggerSource,
    options: { workspaceId?: string; background: boolean; signal?: AbortSignal },
  ) {
    const active = await this.deps.store.active(source, options.workspaceId);
    const byWorkspace = new Map<string, Trigger[]>();
    for (const t of active) byWorkspace.set(t.workspaceId, [...(byWorkspace.get(t.workspaceId) ?? []), t]);
    const work: Array<{ account: AccountRow; triggers: Trigger[] }> = [];
    for (const [workspaceId, list] of byWorkspace) {
      for (const account of await this.source(source).accounts(workspaceId)) {
        const triggers = list.filter((t) => this.watches(t, account));
        if (triggers.length) work.push({ account, triggers });
      }
    }
    const scanned = this.scannedAt(source, work);
    work.sort((a, b) => (scanned.get(a.account.id) ?? 0) - (scanned.get(b.account.id) ?? 0));
    await mapLimit(work, SCAN_CONCURRENCY, async ({ account, triggers }) => {
      if (options.signal?.aborted) return;
      if (options.background && (await this.deps.accounts.isSealed(account.id))) return;
      scanned.set(account.id, Date.now());
      await this.scanAccount(triggers, account, options.signal).catch((error) =>
        this.deps.onError?.(error, { source: 'trigger', step: 'scan', service: account.connectorId }),
      );
    });
  }

  /** When each account of a source was last read by this process; accounts no longer watched go. */
  private scannedAt(source: TriggerSource, work: Array<{ account: AccountRow }>): Map<string, number> {
    const previous = this.scanned.get(source);
    const current = new Map<string, number>();
    for (const { account } of work) {
      const at = previous?.get(account.id);
      if (at !== undefined) current.set(account.id, at);
    }
    this.scanned.set(source, current);
    return current;
  }

  /** Reads one account for the triggers watching it: one shared fetch where the source offers it. */
  private async scanAccount(triggers: Trigger[], account: AccountRow, signal?: AbortSignal): Promise<void> {
    const source = this.source(triggers[0]!.source);
    if (!source.readMany) {
      for (const trigger of triggers) {
        await this.scan(trigger, account, signal).catch((error) =>
          this.deps.onError?.(error, { source: 'trigger', step: 'scan', service: account.connectorId }),
        );
      }
      return;
    }
    // The fetch is a request to the service (seconds): no database lock or connection is held
    // across it. One read of an account at a time in this process; a read by another process only
    // repeats the fetch, and the unique event key keeps a repeat from firing twice.
    const key = `${source.source}:${account.id}`;
    if (this.reading.has(key)) return;
    this.reading.add(key);
    try {
      const { store } = this.deps;
      const requests = [];
      for (const trigger of triggers) {
        // An account connected after the trigger was made starts where its feed is now.
        const cursor = (await store.cursor(trigger.id, account.id)) ?? (await source.start(account));
        requests.push({ cursor, options: trigger.spec.filter.spam ? { spam: true } : {} });
      }
      const pages = await source.readMany(account, requests, signal ?? AbortSignal.timeout(30_000));
      for (const [index, trigger] of triggers.entries()) {
        const page = pages[index];
        if (!page) continue;
        for (const item of page.items) {
          if (matchesFilter(trigger.spec.filter, item)) await this.handle(trigger, account, item);
        }
        if (page.cursor !== requests[index]!.cursor)
          await store.setCursor(trigger.id, account.id, page.cursor);
      }
    } finally {
      this.reading.delete(key);
    }
  }

  /** Accounts of the workspace a source reads. */
  sourceAccounts(source: TriggerSource, workspaceId: string): Promise<AccountRow[]> {
    return this.source(source).accounts(workspaceId);
  }

  /** Whether a trigger listens to this account. */
  watches(trigger: Trigger, account: AccountRow): boolean {
    if (!account.enabled) return false;
    if (trigger.connectorId && trigger.connectorId !== account.connectorId) return false;
    return trigger.accountIds.length === 0 || trigger.accountIds.includes(account.id);
  }

  /** Starts the cursors of a new (or changed) trigger at the current end of every feed it watches. */
  async prime(trigger: Trigger): Promise<void> {
    const source = this.source(trigger.source);
    for (const account of await source.accounts(trigger.workspaceId)) {
      if (!this.watches(trigger, account)) continue;
      if (!(await this.deps.store.cursor(trigger.id, account.id)))
        await this.deps.store.setCursor(trigger.id, account.id, await source.start(account));
    }
  }

  private async scan(trigger: Trigger, account: AccountRow, signal?: AbortSignal): Promise<void> {
    const source = this.source(trigger.source);
    await this.deps.store.exclusive(trigger.id, account.id, async () => {
      // An account connected after the trigger was made starts where its feed is now.
      const cursor = (await this.deps.store.cursor(trigger.id, account.id)) ?? (await source.start(account));
      const page = await source.read(account, cursor, signal ?? AbortSignal.timeout(30_000), {
        ...(trigger.spec.filter.spam ? { spam: true } : {}),
      });
      for (const item of page.items) {
        if (matchesFilter(trigger.spec.filter, item)) await this.handle(trigger, account, item);
      }
      if (page.cursor !== cursor) await this.deps.store.setCursor(trigger.id, account.id, page.cursor);
    });
  }

  // --- Deciding what to do with a match --------------------------------------------

  /**
   * Records a matched item and starts its action; returns the event's id (none for a repeat). A
   * test run (`test`) has its own key, so an item already handled can be tried again.
   */
  private async handle(
    trigger: Trigger,
    account: AccountRow,
    item: TriggerItem,
    options: { test?: boolean } = {},
  ): Promise<string | undefined> {
    const { store } = this.deps;
    const action = trigger.spec.action;
    const key = `${item.service}:${item.account}|${item.id}`;
    const base = {
      trigger,
      accountId: account.id,
      item,
      eventKey: store.hash(options.test ? `test:${crypto.randomUUID()}:${key}` : key),
      counterpartKey: store.hash(counterpartOf(item)),
    };
    const skip = async (skipped: NonNullable<EventResult['skipped']>, aiKeyId?: string) =>
      (
        await store.recordEvent({
          ...base,
          status: 'skipped',
          result: { skipped },
          ...(aiKeyId ? { aiKeyId } : {}),
        })
      )?.id;

    // The user's daily limit: the trigger stops and the user is told once.
    if (trigger.dailyRuns !== null && (await store.runsToday(trigger.id)) >= trigger.dailyRuns) {
      const id = await skip('limit');
      // A test run reports the limit; only real events stop the trigger.
      if (!options.test && (await store.pause(trigger.id, 'limit'))) {
        await this.notify(trigger, {
          kind: 'trigger_paused',
          trigger: trigger.name,
          reason: 'limit',
          limit: trigger.dailyRuns,
          url: this.deps.pageUrl,
        });
      }
      return id;
    }
    // Loop protection: an auto-reply ping-pong (or a flood from one sender) stops here. Collecting
    // events for the AI's next check costs nothing, so it is not limited this way.
    if (
      action.kind !== 'check' &&
      (await store.recentFrom(trigger.id, base.counterpartKey, new Date(Date.now() - LOOP_WINDOW_MS))) >=
        LOOP_RUNS
    ) {
      return skip('loop');
    }
    let aiKeyId: string | undefined;
    if (action.kind === 'ai') {
      const key = trigger.aiKeyId
        ? await this.deps.keys.get(trigger.workspaceId, trigger.aiKeyId).catch(() => undefined)
        : undefined;
      if (!key) return skip('no_key');
      if (key.dailyRuns !== null && key.runsToday >= key.dailyRuns) {
        const first = await skip('ai_limit', key.id);
        // Told once a day: the first skipped run of the day is the moment the limit was reached.
        if (first && (await store.skippedToday(key.id)) === 1) {
          await this.notify(trigger, {
            kind: 'trigger_paused',
            trigger: trigger.name,
            reason: 'ai_limit',
            limit: key.dailyRuns,
            url: this.deps.pageUrl.replace(/\/triggers$/, '/ai'),
          });
        }
        return first;
      }
      aiKeyId = key.id;
    }
    const event = await store.recordEvent({
      ...base,
      status: action.kind === 'check' ? 'new' : 'running',
      ...(aiKeyId ? { aiKeyId } : {}),
    });
    if (!event) return undefined;
    if (action.kind !== 'check') await this.dispatch(event.id);
    return event.id;
  }

  // --- Trying a trigger on a real item -----------------------------------------------

  /**
   * Tries a trigger on an item that already arrived (the newest match of the last day, or the one
   * with `itemId`): says whether the filter matches and, unless `run` is false, runs the action as
   * a real event would (same limits and checks) and waits for the outcome. `force` runs it on an
   * item the filter does not match. Reads the accounts in this request, so sealed ones work too.
   */
  async test(
    trigger: Trigger,
    options: { itemId?: string; run: boolean; force: boolean; signal: AbortSignal },
  ): Promise<TriggerTest> {
    const source = this.source(trigger.source);
    const readOptions = trigger.spec.filter.spam ? { spam: true } : {};
    const found: Array<{ account: AccountRow; item: TriggerItem }> = [];
    for (const account of await source.accounts(trigger.workspaceId)) {
      if (!this.watches(trigger, account) || options.signal.aborted) continue;
      const items = await source.recent(account, options.signal, readOptions).catch((error) => {
        this.deps.onError?.(error, { source: 'trigger', step: 'test', service: account.connectorId });
        return [];
      });
      for (const item of items) found.push({ account, item });
    }
    found.sort((a, b) => b.item.at.localeCompare(a.item.at));
    const pick = options.itemId
      ? found.find((f) => f.item.id === options.itemId)
      : (found.find((f) => matchesFilter(trigger.spec.filter, f.item)) ?? found[0]);
    if (!pick) return { looked: found.length, matched: false, ran: false };
    const matched = matchesFilter(trigger.spec.filter, pick.item);
    const base = { looked: found.length, item: pick.item, matched };
    if (!options.run || (!matched && !options.force)) return { ...base, ran: false };
    const eventId = await this.handle(trigger, pick.account, pick.item, { test: true });
    const event = eventId ? await this.settled(eventId, options.signal) : undefined;
    return { ...base, ran: true, ...(event ? { event } : {}) };
  }

  /** Waits (polling, bounded by the signal) until a run is over and returns the event. */
  private async settled(eventId: string, signal: AbortSignal): Promise<TriggerEvent | undefined> {
    for (;;) {
      const event = await this.deps.store.getEvent(eventId);
      if (event?.status !== 'running' || signal.aborted) return event;
      await new Promise((resolve) => setTimeout(resolve, TEST_POLL_MS));
    }
  }

  private async dispatch(eventId: string): Promise<void> {
    if (this.deps.enqueue && (await this.deps.enqueue(eventId).catch(() => false))) return;
    // No job queue in this process: run here, after the scan that found it.
    void this.run(eventId);
  }

  // --- Running actions -------------------------------------------------------------

  /** Runs the action of one event (the `triggers.run` job). Never throws. */
  async run(eventId: string): Promise<void> {
    const { store } = this.deps;
    const event = await store.getEvent(eventId);
    if (event?.status !== 'running' || !event.item) return;
    const trigger = await this.triggerOf(event);
    if (!trigger) return;
    const finish = (status: TriggerEvent['status'], result: EventResult, tokens?: number) =>
      store.setStatus(eventId, status, {
        from: 'running',
        result,
        ...(tokens !== undefined ? { tokens } : {}),
      });
    const signal = AbortSignal.timeout(RUN_TIMEOUT_MS);
    try {
      const action = trigger.spec.action;
      switch (action.kind) {
        case 'check':
          await store.setStatus(eventId, 'new', { from: 'running' });
          return;
        case 'notify': {
          const delivery = await this.notifyFired(trigger, event.item, null);
          await finish(delivery === 'failed' ? 'failed' : 'done', {
            summary: delivery === 'no_channel' ? 'no_channel' : 'notified',
          });
          return;
        }
        case 'tool': {
          const principal = await this.principal(trigger, event.id, [action.tool], false);
          const hub = this.deps.hub;
          const catalog = await hub.getCatalog(principal);
          const args = renderArgs(action.args, event.item, trigger.name) as Record<string, unknown>;
          const result = await hub.callTool(principal, catalog, action.tool, args, { signal });
          const awaiting = awaitingConfirmation(result);
          await finish(awaiting ? 'awaiting_confirmation' : result.isError ? 'failed' : 'done', {
            calls: [{ tool: action.tool, ok: !result.isError && !awaiting }],
            ...(result.isError
              ? { error: clip(textOf(result), 300) }
              : { summary: clip(textOf(result), 300) }),
          });
          return;
        }
        case 'ai': {
          const opened = trigger.aiKeyId ? await this.deps.keys.open(trigger.aiKeyId) : undefined;
          const provider = opened ? AI_PROVIDERS[opened.row.provider] : undefined;
          if (!opened || !provider) {
            await finish('failed', { skipped: 'no_key' });
            return;
          }
          const principal = await this.principal(
            trigger,
            event.id,
            action.tools,
            action.confirmRisky,
            action.allow,
          );
          try {
            const outcome = await runAgent(
              {
                provider,
                key: opened.key,
                model: opened.row.model,
                principal,
                instructions: action.instructions,
                item: event.item,
                trigger: trigger.name,
                signal,
              },
              this.deps.hub,
              this.deps.fetch,
            );
            await this.deps.keys.recordUse(opened.row.id, null);
            const summary = clip(outcome.text, 600) || undefined;
            await finish(
              outcome.awaiting ? 'awaiting_confirmation' : 'done',
              { ...(summary ? { summary } : {}), calls: outcome.calls },
              outcome.tokens,
            );
            if (action.notify && (summary || outcome.awaiting))
              await this.notifyFired(trigger, event.item, summary ?? null);
          } catch (error) {
            const message = error instanceof AiProviderError ? error.message : 'The AI could not be reached';
            await this.deps.keys.recordUse(opened.row.id, message);
            if (!(error instanceof AiProviderError)) throw error;
            await finish('failed', { error: message });
          }
          return;
        }
      }
    } catch (error) {
      this.deps.onError?.(error, { source: 'trigger', step: 'run', action: trigger.spec.action.kind });
      await finish('failed', { error: 'Internal error' }).catch(() => {});
    }
  }

  /**
   * A call the trigger made waited for the user's OK and has now ended (see
   * `PendingCallService.onSettled`): the event leaves "waiting for confirmation" and shows how it
   * went. Never throws.
   */
  async confirmationSettled(eventId: string, tool: string, outcome: string): Promise<void> {
    const text = CONFIRMATION_OUTCOMES[outcome];
    if (!(outcome === 'succeeded' || text)) return;
    try {
      const { store } = this.deps;
      const event = await store.getEvent(eventId);
      if (event?.status !== 'awaiting_confirmation') return;
      const ok = outcome === 'succeeded';
      const status = ok ? 'done' : 'failed';
      // Without the account's key (a sealed account outside its vault) only the status changes.
      if (!event.item) {
        await store.setStatus(eventId, status, { from: 'awaiting_confirmation' });
        return;
      }
      const calls = event.result.calls?.map((call) => (call.tool === tool ? { ...call, ok } : call));
      await store.setStatus(eventId, status, {
        from: 'awaiting_confirmation',
        result: { ...event.result, ...(calls ? { calls } : {}), ...(ok ? {} : { error: text }) },
      });
    } catch (error) {
      this.deps.onError?.(error, { source: 'trigger', step: 'confirmation' });
    }
  }

  /** Marks runs a stopped process left behind as failed, so they do not look busy forever. */
  async failStale(): Promise<void> {
    for (const id of await this.deps.store.stale(STALE_MS)) {
      await this.deps.store.setStatus(id, 'failed', {
        from: 'running',
        result: { error: 'Interrupted by a restart' },
      });
    }
  }

  private async triggerOf(event: TriggerEvent): Promise<Trigger | undefined> {
    const row = await this.deps.accounts.byId(event.accountId);
    if (!row) return undefined;
    return this.deps.store.get(row.workspaceId, event.triggerId).catch(() => undefined);
  }

  /**
   * The principal a trigger acts as: the workspace's Triggers app, with only the rule's tools and
   * argument values. `confirmRisky: false` (a `tool` action, or an AI the user let act without
   * asking) makes the user's approval of the trigger stand in for the access rules' "ask first".
   */
  async principal(
    trigger: Pick<Trigger, 'id' | 'workspaceId' | 'userId'>,
    eventId: string,
    tools: string[],
    confirmRisky: boolean,
    allow?: ArgumentLimits,
  ): Promise<Principal> {
    let clientId = this.clients.get(trigger.workspaceId);
    if (!clientId) {
      clientId = (await this.deps.aiClients.ensure(trigger.workspaceId, { ...AUTOMATION_CLIENT })).id;
      this.clients.set(trigger.workspaceId, clientId);
    }
    return {
      kind: 'automation',
      userId: trigger.userId,
      workspaceId: trigger.workspaceId,
      scopes: ['mcp'],
      aiClientId: clientId,
      credentialId: trigger.id,
      automation: { triggerId: trigger.id, eventId, tools, confirmRisky, ...(allow ? { allow } : {}) },
    };
  }

  private async notifyFired(trigger: Trigger, item: TriggerItem, summary: string | null) {
    const connector = await this.deps.connectors.get(trigger.workspaceId, item.service);
    return this.notify(trigger, {
      kind: 'trigger_fired',
      trigger: trigger.name,
      service: connector ? connectorText(connector, 'en').name : item.service,
      account: item.account,
      from: item.from ?? null,
      title: item.subject ?? item.chatTitle ?? null,
      preview: clip(item.text, 400),
      summary,
      url: this.deps.pageUrl,
    });
  }

  private async notify(trigger: Trigger, notice: Parameters<OwnerNotifier['notify']>[1]) {
    try {
      return await this.deps.notifier.notify(trigger.userId, notice);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'trigger notice failed');
      return 'failed' as const;
    }
  }
}

function textOf(result: ToolCallResult): string {
  return result.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
}

export function awaitingConfirmation(result: ToolCallResult): boolean {
  return (
    (result.structuredContent as { confirmation?: { status?: string } } | undefined)?.confirmation?.status ===
    'awaiting_confirmation'
  );
}
