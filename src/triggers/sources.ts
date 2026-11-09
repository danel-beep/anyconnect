import { getCapability } from '../connectors/capabilities.js';
import type { ConnectorResolver } from '../connectors/registry.js';
import { actionCapabilities, type ConnectorDefinition, ConnectorError } from '../connectors/sdk.js';
import type { AccountRow, AccountService } from '../core/accounts.js';
import { listOf } from '../hub/merge.js';
import { isSetupConnector } from '../hub/setup-tools.js';
import type { Logger } from '../logger.js';
import type { MessageStore } from '../messaging/store.js';
import type { TriggerItem } from './spec.js';

/**
 * Where events come from. A source lists the accounts it can read, gives a cursor at the current
 * end of an account's feed (a new trigger never fires on old items) and reads what came after a
 * cursor. Messengers read the hub's own synced copy (free, instant); mailboxes are asked through
 * the shared `mail.search` interface on a schedule. A new source (calendar, webhooks) is one more
 * implementation registered with the engine.
 */
export interface EventSource {
  source: TriggerItem['source'];
  /** Accounts of the workspace this source reads (enabled ones). */
  accounts(workspaceId: string): Promise<AccountRow[]>;
  start(account: AccountRow): Promise<string>;
  read(
    account: AccountRow,
    cursor: string,
    signal: AbortSignal,
    options?: ReadOptions,
  ): Promise<{ items: TriggerItem[]; cursor: string }>;
}

/** What one trigger reads beyond the default (each trigger has its own cursor on each account). */
export interface ReadOptions {
  /** Mail: the spam folder too. */
  spam?: boolean;
}

/** Incoming messenger messages (Telegram, WhatsApp, bots…) from the hub's message store. */
export class MessageSource implements EventSource {
  readonly source = 'message' as const;

  constructor(
    private readonly deps: { accounts: AccountService; connectors: ConnectorResolver; store: MessageStore },
  ) {}

  async accounts(workspaceId: string): Promise<AccountRow[]> {
    const rows = await this.deps.accounts.list(workspaceId);
    const out: AccountRow[] = [];
    for (const row of rows) {
      if (!row.enabled) continue;
      const connector = await this.deps.connectors.get(workspaceId, row.connectorId);
      if (connector?.messenger) out.push(row);
    }
    return out;
  }

  start(account: AccountRow): Promise<string> {
    return this.deps.store.replyCursor(account.id);
  }

  async read(account: AccountRow, cursor: string): Promise<{ items: TriggerItem[]; cursor: string }> {
    const page = await this.deps.store.whatsNew([account.id], {
      cursor,
      sinceHours: 1,
      includeOwn: false,
      limit: 50,
    });
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

  private async searchAction(workspaceId: string, connectorId: string) {
    if (isSetupConnector(connectorId)) return undefined;
    const connector = await this.deps.connectors.get(workspaceId, connectorId);
    if (!connector || connector.messenger) return undefined;
    for (const action of connector.actions) {
      const binding = actionCapabilities(action).find((b) => b.id === 'mail.search');
      if (binding) return { connector, action, binding };
    }
    return undefined;
  }

  async accounts(workspaceId: string): Promise<AccountRow[]> {
    const rows = await this.deps.accounts.list(workspaceId);
    const out: AccountRow[] = [];
    for (const row of rows)
      if (row.enabled && (await this.searchAction(workspaceId, row.connectorId))) out.push(row);
    return out;
  }

  /** `!` marks a cursor no read has moved yet: nothing at or before it is new (no overlap). */
  async start(): Promise<string> {
    return `!${new Date().toISOString()}`;
  }

  async read(
    account: AccountRow,
    cursor: string,
    signal: AbortSignal,
    options: ReadOptions = {},
  ): Promise<{ items: TriggerItem[]; cursor: string }> {
    const found = await this.searchAction(account.workspaceId, account.connectorId);
    if (!found) return { items: [], cursor };
    const strict = cursor.startsWith('!');
    const after = Date.parse(strict ? cursor.slice(1) : cursor) || Date.now();
    const since = new Date(after - MAIL_OVERLAP_MS);
    const ctx = await this.deps.accounts.buildContext(found.connector as ConnectorDefinition, account, {
      signal,
      logger: this.deps.logger.child({ connector: account.connectorId, account: account.id }),
    });
    // New mail is what lands in the inbox (not the user's own sent mail), and in spam when asked.
    const list: Array<Record<string, unknown>> = [];
    for (const folder of options.spam ? ['inbox', 'junk'] : ['inbox']) {
      const canonical = { since: since.toISOString(), limit: MAIL_PAGE, folder };
      const input = found.binding.mapInput ? found.binding.mapInput(canonical) : canonical;
      try {
        const raw = await found.action.run(found.action.input.parse(input), ctx);
        const output = found.binding.mapOutput ? found.binding.mapOutput(raw, canonical) : raw;
        list.push(...((listOf(output)?.items ?? []) as Array<Record<string, unknown>>));
      } catch (error) {
        // A mailbox without a spam folder still delivers its inbox.
        if (folder === 'inbox' || !(error instanceof ConnectorError && error.kind === 'not_found'))
          throw error;
      }
    }
    const capability = getCapability('mail.search');
    let newest = after;
    const items: TriggerItem[] = [];
    for (const entry of list) {
      const parsed = capability?.output.safeParse(entry);
      const mail = (parsed?.success ? parsed.data : entry) as {
        id?: string;
        from?: string;
        subject?: string;
        snippet?: string;
        date?: string;
        bulk?: boolean;
      };
      if (!mail.id) continue;
      const at = Date.parse(mail.date ?? '') || Date.now();
      newest = Math.max(newest, at);
      // Items at or before the cursor were seen by an earlier read; the overlap only catches late
      // arrivals, and the event key keeps a repeat from firing twice.
      if (strict ? at <= after : at < after - MAIL_OVERLAP_MS) continue;
      items.push({
        source: 'mail',
        service: account.connectorId,
        account: account.name,
        id: mail.id,
        ...(mail.from ? { from: mail.from } : {}),
        ...(mail.subject ? { subject: mail.subject } : {}),
        text: mail.snippet ?? '',
        ...(mail.bulk ? { bulk: true } : {}),
        at: new Date(at).toISOString(),
      });
    }
    return { items, cursor: new Date(Math.max(newest, after)).toISOString() };
  }
}
