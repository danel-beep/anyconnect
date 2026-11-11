import type { OwnerNotifier } from '../core/owner-notices.js';
import type { RiskLevel } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { DEFAULT_LOCALE, type Locale, type Translate } from '../web/i18n.js';
import type { NotificationChannels } from './notifications.js';
import type { PendingCallRow, PendingCallService } from './pending-calls.js';
import {
  type BotStartHandler,
  escapeHtml,
  type InlineButton,
  type TelegramBot,
  TelegramUpdate,
} from './telegram.js';

/** Human description of a pending call (resolved from connectors, accounts and AI clients). */
export interface CallDescription {
  service: string;
  action: string;
  account: string;
  client: string;
  risk: RiskLevel;
  /** Why the action is risky (e.g. "first message to a new contact"), if known. */
  reason?: string | undefined;
}

/** Describes a call with service and action names in `locale` where the connector has them. */
export type DescribeCall = (row: PendingCallRow, locale: Locale) => Promise<CallDescription>;

/** The first of the candidates that is a supported language ("ru-RU" counts as "ru"), else the default. */
export function pickLocale(...candidates: (string | null | undefined)[]): Locale {
  for (const candidate of candidates) {
    const tag = candidate?.slice(0, 2).toLowerCase();
    if (tag === 'ru' || tag === 'en') return tag;
  }
  return DEFAULT_LOCALE;
}

const PREVIEW_VALUE = 300;
const PREVIEW_TOTAL = 1500;

/** A compact, truncated view of the arguments, so the user sees what they approve. */
export function previewArguments(args: Record<string, unknown>): string {
  const shorten = (value: unknown): unknown => {
    if (typeof value === 'string')
      return value.length > PREVIEW_VALUE ? `${value.slice(0, PREVIEW_VALUE)}…` : value;
    if (Array.isArray(value)) return value.slice(0, 20).map(shorten);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v)]));
    return value;
  };
  const text = JSON.stringify(shorten(args), null, 2);
  return text.length > PREVIEW_TOTAL ? `${text.slice(0, PREVIEW_TOTAL)}…` : text;
}

const FIELD_VALUE = 4000;
const FIELDS = 30;

const plain = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * A small object of plain values as its values alone: `{ email: "ann@example.com" }` reads as the
 * address and `{ dateTime, timeZone }` as "2026-12-01T15:00:00 · Europe/Berlin". Undefined for
 * anything deeper or wider, which stays JSON.
 */
function brief(value: unknown): string | undefined {
  if (plain(value)) return String(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const values = Object.values(value).filter((v) => v !== undefined && v !== null && v !== '');
  return values.length > 0 && values.length <= 4 && values.every(plain) ? values.join(' · ') : undefined;
}

/**
 * The arguments as name and value pairs for the confirmation page, so a person reads the email
 * they approve rather than JSON: text keeps its line breaks, a list of plain values becomes one
 * line, small objects show their values (a guest is an address, not `{"email": …}`), anything else
 * is pretty JSON. Long values are cut; the page is a preview, not the call.
 */
export function argumentFields(args: Record<string, unknown>): { name: string; value: string }[] {
  const cut = (text: string) => (text.length > FIELD_VALUE ? `${text.slice(0, FIELD_VALUE)}…` : text);
  const show = (value: unknown): string => {
    const one = brief(value);
    if (one !== undefined) return one;
    if (Array.isArray(value) && value.length > 0) {
      const items = value.map(brief);
      if (items.every((item) => item !== undefined)) {
        // One line while every item is a single value; a line each once items have several.
        return items.join(value.every(plain) || items.every((item) => !item.includes(' · ')) ? ', ' : '\n');
      }
    }
    return JSON.stringify(value, null, 2);
  };
  return Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, FIELDS)
    .map(([name, value]) => ({ name, value: cut(show(value)) }));
}

const CALLBACK = /^pc:(pcl_[0-9a-z]{26}):([adc])$/;

/**
 * Confirmation channels outside the chat: the hub's Telegram bot (buttons) and the web page
 * `/confirm/<id>`. The chat itself (MCP elicitation) is handled by the executor stage.
 *
 * Decisions from every channel go through {@link PendingCallService}, whose conditional updates
 * make the first answer win; every channel's message is then updated to show the outcome.
 */
export class ConfirmationCenter {
  constructor(
    private readonly deps: {
      pending: PendingCallService;
      channels: NotificationChannels;
      bot: TelegramBot | undefined;
      publicUrl: string;
      describe: DescribeCall;
      /** Texts in a language: bot messages go out in the owner's language. */
      t: (locale: Locale) => Translate;
      logger: Logger;
      /**
       * Answers a `/start` that is not a valid link code (people from ads or a plain bot link).
       * Without it, or when it declines, the bot says the link is invalid.
       */
      onOtherStart?: BotStartHandler;
      /**
       * Where to tell an owner without Telegram that a trigger waits for them (email). A trigger has
       * no chat to ask in, so without it the request would wait unseen until it expires.
       */
      fallback?: OwnerNotifier;
    },
  ) {}

  get telegramEnabled(): boolean {
    return this.deps.bot !== undefined;
  }

  /** Human description of a call (service, action, account, AI client), by default in English. */
  describe(row: PendingCallRow, locale: Locale = DEFAULT_LOCALE): Promise<CallDescription> {
    return this.deps.describe(row, locale);
  }

  confirmUrl(id: string): string {
    return `${this.deps.publicUrl}/confirm/${id}`;
  }

  /** Channels available to the owner of a call, in the order they are offered. */
  async channelsFor(userId: string): Promise<string[]> {
    const chat = this.deps.bot ? await this.deps.channels.telegramChat(userId) : undefined;
    return chat ? ['telegram', 'web'] : ['web'];
  }

  private async render(row: PendingCallRow, locale: Locale): Promise<string> {
    const t = this.deps.t(locale);
    const d = await this.deps.describe(row, locale);
    const heading =
      row.status === 'awaiting_confirmation'
        ? t('confirm.tg.ask')
        : row.status === 'scheduled'
          ? t('confirm.tg.scheduled', {
              seconds: Math.max(
                0,
                Math.round(((row.executeAt?.getTime() ?? Date.now()) - Date.now()) / 1000),
              ),
            })
          : t(`confirm.status.${row.status}` as const);
    const args = this.deps.pending.args(row);
    const lines = [
      `<b>${escapeHtml(heading)}</b>`,
      '',
      `${escapeHtml(t('confirm.client'))}: ${escapeHtml(d.client)}`,
      `${escapeHtml(t('confirm.service'))}: ${escapeHtml(d.service)} · ${escapeHtml(d.account)}`,
      `${escapeHtml(t('confirm.action'))}: ${escapeHtml(d.action)} (${escapeHtml(t(`risk.${d.risk}` as const))})`,
      ...(d.reason ? [`${escapeHtml(t('confirm.reason'))}: ${escapeHtml(d.reason)}`] : []),
      '',
      `${escapeHtml(t('confirm.arguments'))}:`,
      `<pre>${escapeHtml(previewArguments(args))}</pre>`,
      `<a href="${escapeHtml(this.confirmUrl(row.id))}">${escapeHtml(t('confirm.open'))}</a>`,
    ];
    return lines.join('\n');
  }

  private buttons(row: PendingCallRow, locale: Locale): InlineButton[][] {
    const t = this.deps.t(locale);
    if (row.status === 'awaiting_confirmation') {
      return [
        [
          { text: t('confirm.approve'), callback_data: `pc:${row.id}:a` },
          { text: t('confirm.deny'), callback_data: `pc:${row.id}:d` },
        ],
      ];
    }
    if (row.status === 'scheduled') return [[{ text: t('confirm.cancel'), callback_data: `pc:${row.id}:c` }]];
    return [];
  }

  /**
   * Sends the call to the owner's Telegram (if linked); a trigger's request goes by email instead
   * when Telegram is not linked. Never throws: the web link always works.
   */
  async notify(row: PendingCallRow): Promise<void> {
    const { bot, channels, pending, logger } = this.deps;
    try {
      const target = bot ? await channels.telegram(row.principal.userId) : undefined;
      if (!bot || !target) {
        await this.notifyElsewhere(row);
        return;
      }
      const locale = pickLocale(target.locale);
      const message = await bot.sendMessage(
        target.chat,
        await this.render(row, locale),
        this.buttons(row, locale),
      );
      await pending.setTelegramMessage(row.id, message);
    } catch (error) {
      logger.warn({ err: error, pendingCall: row.id }, 'telegram confirmation not delivered');
    }
  }

  private async notifyElsewhere(row: PendingCallRow): Promise<void> {
    const { fallback } = this.deps;
    if (!fallback || row.principal.kind !== 'automation' || row.status !== 'awaiting_confirmation') return;
    const d = await this.deps.describe(row, DEFAULT_LOCALE);
    await fallback.notify(row.principal.userId, {
      kind: 'confirmation_waiting',
      action: d.action,
      service: d.service,
      account: d.account,
      url: this.confirmUrl(row.id),
      expiresMinutes: Math.max(1, Math.round((row.expiresAt.getTime() - Date.now()) / 60_000)),
    });
  }

  /** Updates the Telegram message after the call changed state (decided, ran, cancelled). */
  async refresh(id: string): Promise<void> {
    const { bot, channels, pending, logger } = this.deps;
    if (!bot) return;
    const row = await pending.get(id);
    if (!row?.telegramMessage) return;
    try {
      const locale = pickLocale((await channels.telegram(row.principal.userId))?.locale);
      await bot.editMessage(row.telegramMessage, await this.render(row, locale), this.buttons(row, locale));
    } catch (error) {
      logger.debug({ err: error, pendingCall: id }, 'telegram message not updated');
    }
  }

  /** A decision from the web page or the REST API (the caller checked workspace membership). */
  async decide(id: string, decision: 'approve' | 'deny' | 'cancel', via: string) {
    const { pending } = this.deps;
    const row =
      decision === 'cancel'
        ? await pending.cancel(id, via)
        : await pending.decide(id, decision === 'approve', via);
    if (row) await this.refresh(id);
    return row;
  }

  /** Handles an update delivered to the webhook (already authenticated by its secret token). */
  async handleTelegramUpdate(raw: unknown): Promise<void> {
    const { bot, channels, pending, logger } = this.deps;
    if (!bot) return;
    const parsed = TelegramUpdate.safeParse(raw);
    if (!parsed.success) return;
    const update = parsed.data;

    const text = update.message?.text?.trim();
    if (update.message && text?.startsWith('/start')) {
      const chatId = String(update.message.chat.id);
      if (update.message.chat.type !== 'private') return;
      const code = text.slice('/start'.length).trim();
      const label = update.message.from?.username ? `@${update.message.from.username}` : null;
      const userId = code ? await channels.completeTelegramLink(code, chatId, label) : undefined;
      if (!userId && this.deps.onOtherStart) {
        const languageCode = update.message.from?.language_code;
        if (await this.deps.onOtherStart({ chatId, payload: code, languageCode })) return;
      }
      // The user's language when linked; otherwise the one their Telegram app is set to.
      const target = userId ? await channels.telegram(userId) : undefined;
      const t = this.deps.t(pickLocale(target?.locale, update.message.from?.language_code));
      await bot
        .sendMessage(chatId, escapeHtml(userId ? t('confirm.tg.linked') : t('confirm.tg.linkFailed')))
        .catch((error) => logger.warn({ err: error }, 'telegram reply failed'));
      return;
    }

    const callback = update.callback_query;
    if (!callback?.data) return;
    const match = CALLBACK.exec(callback.data);
    let t = this.deps.t(pickLocale(callback.from.language_code));
    const answer = (message: string) =>
      bot
        .answerCallback(callback.id, message)
        .catch((error) => logger.debug({ err: error }, 'answer failed'));
    if (!match) return void (await answer(t('confirm.tg.unknown')));
    const [, id, op] = match as unknown as [string, string, 'a' | 'd' | 'c'];
    const row = await pending.get(id);
    // Only the chat linked to the owner of this call may decide it.
    const target = row ? await channels.telegram(row.principal.userId) : undefined;
    const from = String(callback.message?.chat.id ?? callback.from.id);
    if (!row || !target || target.chat !== from) return void (await answer(t('confirm.tg.unknown')));
    t = this.deps.t(pickLocale(target.locale));
    const decided = await this.decide(
      id,
      op === 'a' ? 'approve' : op === 'd' ? 'deny' : 'cancel',
      'telegram',
    );
    await answer(decided ? t(`confirm.status.${decided.status}` as const) : t('confirm.tg.tooLate'));
    if (!decided) await this.refresh(id);
  }
}
