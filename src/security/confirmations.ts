import type { RiskLevel } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { Translate } from '../web/i18n.js';
import type { NotificationChannels } from './notifications.js';
import type { PendingCallRow, PendingCallService } from './pending-calls.js';
import { escapeHtml, type InlineButton, type TelegramBot, TelegramUpdate } from './telegram.js';

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

export type DescribeCall = (row: PendingCallRow) => Promise<CallDescription>;

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
      t: Translate;
      logger: Logger;
    },
  ) {}

  get telegramEnabled(): boolean {
    return this.deps.bot !== undefined;
  }

  /** Human description of a call (service, action, account, AI client). */
  describe(row: PendingCallRow): Promise<CallDescription> {
    return this.deps.describe(row);
  }

  confirmUrl(id: string): string {
    return `${this.deps.publicUrl}/confirm/${id}`;
  }

  /** Channels available to the owner of a call, in the order they are offered. */
  async channelsFor(userId: string): Promise<string[]> {
    const chat = this.deps.bot ? await this.deps.channels.telegramChat(userId) : undefined;
    return chat ? ['telegram', 'web'] : ['web'];
  }

  private async render(row: PendingCallRow): Promise<string> {
    const { t } = this.deps;
    const d = await this.deps.describe(row);
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

  private buttons(row: PendingCallRow): InlineButton[][] {
    const { t } = this.deps;
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

  /** Sends the call to the owner's Telegram (if linked). Never throws: the web link always works. */
  async notify(row: PendingCallRow): Promise<void> {
    const { bot, channels, pending, logger } = this.deps;
    if (!bot) return;
    try {
      const chat = await channels.telegramChat(row.principal.userId);
      if (!chat) return;
      const message = await bot.sendMessage(chat, await this.render(row), this.buttons(row));
      await pending.setTelegramMessage(row.id, message);
    } catch (error) {
      logger.warn({ err: error, pendingCall: row.id }, 'telegram confirmation not delivered');
    }
  }

  /** Updates the Telegram message after the call changed state (decided, ran, cancelled). */
  async refresh(id: string): Promise<void> {
    const { bot, pending, logger } = this.deps;
    if (!bot) return;
    const row = await pending.get(id);
    if (!row?.telegramMessage) return;
    try {
      await bot.editMessage(row.telegramMessage, await this.render(row), this.buttons(row));
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
    const { bot, channels, pending, t, logger } = this.deps;
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
      await bot
        .sendMessage(chatId, escapeHtml(userId ? t('confirm.tg.linked') : t('confirm.tg.linkFailed')))
        .catch((error) => logger.warn({ err: error }, 'telegram reply failed'));
      return;
    }

    const callback = update.callback_query;
    if (!callback?.data) return;
    const match = CALLBACK.exec(callback.data);
    const answer = (message: string) =>
      bot
        .answerCallback(callback.id, message)
        .catch((error) => logger.debug({ err: error }, 'answer failed'));
    if (!match) return void (await answer(t('confirm.tg.unknown')));
    const [, id, op] = match as unknown as [string, string, 'a' | 'd' | 'c'];
    const row = await pending.get(id);
    // Only the chat linked to the owner of this call may decide it.
    const chat = row ? await channels.telegramChat(row.principal.userId) : undefined;
    const from = String(callback.message?.chat.id ?? callback.from.id);
    if (!row || !chat || chat !== from) return void (await answer(t('confirm.tg.unknown')));
    const decided = await this.decide(
      id,
      op === 'a' ? 'approve' : op === 'd' ? 'deny' : 'cancel',
      'telegram',
    );
    await answer(decided ? t(`confirm.status.${decided.status}` as const) : t('confirm.tg.tooLate'));
    if (!decided) await this.refresh(id);
  }
}
