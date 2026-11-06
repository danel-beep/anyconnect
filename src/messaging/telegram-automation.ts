import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BRAND } from '../brand.js';
import type { TelegramBotConnection, TelegramHubBot } from '../connectors/builtin/telegram-bot.js';
import { DeliveryError } from '../connectors/messaging.js';
import { ConnectorError } from '../connectors/sdk.js';
import { ACCOUNT_NAME, type AccountRow, type AccountService } from '../core/accounts.js';
import type { ConnectPermissions } from '../core/connect.js';
import type { QuickConnectFlow, QuickConnectStart } from '../core/quick-connect.js';
import type { Db } from '../db/client.js';
import {
  accounts,
  type ConnectDraft,
  type TelegramLinkState,
  telegramConnections,
  telegramLinks,
  users,
  workspaces,
} from '../db/schema.js';
import { hashToken, type SecretBox, safeEqual } from '../lib/crypto.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { Logger } from '../logger.js';
import { pickLocale } from '../security/confirmations.js';
import {
  type BotUpdateHandler,
  escapeHtml,
  type InlineButton,
  RetryUpdateError,
  type TelegramBot,
} from '../security/telegram.js';
import type { Locale, Translate } from '../web/i18n.js';
import type { MessengerKeys } from './keys.js';
import type { MessagingService } from './service.js';

/**
 * Telegram Chat Automation: a person connects their own Telegram account to the hub by adding the
 * hub's bot under Settings → Chat Automation, with no api_id, password or code typed anywhere.
 *
 * 1. The connect page shows a one-time link to the bot as a QR code (`start`, 15 minutes).
 * 2. The person opens it in Telegram: the bot names the hub account the link connects to and sends
 *    a 6-digit code, which the signed-in user types on the link's page. Only the Telegram user who
 *    opened the link first gets the code, and only the link's creator can type it, so a QR code sent
 *    by someone else cannot connect a person's chats to the sender's account.
 * 3. They add the bot under Chat Automation (before or after step 2). Telegram reports the
 *    business connection; the hub creates (or reconnects) the account and the page says Connected.
 *
 * Updates of a connection are routed to its account's transport (`MessagingService.route`), and
 * the connector reaches the Bot API through this class ({@link TelegramHubBot}), which adds the
 * account's business connection to each request. Telegram ids are stored only as keyed hashes; the
 * connection id and the person's name are encrypted. See docs/MESSENGERS.md.
 */

/** How long a QR code works, until it is opened in Telegram and confirmed. */
export const LINK_TTL_MS = 15 * 60_000;
/** How long the person has to add the bot under Chat Automation after confirming. */
const CONFIRMED_TTL_MS = 30 * 60_000;
const IN_PROGRESS: TelegramLinkState[] = ['pending', 'opened', 'confirmed'];
/** Wrong codes on the page before the link stops working. */
export const CODE_ATTEMPTS = 5;

/** `/start c_<code>`: the deep link of a QR code (Telegram allows 64 characters of [A-Za-z0-9_-]). */
const START = /^c_([A-Za-z0-9_-]{32})$/;
/** Telegram's "Manage bot" button in a business chat opens the bot with `/start bizChat<chat id>`. */
const MANAGE_START = /^bizChat\d+$/;
/** Cancel under the bot's question (connecting is confirmed with the code on the page). */
const LINK_CALLBACK = /^tgl:(tgl_[0-9a-z]{26}):n$/;
const CONNECTION_CALLBACK = /^tgc:(tgc_[0-9a-z]{26}):x$/;

/**
 * Bot API methods an account may call through the hub's bot, and whether the call goes on the
 * account's business connection (the hub adds `business_connection_id`). Anything else, such as
 * changing the bot or its webhook, is refused.
 */
const METHODS: Readonly<Record<string, boolean>> = {
  sendMessage: true,
  sendPhoto: true,
  sendDocument: true,
  sendVideo: true,
  sendAudio: true,
  sendVoice: true,
  sendChatAction: true,
  readBusinessMessage: true,
  getFile: false,
};

/** Account statuses (shown in the dashboard and to the AI). */
const STATUS = {
  notConnected: 'This Telegram account is no longer connected through Chat Automation: connect it again.',
  paused:
    'The bot is removed or paused in Telegram (Settings → Chat Automation): add it again or connect the account again.',
  moved: 'This Telegram account was connected to another account: connect it again to use it here.',
  disconnected: 'Disconnected in Telegram: connect it again to get new messages.',
};

export type TelegramLinkRow = typeof telegramLinks.$inferSelect;
type ConnectionRow = typeof telegramConnections.$inferSelect;

/** What a link's `telegramEncrypted` holds: the opener's private chat and how the page names them. */
interface LinkTelegram {
  chat: string;
  label: string;
}

/** What typing the bot's code on the page came to. */
export type ConfirmResult = 'confirmed' | 'wrong' | 'failed' | 'expired';

/** What `infoEncrypted` holds. */
interface ConnectionInfo {
  connectionId: string;
  userChatId: number;
  username?: string;
  name?: string;
}

const TgUser = z.object({
  id: z.number(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});
type TgUser = z.infer<typeof TgUser>;

const BusinessConnection = z.object({
  id: z.string().min(1),
  user: TgUser,
  user_chat_id: z.number(),
  date: z.number(),
  /** BusinessBotRights (Bot API 9.0 and later): flags that are on. */
  rights: z.record(z.string(), z.unknown()).optional(),
  /** Before Bot API 9.0, the only right. */
  can_reply: z.boolean().optional(),
  is_enabled: z.boolean(),
});
type BusinessConnection = z.infer<typeof BusinessConnection>;

const Routed = z.object({ business_connection_id: z.string().min(1) });

const StartMessage = z.object({
  message_id: z.number(),
  chat: z.object({ id: z.number(), type: z.string() }),
  from: TgUser.optional(),
  text: z.string().optional(),
});
type StartMessage = z.infer<typeof StartMessage>;

const Callback = z.object({
  id: z.string(),
  from: TgUser,
  data: z.string().optional(),
  message: z.object({ message_id: z.number(), chat: z.object({ id: z.number() }) }).optional(),
});
type Callback = z.infer<typeof Callback>;

/** The parts of a bot update this class takes; anything else goes to the next handler. */
const Update = z.object({
  business_connection: BusinessConnection.optional(),
  business_message: Routed.optional(),
  edited_business_message: Routed.optional(),
  deleted_business_messages: Routed.optional(),
  message: StartMessage.optional(),
  callback_query: Callback.optional(),
});

/** `d•••@gmail.com`: enough for a person to recognise their own address, not to learn someone else's. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 1 ? '•••' : `${email.slice(0, 1)}•••${email.slice(at)}`;
}

function fullName(user: Pick<TgUser, 'first_name' | 'last_name'>): string | undefined {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || undefined;
}

/** @username, else the name, as the account's identity. */
function identityOf(info: Pick<ConnectionInfo, 'username' | 'name'>): string {
  return info.username ? `@${info.username}` : (info.name ?? 'Telegram');
}

function rightsOf(connection: BusinessConnection): string[] {
  if (!connection.rights) return connection.can_reply ? ['can_reply'] : [];
  return Object.entries(connection.rights)
    .filter(([, on]) => on === true)
    .map(([name]) => name)
    .sort();
}

/** The request with the account's business connection added. */
function onConnection(
  params: Record<string, unknown> | FormData,
  connectionId: string,
): Record<string, unknown> | FormData {
  if (!(params instanceof FormData)) return { ...params, business_connection_id: connectionId };
  const form = new FormData();
  for (const [key, value] of params) form.append(key, value);
  form.set('business_connection_id', connectionId);
  return form;
}

/** A link as the connect page shows it. */
export interface TelegramLinkView {
  id: string;
  /** `expired`: the QR code or the time for the last step ran out. */
  state: TelegramLinkState | 'expired';
  /** The hub's bot, `@username`. */
  bot: string;
  /** `https://t.me/<bot>?start=…` while the link waits to be opened and confirmed in Telegram. */
  deepLink?: string;
  /** Who opened the link in Telegram (@username or name). */
  telegram?: string;
  /** The account, once connected. */
  accountId?: string;
  /** Why connecting failed, when it was the user's to fix (a plan limit); otherwise undefined. */
  error?: string;
  /** Failed because the code was typed wrong too many times. */
  tooManyCodes?: boolean;
  workspaceId: string;
  draft: ConnectDraft;
  reconnectAccountId?: string;
  returnTo?: string;
  createdAt: Date;
}

/** What attaching a connection to an account came to (undefined: another update is doing it). */
type AttachOutcome =
  | { ok: true; account: AccountRow; created: boolean; connection: ConnectionRow }
  | { ok: false; reason: string | undefined };

export interface TelegramAutomationDeps {
  db: Db;
  bot: TelegramBot;
  keys: MessengerKeys;
  secrets: SecretBox;
  accounts: AccountService;
  /** Who may connect and reconnect accounts (teams). */
  permissions: ConnectPermissions;
  /** Where routed business updates go (the account's transport stores them). */
  messaging: MessagingService;
  publicUrl: string;
  t: (locale: Locale) => Translate;
  logger: Logger;
  /** Unexpected errors: the hub's error tracker. */
  capture: (error: unknown, context: Record<string, string>) => void;
  /** An account was connected (or connected again) through the bot. */
  onConnected?: (account: AccountRow, created: boolean) => void;
}

export class TelegramAutomation implements TelegramHubBot, QuickConnectFlow {
  readonly connectorId = 'telegram_bot';

  constructor(private readonly deps: TelegramAutomationDeps) {}

  // --- Quick connect --------------------------------------------------------

  /** Secretary Mode is on for the hub's bot in @BotFather, so people can add it to their account. */
  async available(): Promise<boolean> {
    return (await this.deps.bot.me()).can_connect_to_business === true;
  }

  reconnects(account: AccountRow): boolean {
    return account.connectorId === this.connectorId && account.config.bot === 'hub';
  }

  async start(input: QuickConnectStart): Promise<string> {
    const { db, permissions } = this.deps;
    if (input.reconnect) {
      if (input.reconnect.workspaceId !== input.workspaceId || !this.reconnects(input.reconnect)) {
        throw conflict('This account is not connected through Telegram Chat Automation.');
      }
      await permissions.assertCanManage(input.workspaceId, input.userId, input.reconnect);
    } else {
      if (input.name !== undefined && !ACCOUNT_NAME.test(input.name)) {
        throw badRequest('Account names use 1-32 lowercase letters, digits, "-" or "_".');
      }
      await permissions.assertCanConnect(input.workspaceId, input.userId, input.owner);
      // The plan of whoever the account will count for: a team account (owner null) the team's payer.
      await this.deps.accounts.assertCanCreate(
        input.workspaceId,
        input.owner ? input.owner.userId : input.userId,
      );
    }
    // One QR code at a time per person: a new one stops older ones that are not confirmed yet. A
    // confirmed one only waits for Telegram, so opening the page again does not lose it.
    await db
      .update(telegramLinks)
      .set({ state: 'cancelled' })
      .where(
        and(eq(telegramLinks.userId, input.userId), inArray(telegramLinks.state, ['pending', 'opened'])),
      );
    const id = newId('tgl');
    const code = randomBytes(24).toString('base64url');
    const label = input.label?.trim().slice(0, 100);
    await db.insert(telegramLinks).values({
      id,
      codeHash: hashToken(code),
      codeEncrypted: this.deps.secrets.encrypt(code, linkContext(id)),
      workspaceId: input.workspaceId,
      userId: input.userId,
      draft: {
        ...(input.name && !input.reconnect ? { name: input.name } : {}),
        ...(label && !input.reconnect ? { label } : {}),
        ...(input.owner ? { owner: input.owner } : {}),
      },
      reconnectAccountId: input.reconnect?.id ?? null,
      returnTo: input.returnTo ?? null,
      locale: input.locale,
      expiresAt: new Date(Date.now() + LINK_TTL_MS),
    });
    return `/connect/telegram/link/${id}`;
  }

  /** The link for its page; undefined unless `userId` made it. */
  async view(userId: string, linkId: string): Promise<TelegramLinkView | undefined> {
    const link = await this.link(linkId);
    if (!link || link.userId !== userId) return undefined;
    const bot = (await this.deps.bot.me()).username;
    const state = this.stateOf(link);
    return {
      id: link.id,
      state,
      bot: `@${bot}`,
      ...(state === 'pending' || state === 'opened'
        ? {
            deepLink: `https://t.me/${bot}?start=c_${this.deps.secrets.decrypt(link.codeEncrypted, linkContext(link.id))}`,
          }
        : {}),
      ...(link.telegramEncrypted ? { telegram: this.linkTelegram(link).label } : {}),
      ...(link.accountId ? { accountId: link.accountId } : {}),
      ...(link.error ? { error: link.error } : {}),
      ...(link.confirmAttempts >= CODE_ATTEMPTS ? { tooManyCodes: true } : {}),
      workspaceId: link.workspaceId,
      draft: link.draft,
      ...(link.reconnectAccountId ? { reconnectAccountId: link.reconnectAccountId } : {}),
      ...(link.returnTo ? { returnTo: link.returnTo } : {}),
      createdAt: link.createdAt,
    };
  }

  /** Where the link is now, for the page to follow (it asks every few seconds). */
  async state(userId: string, linkId: string): Promise<TelegramLinkView['state'] | undefined> {
    const link = await this.link(linkId);
    return link && link.userId === userId ? this.stateOf(link) : undefined;
  }

  /** Cancelled on the page. */
  async cancel(userId: string, linkId: string): Promise<void> {
    await this.deps.db
      .update(telegramLinks)
      .set({ state: 'cancelled' })
      .where(
        and(
          eq(telegramLinks.id, linkId),
          eq(telegramLinks.userId, userId),
          inArray(telegramLinks.state, IN_PROGRESS),
        ),
      );
  }

  /**
   * The signed-in user typed the bot's code on the link's page. Right: the link is confirmed, and
   * the account connects now if the bot is already added (else when Telegram reports it). Wrong
   * {@link CODE_ATTEMPTS} times: the link fails. Undefined unless `userId` made the link.
   */
  async confirm(userId: string, linkId: string, code: string): Promise<ConfirmResult | undefined> {
    const { db } = this.deps;
    const link = await this.link(linkId);
    if (!link || link.userId !== userId) return undefined;
    if (this.stateOf(link) !== 'opened' || !link.confirmCodeHash || !link.telegramUserKey) return 'expired';
    if (!safeEqual(codeHash(link.id, code), link.confirmCodeHash)) {
      const [counted] = await db
        .update(telegramLinks)
        .set({
          confirmAttempts: sql`${telegramLinks.confirmAttempts} + 1`,
          state: sql<TelegramLinkState>`case when ${telegramLinks.confirmAttempts} + 1 >= ${CODE_ATTEMPTS} then 'failed' else ${telegramLinks.state} end`,
        })
        .where(and(eq(telegramLinks.id, link.id), eq(telegramLinks.state, 'opened')))
        .returning({ state: telegramLinks.state });
      return counted?.state === 'failed' ? 'failed' : counted ? 'wrong' : 'expired';
    }
    const [confirmed] = await db
      .update(telegramLinks)
      .set({ state: 'confirmed', confirmCodeHash: null, expiresAt: new Date(Date.now() + CONFIRMED_TTL_MS) })
      .where(
        and(
          eq(telegramLinks.id, link.id),
          eq(telegramLinks.state, 'opened'),
          eq(telegramLinks.confirmCodeHash, link.confirmCodeHash),
          gt(telegramLinks.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!confirmed) return 'expired';
    const { chat } = this.linkTelegram(confirmed);
    const t = this.t(confirmed.locale);
    const connection = await this.connectionOfUser(link.telegramUserKey);
    if (connection?.enabled) {
      // Undefined: Telegram's report is attaching it at this moment and tells the person itself.
      const outcome = await this.attach(confirmed, connection);
      if (outcome) await this.send(chat, ...this.outcomeMessage(outcome, t));
      return 'confirmed';
    }
    await this.send(chat, await this.lastStep(t));
    return 'confirmed';
  }

  private stateOf(link: TelegramLinkRow): TelegramLinkView['state'] {
    if (IN_PROGRESS.includes(link.state) && link.expiresAt.getTime() <= Date.now()) return 'expired';
    if (link.state === 'connected' && !link.accountId) {
      // The account is being made (a moment), or was deleted since: nothing left to wait for.
      return link.updatedAt.getTime() > Date.now() - 60_000 ? 'confirmed' : 'expired';
    }
    return link.state;
  }

  // --- Bot updates ----------------------------------------------------------

  /** Takes the updates of Chat Automation and of its links; the rest goes to the next handler. */
  readonly handleUpdate: BotUpdateHandler = async (raw) => {
    const parsed = Update.safeParse(raw);
    if (!parsed.success) return false;
    const update = parsed.data;
    if (update.business_connection) {
      try {
        await this.onConnection(update.business_connection);
      } catch (error) {
        // Saving it is idempotent: without it, the connection's messages would be dropped for good.
        throw new RetryUpdateError('Telegram business connection not saved', { cause: error });
      }
      return true;
    }
    const routed =
      update.business_message ?? update.edited_business_message ?? update.deleted_business_messages;
    if (routed) {
      await this.onBusinessUpdate(routed.business_connection_id, raw);
      return true;
    }
    const message = update.message;
    const text = message?.text?.trim();
    if (message && message.chat.type === 'private' && text?.startsWith('/start')) {
      const payload = text.slice('/start'.length).trim();
      const code = START.exec(payload)?.[1];
      if (code) {
        await this.onStart(code, message);
        return true;
      }
      if (MANAGE_START.test(payload)) {
        await this.onManage(message);
        return true;
      }
      return false;
    }
    const callback = update.callback_query;
    if (callback?.data && (LINK_CALLBACK.test(callback.data) || CONNECTION_CALLBACK.test(callback.data))) {
      await this.onCallback(callback, callback.data);
      return true;
    }
    return false;
  };

  /** A message in a chat the person shared with the bot: stored for the connected account only. */
  private async onBusinessUpdate(connectionId: string, raw: unknown): Promise<void> {
    try {
      const [row] = await this.deps.db
        .select()
        .from(telegramConnections)
        .where(eq(telegramConnections.connectionKey, this.connectionKey(connectionId)))
        .limit(1);
      // Not connected to an account (yet, or any more): the message is not kept anywhere.
      if (!row?.accountId || !row.enabled) return;
      await this.deps.messaging.route(row.accountId, raw);
    } catch (error) {
      // Storing is idempotent: Telegram delivers the update again and nothing is lost or doubled.
      throw new RetryUpdateError('Telegram business update not stored', { cause: error });
    }
  }

  /** The person opened a QR code's link in Telegram. */
  private async onStart(linkCode: string, message: StartMessage): Promise<void> {
    const chat = String(message.chat.id);
    const from = message.from;
    const link = await this.linkByCode(linkCode);
    const t = this.t(link?.locale, from?.language_code);
    if (!from || !link || this.stateOf(link) === 'expired' || !IN_PROGRESS.includes(link.state)) {
      return this.send(chat, escapeHtml(t('bot.tc.expired')));
    }
    const userKey = this.userKey(from.id);
    if (link.reconnectAccountId && !(await this.mayReconnect(link.reconnectAccountId, userKey))) {
      return this.send(chat, escapeHtml(t('bot.tc.otherAccount', { brand: BRAND.name })));
    }
    // The same code each time this person opens the link (a second scan does not void the first
    // message); only its hash is kept.
    const code = this.confirmCode(link.id, userKey);
    const telegram: LinkTelegram = {
      chat,
      label: identityOf({ username: from.username, name: fullName(from) }),
    };
    // The first Telegram account to open a link owns it: a leaked QR code is no use to anyone else.
    const [claimed] = await this.deps.db
      .update(telegramLinks)
      .set({
        state: sql<TelegramLinkState>`case when ${telegramLinks.state} = 'pending' then 'opened' else ${telegramLinks.state} end`,
        telegramUserKey: userKey,
        telegramEncrypted: this.deps.secrets.encryptJson(telegram, linkContext(link.id)),
        confirmCodeHash: sql`case when ${telegramLinks.state} = 'confirmed' then ${telegramLinks.confirmCodeHash} else ${codeHash(link.id, code)} end`,
      })
      .where(
        and(
          eq(telegramLinks.id, link.id),
          or(isNull(telegramLinks.telegramUserKey), eq(telegramLinks.telegramUserKey, userKey)),
          inArray(telegramLinks.state, IN_PROGRESS),
          gt(telegramLinks.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!claimed) return this.send(chat, escapeHtml(t('bot.tc.otherUser')));
    if (claimed.state === 'confirmed') return this.send(chat, await this.lastStep(t));
    await this.send(chat, await this.prompt(claimed, userKey, code, t), this.promptButtons(claimed, t));
  }

  /**
   * The code for a link and the Telegram user who opened it: derived with the hub's key, so it is
   * stable across reopens and cannot be worked out from the link id alone.
   */
  private confirmCode(linkId: string, userKey: string): string {
    const digest = Buffer.from(
      this.deps.keys.hubLookupKey('telegram/link-code', `${linkId}:${userKey}`),
      'base64url',
    );
    return String(digest.readUIntBE(0, 6) % 1_000_000).padStart(6, '0');
  }

  /**
   * An account to connect again goes back to the Telegram account it had (bound when it was first
   * connected), never to another one whose chats would mix with its history.
   */
  private async mayReconnect(accountId: string, userKey: string): Promise<boolean> {
    const [account] = await this.deps.db
      .select({ metadata: accounts.metadata })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    const bound = account?.metadata.telegramUserKey;
    return typeof bound !== 'string' || bound === userKey;
  }

  /**
   * "Connect this Telegram account to <hub account>?" with the code to type on the page, and a
   * warning when the Telegram account moves from another hub account.
   */
  private async prompt(link: TelegramLinkRow, userKey: string, code: string, t: Translate): Promise<string> {
    const account = await this.ownerText(link.workspaceId, link.userId, t);
    const lines = [t('bot.tc.confirm', { brand: BRAND.name, account: escapeHtml(account), code })];
    const connection = await this.connectionOfUser(userKey);
    if (connection?.accountId && connection.accountId !== link.reconnectAccountId) {
      const [current] = await this.deps.db
        .select({ workspaceId: accounts.workspaceId })
        .from(accounts)
        .where(eq(accounts.id, connection.accountId))
        .limit(1);
      if (current && current.workspaceId !== link.workspaceId) {
        lines.push(escapeHtml(t('bot.tc.moves', { brand: BRAND.name })));
      }
    }
    return lines.join('\n\n');
  }

  private promptButtons(link: TelegramLinkRow, t: Translate): InlineButton[][] {
    return [[{ text: t('bot.tc.cancel'), callback_data: `tgl:${link.id}:n` }]];
  }

  private async lastStep(t: Translate): Promise<string> {
    const bot = (await this.deps.bot.me()).username;
    return t('bot.tc.lastStep', { bot: escapeHtml(`@${bot}`) });
  }

  /** The hub account a link connects to, as the bot names it: a masked email (and the team). */
  private async ownerText(workspaceId: string, userId: string | null, t: Translate): Promise<string> {
    const [[workspace], [owner]] = await Promise.all([
      this.deps.db
        .select({ kind: workspaces.kind, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1),
      userId
        ? this.deps.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1)
        : Promise.resolve([]),
    ]);
    const email = owner ? maskEmail(owner.email) : '';
    if (workspace?.kind !== 'team') return email;
    return email ? t('bot.tc.team', { email, team: workspace.name }) : workspace.name;
  }

  private async onCallback(callback: Callback, data: string): Promise<void> {
    const link = LINK_CALLBACK.exec(data);
    if (link) return this.onCancel(callback, link[1]!);
    const connection = CONNECTION_CALLBACK.exec(data);
    if (connection) return this.onDisconnect(callback, connection[1]!);
  }

  /** Cancel under the bot's question. */
  private async onCancel(callback: Callback, linkId: string): Promise<void> {
    const userKey = this.userKey(callback.from.id);
    const link = await this.link(linkId);
    const t = this.t(link?.locale, callback.from.language_code);
    if (!link || link.telegramUserKey !== userKey) return this.answer(callback, t('bot.tc.unknown'));
    const cancelled = await this.deps.db
      .update(telegramLinks)
      .set({ state: 'cancelled' })
      .where(
        and(
          eq(telegramLinks.id, link.id),
          eq(telegramLinks.telegramUserKey, userKey),
          inArray(telegramLinks.state, IN_PROGRESS),
        ),
      )
      .returning({ id: telegramLinks.id });
    await this.answer(callback);
    const done = cancelled.length
      ? 'bot.tc.cancelled'
      : link.state === 'connected'
        ? 'bot.tc.connectedShort'
        : 'bot.tc.expired';
    await this.replier(callback)(escapeHtml(t(done)));
  }

  /** Disconnect under the bot's "Connected" message: the account stops getting messages. */
  private async onDisconnect(callback: Callback, connectionId: string): Promise<void> {
    const { db } = this.deps;
    const [row] = await db
      .select()
      .from(telegramConnections)
      .where(eq(telegramConnections.id, connectionId))
      .limit(1);
    const t = this.t(row?.locale, callback.from.language_code);
    if (!row || row.telegramUserKey !== this.userKey(callback.from.id)) {
      return this.answer(callback, t('bot.tc.unknown'));
    }
    if (row.accountId) {
      await db.update(telegramConnections).set({ accountId: null }).where(eq(telegramConnections.id, row.id));
      await this.deps.accounts.markStatus(row.accountId, 'needs_reauth', STATUS.disconnected);
    }
    await this.answer(callback);
    await this.replier(callback)(escapeHtml(t('bot.tc.disconnected', { brand: BRAND.name })));
  }

  /** Telegram's "Manage bot" in a business chat: says which hub account the person is connected to. */
  private async onManage(message: StartMessage): Promise<void> {
    if (!message.from) return;
    const chat = String(message.chat.id);
    const row = await this.connectionOfUser(this.userKey(message.from.id));
    const t = this.t(row?.locale, message.from.language_code);
    const [account] = row?.accountId
      ? await this.deps.db.select().from(accounts).where(eq(accounts.id, row.accountId)).limit(1)
      : [];
    if (!row || !account) {
      return this.send(chat, escapeHtml(t('bot.tc.statusNone', { brand: BRAND.name })), this.siteButton(t));
    }
    const owner = await this.ownerText(account.workspaceId, account.ownerUserId, t);
    await this.send(
      chat,
      escapeHtml(
        t('bot.tc.status', {
          brand: BRAND.name,
          account: owner ? `${account.label}, ${owner}` : account.label,
        }),
      ),
      [[{ text: t('bot.tc.disconnect'), callback_data: `tgc:${row.id}:x` }]],
    );
  }

  /**
   * Telegram reports the bot added, changed, paused or removed under the person's Chat
   * Automation. A confirmed link of the same Telegram user finishes now.
   */
  private async onConnection(connection: BusinessConnection): Promise<void> {
    const { db, secrets, logger } = this.deps;
    const userKey = this.userKey(connection.user.id);
    const name = fullName(connection.user);
    const info: ConnectionInfo = {
      connectionId: connection.id,
      userChatId: connection.user_chat_id,
      ...(connection.user.username ? { username: connection.user.username } : {}),
      ...(name ? { name } : {}),
    };
    const before = await this.connectionOfUser(userKey);
    const values = {
      connectionKey: this.connectionKey(connection.id),
      infoEncrypted: secrets.encryptJson(info, connectionContext(userKey)),
      rights: rightsOf(connection),
      enabled: connection.is_enabled,
      locale: connection.user.language_code ?? before?.locale ?? null,
      connectedAt: new Date(connection.date * 1000),
    };
    const [row] = await db
      .insert(telegramConnections)
      .values({ id: newId('tgc'), telegramUserKey: userKey, ...values })
      .onConflictDoUpdate({
        target: telegramConnections.telegramUserKey,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    if (!row) return;
    if (!connection.is_enabled) {
      // Removed or paused: the account waits to be connected again; a bare connection is dropped.
      if (row.accountId) await this.deps.accounts.markStatus(row.accountId, 'needs_reauth', STATUS.paused);
      else await db.delete(telegramConnections).where(eq(telegramConnections.id, row.id));
      return;
    }
    const chat = String(connection.user_chat_id);
    const link = await this.openLinkOf(userKey);
    const t = this.t(link?.locale, row.locale);
    if (link?.state === 'confirmed') {
      // A confirmed link wins over the account the connection had: the person asked for it now.
      const outcome = await this.attach(link, row);
      if (outcome) await this.send(chat, ...this.outcomeMessage(outcome, t));
      return;
    }
    if (row.accountId) {
      // Rights changed, or the bot is back: the account's check says what it can do now.
      const [account] = await db.select().from(accounts).where(eq(accounts.id, row.accountId)).limit(1);
      if (account) await this.deps.accounts.test(account.workspaceId, account.id, logger);
      return;
    }
    if (link?.state === 'opened') {
      // Added the bot before typing the code: what is left, at the bottom of the chat.
      return this.send(chat, escapeHtml(t('bot.tc.typeCode', { brand: BRAND.name })));
    }
    // Added without a QR code (or it ran out): how to finish, once per new connection.
    if (!before?.enabled || before.connectionKey !== row.connectionKey) {
      await this.send(chat, escapeHtml(t('bot.tc.orphan', { brand: BRAND.name })), this.siteButton(t));
    }
  }

  /**
   * Connects a confirmed link's Telegram account to its hub account: the one to reconnect, the
   * one this Telegram account had in the workspace, or a new one.
   */
  private async attach(link: TelegramLinkRow, connection: ConnectionRow): Promise<AttachOutcome | undefined> {
    const { db, logger } = this.deps;
    // The first update to get here does it (a tap and Telegram's report can come together).
    const [claimed] = await db
      .update(telegramLinks)
      .set({ state: 'connected' })
      .where(and(eq(telegramLinks.id, link.id), eq(telegramLinks.state, 'confirmed')))
      .returning();
    if (!claimed) return undefined;
    try {
      const info = this.info(connection);
      const { account, created } = await this.accountFor(claimed, connection, info);
      const previous =
        connection.accountId && connection.accountId !== account.id ? connection.accountId : undefined;
      await db.transaction(async (tx) => {
        // One connection per account, one account per connection.
        await tx
          .update(telegramConnections)
          .set({ accountId: null })
          .where(
            and(eq(telegramConnections.accountId, account.id), ne(telegramConnections.id, connection.id)),
          );
        await tx
          .update(telegramConnections)
          .set({ accountId: account.id })
          .where(eq(telegramConnections.id, connection.id));
      });
      // The account belongs to this Telegram account from now on (see `mayReconnect`).
      await db
        .update(accounts)
        .set({
          metadata: sql`${accounts.metadata} || ${JSON.stringify({ telegramUserKey: connection.telegramUserKey })}::jsonb`,
        })
        .where(eq(accounts.id, account.id));
      if (previous) await this.deps.accounts.markStatus(previous, 'needs_reauth', STATUS.moved);
      await this.deps.accounts.test(account.workspaceId, account.id, logger);
      const telegram = claimed.telegramEncrypted ? this.linkTelegram(claimed) : undefined;
      await db
        .update(telegramLinks)
        .set({
          accountId: account.id,
          ...(telegram
            ? {
                telegramEncrypted: this.deps.secrets.encryptJson(
                  { ...telegram, label: identityOf(info) },
                  linkContext(claimed.id),
                ),
              }
            : {}),
        })
        .where(eq(telegramLinks.id, claimed.id));
      this.deps.onConnected?.(account, created);
      return { ok: true, account, created, connection: { ...connection, accountId: account.id } };
    } catch (error) {
      // Errors for the person (a plan limit, team rules) are shown as they are; the rest is ours.
      const reason = error instanceof AppError && error.status < 500 ? error.message : undefined;
      if (!reason) this.deps.capture(error, { step: 'telegram-automation.attach' });
      await db
        .update(telegramLinks)
        .set({ state: 'failed', error: reason ?? null })
        .where(eq(telegramLinks.id, claimed.id));
      return { ok: false, reason };
    }
  }

  private async accountFor(
    link: TelegramLinkRow,
    connection: ConnectionRow,
    info: ConnectionInfo,
  ): Promise<{ account: AccountRow; created: boolean }> {
    const { permissions } = this.deps;
    const service = this.deps.accounts;
    if (link.reconnectAccountId) {
      const account = await service.get(link.workspaceId, link.reconnectAccountId);
      if (!this.reconnects(account)) {
        throw conflict('This account is no longer connected through Telegram Chat Automation.');
      }
      if (!(await this.mayReconnect(account.id, connection.telegramUserKey))) {
        throw conflict(
          'This account belongs to another Telegram account: connect this one as a new account.',
        );
      }
      await permissions.assertCanManage(link.workspaceId, link.userId, account);
      return { account, created: false };
    }
    await permissions.assertCanConnect(link.workspaceId, link.userId, link.draft.owner);
    // Connected here before (still, until Disconnect, or until it moved to another workspace):
    // that account comes back instead of a second one for the same person.
    const current = connection.accountId
      ? await service.get(link.workspaceId, connection.accountId).catch(() => undefined)
      : undefined;
    const previousId =
      current?.id ?? (await this.accountOfUser(link.workspaceId, connection.telegramUserKey));
    if (previousId) {
      const previous = current ?? (await service.get(link.workspaceId, previousId).catch(() => undefined));
      const sameOwner = link.draft.owner === undefined || previous?.ownerUserId === link.draft.owner.userId;
      if (previous && this.reconnects(previous) && sameOwner) {
        const manages = await permissions.assertCanManage(link.workspaceId, link.userId, previous).then(
          () => true,
          () => false,
        );
        if (manages) return { account: previous, created: false };
      }
    }
    const account = await service.create(
      link.workspaceId,
      {
        connectorId: this.connectorId,
        label: link.draft.label ?? identityOf(info),
        ...(link.draft.name ? { name: link.draft.name } : {}),
        config: { bot: 'hub' },
      },
      link.draft.owner,
    );
    return { account, created: true };
  }

  private outcomeMessage(outcome: AttachOutcome, t: Translate): [string, InlineButton[][]?] {
    if (!outcome.ok) {
      return [
        escapeHtml(
          outcome.reason ? t('bot.tc.failed', { reason: outcome.reason }) : t('bot.tc.failedGeneric'),
        ),
      ];
    }
    const lines = [t('bot.tc.connected', { brand: BRAND.name })];
    if (!outcome.connection.rights.includes('can_reply')) lines.push(escapeHtml(t('bot.tc.noReply')));
    return [
      lines.join('\n\n'),
      [[{ text: t('bot.tc.disconnect'), callback_data: `tgc:${outcome.connection.id}:x` }]],
    ];
  }

  // --- Bot API for the accounts (TelegramHubBot) ----------------------------

  async call(
    accountId: string,
    method: string,
    params: Record<string, unknown> | FormData,
    signal?: AbortSignal,
  ): Promise<Response> {
    const business = METHODS[method];
    if (business === undefined) throw new DeliveryError('rejected', `The hub's bot does not do ${method}.`);
    const row = await this.connectionOf(accountId);
    if (!row) throw new DeliveryError('auth', STATUS.notConnected);
    if (business && !row.enabled) throw new DeliveryError('auth', STATUS.paused);
    const body = business ? onConnection(params, this.info(row).connectionId) : params;
    const response = await this.deps.bot.request(method, body, signal);
    if (response.status === 401 || response.status === 404) {
      // The hub's token is wrong or revoked: every Chat Automation account is affected, not this one.
      this.deps.capture(new Error(`Telegram did not accept the hub bot (HTTP ${response.status})`), {
        step: 'telegram-automation.call',
        method,
      });
    }
    return response;
  }

  async file(accountId: string, path: string, signal?: AbortSignal): Promise<Response> {
    if (!(await this.connectionOf(accountId))) throw new ConnectorError('auth', STATUS.notConnected);
    if (path.split('/').includes('..')) throw new ConnectorError('invalid_input', 'Invalid file path.');
    return this.deps.bot.downloadFile(path, signal);
  }

  async connection(accountId: string): Promise<TelegramBotConnection | undefined> {
    const row = await this.connectionOf(accountId);
    if (!row) return undefined;
    return { identity: identityOf(this.info(row)), enabled: row.enabled, rights: row.rights };
  }

  // --- Storage --------------------------------------------------------------

  private userKey(telegramUserId: number): string {
    return this.deps.keys.hubLookupKey('telegram/user', String(telegramUserId));
  }

  private connectionKey(connectionId: string): string {
    return this.deps.keys.hubLookupKey('telegram/connection', connectionId);
  }

  private info(row: ConnectionRow): ConnectionInfo {
    return this.deps.secrets.decryptJson<ConnectionInfo>(
      row.infoEncrypted,
      connectionContext(row.telegramUserKey),
    );
  }

  private linkTelegram(link: TelegramLinkRow): LinkTelegram {
    return this.deps.secrets.decryptJson<LinkTelegram>(link.telegramEncrypted ?? '', linkContext(link.id));
  }

  /** The workspace's newest Chat Automation account bound to this Telegram user, if any. */
  private async accountOfUser(workspaceId: string, userKey: string): Promise<string | undefined> {
    const [row] = await this.deps.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.workspaceId, workspaceId),
          eq(accounts.connectorId, this.connectorId),
          sql`${accounts.metadata}->>'telegramUserKey' = ${userKey}`,
        ),
      )
      .orderBy(desc(accounts.updatedAt))
      .limit(1);
    return row?.id;
  }

  private async link(id: string): Promise<TelegramLinkRow | undefined> {
    const [row] = await this.deps.db.select().from(telegramLinks).where(eq(telegramLinks.id, id)).limit(1);
    return row;
  }

  private async linkByCode(code: string): Promise<TelegramLinkRow | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(telegramLinks)
      .where(eq(telegramLinks.codeHash, hashToken(code)))
      .limit(1);
    return row;
  }

  /** The newest link this Telegram user opened that is still in progress. */
  private async openLinkOf(userKey: string): Promise<TelegramLinkRow | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(telegramLinks)
      .where(
        and(
          eq(telegramLinks.telegramUserKey, userKey),
          inArray(telegramLinks.state, ['opened', 'confirmed']),
          gt(telegramLinks.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(telegramLinks.updatedAt))
      .limit(1);
    return row;
  }

  private async connectionOf(accountId: string): Promise<ConnectionRow | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(telegramConnections)
      .where(eq(telegramConnections.accountId, accountId))
      .limit(1);
    return row;
  }

  private async connectionOfUser(userKey: string): Promise<ConnectionRow | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(telegramConnections)
      .where(eq(telegramConnections.telegramUserKey, userKey))
      .limit(1);
    return row;
  }

  // --- Bot messages ---------------------------------------------------------

  private t(...locales: (string | null | undefined)[]): Translate {
    return this.deps.t(pickLocale(...locales));
  }

  private siteButton(t: Translate): InlineButton[][] {
    const url = `${this.deps.publicUrl}/connect/${this.connectorId}`;
    return [[{ text: t('bot.tc.openSite', { host: new URL(url).host }), url }]];
  }

  /** Sends a message; a bot message that does not go out never fails the update. */
  private async send(chat: string, html: string, buttons?: InlineButton[][]): Promise<void> {
    await this.deps.bot
      .sendMessage(chat, html, buttons)
      .catch((error) => this.deps.logger.warn({ err: error }, 'telegram automation reply failed'));
  }

  /** Shows the outcome of a button in place of the message that had it (or as a new message). */
  private replier(callback: Callback): (html: string, buttons?: InlineButton[][]) => Promise<void> {
    const message = callback.message;
    if (!message) return (html, buttons) => this.send(String(callback.from.id), html, buttons);
    return (html, buttons) =>
      this.deps.bot
        .editMessage({ chatId: String(message.chat.id), messageId: message.message_id }, html, buttons)
        .catch((error) => this.deps.logger.debug({ err: error }, 'telegram automation edit failed'));
  }

  private async answer(callback: Callback, text?: string): Promise<void> {
    await this.deps.bot
      .answerCallback(callback.id, text)
      .catch((error) => this.deps.logger.debug({ err: error }, 'telegram callback answer failed'));
  }
}

/** The code is hashed with its link, so the same 6 digits on two links never match each other. */
function codeHash(linkId: string, code: string): string {
  return hashToken(`${linkId}:${code.replace(/\s+/g, '')}`);
}

function linkContext(linkId: string): string {
  return `telegram-link:${linkId}`;
}

function connectionContext(userKey: string): string {
  return `telegram-connection:${userKey}`;
}
