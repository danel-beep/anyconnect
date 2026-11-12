import { type CapabilityId, getCapability } from '../connectors/capabilities.js';
import type { ConnectorResolver } from '../connectors/registry.js';
import { actionCapabilities, type ConnectorDefinition, ConnectorError } from '../connectors/sdk.js';
import type { AccountRow, AccountService } from '../core/accounts.js';
import { listOf } from '../hub/merge.js';
import { isSetupConnector } from '../hub/setup-tools.js';
import type { Logger } from '../logger.js';
import type { MessageStore } from '../messaging/store.js';
import { DEFAULT_MINUTES_BEFORE, type TriggerItem } from './spec.js';

/**
 * Where events come from. A source lists the accounts it can read, gives a cursor at the current
 * end of an account's feed (a new trigger never fires on old items) and reads what came after a
 * cursor. Messengers read the hub's own synced copy (free, instant); mailboxes and calendars are
 * asked through the shared `mail.search` and `calendar.list_events` interfaces on a schedule. A new
 * source (webhooks) is one more implementation registered with the engine.
 */
export interface EventSource {
  source: TriggerItem['source'];
  /** Accounts of the workspace this source reads (enabled ones). */
  accounts(workspaceId: string): Promise<AccountRow[]>;
  /** Whether this source reads the account (by its service). */
  reads(account: AccountRow): Promise<boolean>;
  /**
   * Sources whose items land in the hub's own store can tell where something arrived: the
   * accounts that got an item after `since` (a mark an earlier call returned; without it, or when
   * the source cannot tell, `accountIds` is absent: read everything) and the mark of now. Lets the
   * regular catch-up pass skip the accounts where nothing happened, which is nearly all of them.
   */
  changes?(since: string | undefined): Promise<{ mark: string; accountIds?: string[] }>;
  start(account: AccountRow): Promise<string>;
  read(
    account: AccountRow,
    cursor: string,
    signal: AbortSignal,
    options?: ReadOptions,
  ): Promise<{ items: TriggerItem[]; cursor: string }>;
  /**
   * Sources whose read costs a request to the service (a mailbox) answer several cursors of one
   * account from a single fetch: every trigger watching the mailbox shares it. Results come in the
   * order of `requests`. Sources that read the hub's own store do not need it.
   */
  readMany?(account: AccountRow, requests: ReadRequest[], signal: AbortSignal): Promise<ReadResult[]>;
  /** The newest items of about the last day, newest first (to try a trigger on a real one). */
  recent(account: AccountRow, signal: AbortSignal, options?: ReadOptions): Promise<TriggerItem[]>;
}

export interface ReadRequest {
  cursor: string;
  options?: ReadOptions;
}

export interface ReadResult {
  items: TriggerItem[];
  cursor: string;
}

/** How far back `recent` looks, and how many items it returns at most. */
const RECENT_HOURS = 24;
const RECENT_ITEMS = 20;

/** What one trigger reads beyond the default (each trigger has its own cursor on each account). */
export interface ReadOptions {
  /** Mail: the spam folder too. */
  spam?: boolean;
  /** Calendar: how many minutes before an event starts it counts as an event of the feed. */
  minutesBefore?: number;
}

/** The action of a service that implements a shared interface (not a messenger, not a setup tool). */
async function capabilityAction(connectors: ConnectorResolver, account: AccountRow, id: CapabilityId) {
  if (isSetupConnector(account.connectorId)) return undefined;
  const connector = await connectors.get(account.workspaceId, account.connectorId);
  if (!connector || connector.messenger) return undefined;
  for (const action of connector.actions) {
    const binding = actionCapabilities(action).find((b) => b.id === id);
    if (binding) return { connector, action, binding };
  }
  return undefined;
}

/** The enabled accounts of a workspace a source reads. */
async function readable(
  accounts: AccountService,
  source: Pick<EventSource, 'reads'>,
  workspaceId: string,
): Promise<AccountRow[]> {
  const out: AccountRow[] = [];
  for (const row of await accounts.list(workspaceId))
    if (row.enabled && (await source.reads(row))) out.push(row);
  return out;
}

/** Incoming messenger messages (Telegram, WhatsApp, bots…) from the hub's message store. */
export class MessageSource implements EventSource {
  readonly source = 'message' as const;

  constructor(
    private readonly deps: { accounts: AccountService; connectors: ConnectorResolver; store: MessageStore },
  ) {}

  accounts(workspaceId: string): Promise<AccountRow[]> {
    return readable(this.deps.accounts, this, workspaceId);
  }

  async reads(account: AccountRow): Promise<boolean> {
    const connector = await this.deps.connectors.get(account.workspaceId, account.connectorId);
    return connector?.messenger !== undefined;
  }

  async changes(since: string | undefined): Promise<{ mark: string; accountIds?: string[] }> {
    const after = since === undefined ? undefined : Number(since);
    const { latest, accountIds } = await this.deps.store.arrivedSince(after);
    return { mark: String(latest), ...(accountIds ? { accountIds } : {}) };
  }

  start(account: AccountRow): Promise<string> {
    return this.deps.store.replyCursor(account.id);
  }

  async read(account: AccountRow, cursor: string): Promise<{ items: TriggerItem[]; cursor: string }> {
    return this.page(account, { cursor, sinceHours: 1, limit: 50 });
  }

  async recent(account: AccountRow): Promise<TriggerItem[]> {
    // The store reads oldest first: the last hour first keeps a busy day's newest messages in reach.
    for (const sinceHours of [1, RECENT_HOURS]) {
      const { items } = await this.page(account, { sinceHours, limit: 500 });
      if (items.length) return items.reverse().slice(0, RECENT_ITEMS);
    }
    return [];
  }

  private async page(
    account: AccountRow,
    query: { cursor?: string; sinceHours: number; limit: number },
  ): Promise<{ items: TriggerItem[]; cursor: string }> {
    const page = await this.deps.store.whatsNew([account.id], { ...query, includeOwn: false });
    const items: TriggerItem[] = page.messages
      .filter((m) => m.direction === 'in' && !m.deleted)
      .map((m) => ({
        source: 'message',
        service: account.connectorId,
        account: account.name,
        id: m.id,
        chat: m.chatId,
        chatTitle: m.chatTitle,
        ...(m.sender?.name || m.sender?.id ? { from: m.sender.name ?? m.sender.id } : {}),
        text: [m.text, ...m.attachments.map((a) => `[${a.kind}${a.name ? `: ${a.name}` : ''}]`)]
          .filter(Boolean)
          .join(' '),
        at: m.sentAt,
      }));
    return { items, cursor: page.cursor };
  }
}

/** How far back a mailbox read looks before the cursor: mail can arrive with an older date. */
const MAIL_OVERLAP_MS = 10 * 60_000;
const MAIL_PAGE = 20;

/** New email in any mailbox that implements `mail.search` (Gmail, Outlook, IMAP…). */
export class MailSource implements EventSource {
  readonly source = 'mail' as const;

  constructor(
    private readonly deps: {
      accounts: AccountService;
      connectors: ConnectorResolver;
      logger: Logger;
    },
  ) {}

  accounts(workspaceId: string): Promise<AccountRow[]> {
    return readable(this.deps.accounts, this, workspaceId);
  }

  async reads(account: AccountRow): Promise<boolean> {
    return (await capabilityAction(this.deps.connectors, account, 'mail.search')) !== undefined;
  }

  /** `!` marks a cursor no read has moved yet: nothing at or before it is new (no overlap). */
  async start(): Promise<string> {
    return `!${new Date().toISOString()}`;
  }

  async recent(account: AccountRow, signal: AbortSignal, options: ReadOptions = {}): Promise<TriggerItem[]> {
    const since = Date.now() - RECENT_HOURS * 3_600_000 + MAIL_OVERLAP_MS;
    const { items } = await this.read(account, `!${new Date(since).toISOString()}`, signal, options);
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, RECENT_ITEMS);
  }

  async read(
    account: AccountRow,
    cursor: string,
    signal: AbortSignal,
    options: ReadOptions = {},
  ): Promise<ReadResult> {
    const [result] = await this.readMany(account, [{ cursor, options }], signal);
    return result ?? { items: [], cursor };
  }

  /**
   * One fetch of the mailbox for every cursor on it: the search starts at the earliest cursor (and
   * covers spam when any request asks), then each request takes what is new past its own cursor.
   */
  async readMany(account: AccountRow, requests: ReadRequest[], signal: AbortSignal): Promise<ReadResult[]> {
    const found = await capabilityAction(this.deps.connectors, account, 'mail.search');
    if (!found || requests.length === 0) return requests.map(({ cursor }) => ({ items: [], cursor }));
    const now = Date.now();
    const cursors = requests.map(({ cursor }) => {
      const strict = cursor.startsWith('!');
      return { strict, after: Date.parse(strict ? cursor.slice(1) : cursor) || now };
    });
    const since = new Date(Math.min(...cursors.map((c) => c.after)) - MAIL_OVERLAP_MS);
    const ctx = await this.deps.accounts.buildContext(found.connector as ConnectorDefinition, account, {
      signal,
      logger: this.deps.logger.child({ connector: account.connectorId, account: account.id }),
    });
    // New mail is what lands in the inbox (not the user's own sent mail), and in spam when asked.
    const folders = requests.some((r) => r.options?.spam)
      ? (['inbox', 'junk'] as const)
      : (['inbox'] as const);
    const capability = getCapability('mail.search');
    const mail: Record<string, FetchedMail[]> = {};
    for (const folder of folders) {
      const canonical = { since: since.toISOString(), limit: MAIL_PAGE, folder };
      const input = found.binding.mapInput ? found.binding.mapInput(canonical) : canonical;
      try {
        const raw = await found.action.run(found.action.input.parse(input), ctx);
        const output = found.binding.mapOutput ? found.binding.mapOutput(raw, canonical) : raw;
        mail[folder] = ((listOf(output)?.items ?? []) as Array<Record<string, unknown>>).flatMap((entry) => {
          const parsed = capability?.output.safeParse(entry);
          const item = (parsed?.success ? parsed.data : entry) as Omit<FetchedMail, 'at'> & { date?: string };
          return item.id ? [{ ...item, at: Date.parse(item.date ?? '') || now }] : [];
        });
      } catch (error) {
        // A mailbox without a spam folder still delivers its inbox.
        if (folder === 'inbox' || !(error instanceof ConnectorError && error.kind === 'not_found'))
          throw error;
      }
    }
    return requests.map((request, index) => {
      const { strict, after } = cursors[index]!;
      const list = [...(mail.inbox ?? []), ...(request.options?.spam ? (mail.junk ?? []) : [])];
      let newest = after;
      const items: TriggerItem[] = [];
      for (const entry of list) {
        newest = Math.max(newest, entry.at);
        // Items at or before the cursor were seen by an earlier read; the overlap only catches late
        // arrivals, and the event key keeps a repeat from firing twice.
        if (strict ? entry.at <= after : entry.at < after - MAIL_OVERLAP_MS) continue;
        items.push({
          source: 'mail',
          service: account.connectorId,
          account: account.name,
          id: entry.id,
          ...(entry.from ? { from: entry.from } : {}),
          ...(entry.subject ? { subject: entry.subject } : {}),
          text: entry.snippet ?? '',
          ...(entry.bulk ? { bulk: true } : {}),
          at: new Date(entry.at).toISOString(),
        });
      }
      return { items, cursor: new Date(newest).toISOString() };
    });
  }
}

/** A message as `mail.search` returned it, with its date parsed. */
interface FetchedMail {
  id: string;
  from?: string;
  subject?: string;
  snippet?: string;
  bulk?: boolean;
  at: number;
}

/** An event that started while the hub was not looking still counts for this long (a late pass). */
const CALENDAR_LATE_MS = 5 * 60_000;
const CALENDAR_PAGE = 100;

/** Where a trigger stands on a calendar: when it last looked, and the upcoming events it already took. */
interface CalendarCursor {
  at: number;
  seen: string[];
}

const calendarCursor = (cursor: string, now: number): CalendarCursor => {
  try {
    const parsed = JSON.parse(cursor) as { at?: unknown; seen?: unknown };
    const at = typeof parsed.at === 'string' ? Date.parse(parsed.at) : Number.NaN;
    const seen = Array.isArray(parsed.seen) ? parsed.seen.filter((k) => typeof k === 'string') : [];
    return { at: Number.isNaN(at) ? now : Math.min(at, now), seen };
  } catch {
    return { at: now, seen: [] };
  }
};

/**
 * Events about to start in any calendar that implements `calendar.list_events` (Google Calendar,
 * Outlook, Calendly…). The feed of a calendar is "an event starts within N minutes" (each trigger
 * picks its N, see `minutes_before`): an event appears in it once, when its start comes within
 * reach. Events made or moved into that window later are found too, because every read looks at
 * the whole window again and the cursor remembers which of its events were already taken. All-day
 * events have no start time and are not part of the feed.
 */
export class CalendarSource implements EventSource {
  readonly source = 'calendar' as const;

  constructor(
    private readonly deps: {
      accounts: AccountService;
      connectors: ConnectorResolver;
      logger: Logger;
    },
  ) {}

  accounts(workspaceId: string): Promise<AccountRow[]> {
    return readable(this.deps.accounts, this, workspaceId);
  }

  async reads(account: AccountRow): Promise<boolean> {
    return (await capabilityAction(this.deps.connectors, account, 'calendar.list_events')) !== undefined;
  }

  async start(): Promise<string> {
    return JSON.stringify({ at: new Date().toISOString(), seen: [] });
  }

  /** What starts in the next day, soonest first (there is nothing to try a trigger on in the past). */
  async recent(account: AccountRow, signal: AbortSignal): Promise<TriggerItem[]> {
    const now = Date.now();
    const events = await this.fetch(account, now, now + RECENT_HOURS * 3_600_000, signal);
    return events.slice(0, RECENT_ITEMS).map((event) => this.item(account, event));
  }

  async read(
    account: AccountRow,
    cursor: string,
    signal: AbortSignal,
    options: ReadOptions = {},
  ): Promise<ReadResult> {
    const [result] = await this.readMany(account, [{ cursor, options }], signal);
    return result ?? { items: [], cursor };
  }

  /** One fetch of the calendar for every trigger on it: the widest window, then each takes its own. */
  async readMany(account: AccountRow, requests: ReadRequest[], signal: AbortSignal): Promise<ReadResult[]> {
    if (requests.length === 0) return [];
    const now = Date.now();
    const windows = requests.map(({ cursor, options }) => {
      const { at, seen } = calendarCursor(cursor, now);
      return {
        seen: new Set(seen),
        after: Math.max(at, now - CALENDAR_LATE_MS),
        until: now + (options?.minutesBefore ?? DEFAULT_MINUTES_BEFORE) * 60_000,
      };
    });
    const events = await this.fetch(
      account,
      Math.min(...windows.map((w) => w.after)),
      Math.max(...windows.map((w) => w.until)),
      signal,
    );
    return windows.map(({ seen, after, until }) => {
      const within = events.filter((e) => e.at > after && e.at <= until);
      return {
        items: within.filter((e) => !seen.has(e.key)).map((e) => this.item(account, e)),
        // Events that have started fall out of the next window by their time; the rest by name.
        cursor: JSON.stringify({
          at: new Date(now).toISOString(),
          seen: within.filter((e) => e.at > now).map((e) => e.key),
        }),
      };
    });
  }

  /** Timed events that start in (after, until], soonest first. */
  private async fetch(
    account: AccountRow,
    after: number,
    until: number,
    signal: AbortSignal,
  ): Promise<FetchedEvent[]> {
    const found = await capabilityAction(this.deps.connectors, account, 'calendar.list_events');
    if (!found) return [];
    const ctx = await this.deps.accounts.buildContext(found.connector as ConnectorDefinition, account, {
      signal,
      logger: this.deps.logger.child({ connector: account.connectorId, account: account.id }),
    });
    const canonical = {
      from: new Date(after).toISOString(),
      to: new Date(until).toISOString(),
      limit: CALENDAR_PAGE,
    };
    const input = found.binding.mapInput ? found.binding.mapInput(canonical) : canonical;
    const raw = await found.action.run(found.action.input.parse(input), ctx);
    const output = found.binding.mapOutput ? found.binding.mapOutput(raw, canonical) : raw;
    const capability = getCapability('calendar.list_events');
    const events: FetchedEvent[] = [];
    for (const entry of (listOf(output)?.items ?? []) as Array<Record<string, unknown>>) {
      const parsed = capability?.output.safeParse(entry);
      if (!parsed?.success) continue;
      const event = parsed.data as Omit<FetchedEvent, 'at' | 'key'>;
      const at = Date.parse(event.start);
      // A calendar answers with everything that overlaps the range: keep what starts inside it.
      if (event.all_day || Number.isNaN(at) || at <= after || at > until) continue;
      events.push({ ...event, at, key: `${event.id}@${at}` });
    }
    return events.sort((a, b) => a.at - b.at);
  }

  private item(account: AccountRow, event: FetchedEvent): TriggerItem {
    return {
      source: 'calendar',
      service: account.connectorId,
      account: account.name,
      id: event.id,
      subject: event.title,
      text: [`Starts ${event.start}`, event.location, event.attendees?.join(', ')]
        .filter(Boolean)
        .join(' · '),
      at: new Date(event.at).toISOString(),
    };
  }
}

/** An event as `calendar.list_events` returned it, with its start parsed. */
interface FetchedEvent {
  id: string;
  title: string;
  start: string;
  all_day?: boolean;
  location?: string;
  attendees?: string[];
  at: number;
  /** The event at this start: an event moved to another time is a new one for the feed. */
  key: string;
}
