import { z } from 'zod';
import type { Logger } from '../logger.js';

/**
 * Minimal Telegram Bot API client for the hub's own bot (TELEGRAM_BOT_TOKEN): confirmations and
 * alerts, the landing for people from ads, and Telegram Chat Automation, where people add this bot
 * to their own account. Not a connector: it talks only to the bot the hub owner configured.
 * The token is never logged; errors carry the method name only.
 */

/** Updates the hub's bot asks Telegram for (setWebhook `allowed_updates`). */
export const HUB_BOT_UPDATES = [
  'message',
  'callback_query',
  // Telegram Chat Automation: people connect the bot to their account and it gets their chats.
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
];

/**
 * Handles one webhook update of the hub's bot (already authenticated by its secret token);
 * resolves true when it took the update, so the next handler does not see it.
 */
export type BotUpdateHandler = (update: unknown) => Promise<boolean>;

/** Offers an update to each handler in turn until one takes it. */
export function chainUpdateHandlers(handlers: BotUpdateHandler[]): BotUpdateHandler {
  return async (update) => {
    for (const handle of handlers) if (await handle(update)) return true;
    return false;
  };
}

/**
 * Thrown by a handler that could not take an update for now (the database is away) and wants
 * Telegram to deliver it again: the webhook then answers 500. Only for updates whose handling is
 * idempotent, such as storing messages.
 */
export class RetryUpdateError extends Error {
  override name = 'RetryUpdateError';
}

/**
 * How many times one update may ask Telegram to deliver it again. A failure that repeats (a bug,
 * data that cannot be read) must not hold the bot's webhook, and with it every user's updates,
 * for good: after the limit the update is answered 200 and only reported.
 */
export class RetryBudget {
  private readonly attempts = new Map<number, number>();

  constructor(
    private readonly limit = 3,
    private readonly remembered = 1_000,
  ) {}

  /** Counts a failed attempt of the update; true while Telegram may deliver it again. */
  take(updateId: unknown): boolean {
    if (typeof updateId !== 'number') return false;
    const used = (this.attempts.get(updateId) ?? 0) + 1;
    this.attempts.delete(updateId);
    this.attempts.set(updateId, used);
    if (this.attempts.size > this.remembered) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
    return used <= this.limit;
  }
}

/** An inline keyboard button: a callback the webhook receives, or a link Telegram opens. */
export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };

const Message = z.object({
  message_id: z.number(),
  chat: z.object({ id: z.number() }),
});

const From = z.object({
  id: z.number(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  /** The language the person's Telegram app is set to (IETF tag, e.g. "en", "ru"). */
  language_code: z.string().optional(),
});

/** The subset of a Telegram Update the hub reacts to. */
export const TelegramUpdate = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      chat: z.object({ id: z.number(), type: z.string() }),
      from: From.optional(),
      text: z.string().optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: From,
      data: z.string().optional(),
      message: Message.optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof TelegramUpdate>;

/** A `/start` the confirmations bot did not take as a link code (for example from an ad). */
export interface BotStart {
  chatId: string;
  /** The text after `/start`, trimmed; empty when the bot was opened without one. */
  payload: string;
  /** The language the person's Telegram app is set to, if sent. */
  languageCode: string | undefined;
}

/** Handles a `/start`; returns false when it is not for this handler. */
export type BotStartHandler = (start: BotStart) => Promise<boolean>;

export class TelegramApiError extends Error {
  override name = 'TelegramApiError';
}

const Me = z.object({
  id: z.number(),
  username: z.string(),
  /** Secretary Mode is on in @BotFather: people can add the bot under Settings → Chat Automation. */
  can_connect_to_business: z.boolean().optional(),
});
export type BotProfile = z.infer<typeof Me>;

/** How long `getMe` is trusted: switching Secretary Mode in @BotFather shows up within this time. */
const PROFILE_TTL_MS = 10 * 60_000;

export class TelegramBot {
  private profile: { value: BotProfile; at: number } | undefined;

  constructor(
    private readonly token: string,
    private readonly options: { apiUrl: string; logger: Logger; fetch?: typeof fetch },
  ) {}

  /**
   * Sends a Bot API request and returns Telegram's raw response, for callers that read the result
   * and errors themselves (Chat Automation accounts deliver through this). Network failures throw.
   */
  async request(
    method: string,
    params: Record<string, unknown> | FormData,
    signal: AbortSignal = AbortSignal.timeout(30_000),
  ): Promise<Response> {
    const doFetch = this.options.fetch ?? fetch;
    return doFetch(`${this.options.apiUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      ...(params instanceof FormData
        ? { body: params }
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }),
      signal,
    });
  }

  /** Downloads a file the bot can see, by the `file_path` getFile returned. */
  async downloadFile(path: string, signal: AbortSignal = AbortSignal.timeout(60_000)): Promise<Response> {
    const doFetch = this.options.fetch ?? fetch;
    const clean = path.replace(/^\/+/, '');
    return doFetch(`${this.options.apiUrl}/file/bot${this.token}/${clean}`, { signal });
  }

  private async call<T>(method: string, params: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await this.request(method, params, AbortSignal.timeout(10_000));
    } catch {
      throw new TelegramApiError(`Telegram ${method} failed: network error`);
    }
    const body = (await response.json().catch(() => undefined)) as
      | { ok: boolean; result?: unknown; description?: string }
      | undefined;
    if (!response.ok || !body?.ok) {
      throw new TelegramApiError(`Telegram ${method} failed: ${body?.description ?? response.status}`);
    }
    return schema.parse(body.result);
  }

  /** The bot's profile (`getMe`), cached for a few minutes. */
  async me(): Promise<BotProfile> {
    const cached = this.profile;
    if (cached && Date.now() - cached.at <= PROFILE_TTL_MS) return cached.value;
    try {
      const value = await this.call('getMe', {}, Me);
      this.profile = { value, at: Date.now() };
      return value;
    } catch (error) {
      // Telegram is away for a moment: what it said last is still the best answer.
      if (cached) return cached.value;
      throw error;
    }
  }

  async getUsername(): Promise<string> {
    return (await this.me()).username;
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call(
      'setWebhook',
      { url, secret_token: secretToken, allowed_updates: HUB_BOT_UPDATES },
      z.unknown(),
    );
  }

  async sendMessage(
    chatId: string,
    html: string,
    buttons?: InlineButton[][],
  ): Promise<{ chatId: string; messageId: number }> {
    const message = await this.call(
      'sendMessage',
      {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
      },
      Message,
    );
    return { chatId: String(message.chat.id), messageId: message.message_id };
  }

  async editMessage(
    message: { chatId: string; messageId: number },
    html: string,
    buttons?: InlineButton[][],
  ): Promise<void> {
    await this.call(
      'editMessageText',
      {
        chat_id: message.chatId,
        message_id: message.messageId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: buttons ?? [] },
      },
      z.unknown(),
    );
  }

  /** Stops the button's spinner; `text` shows as a short notice on top of the chat. */
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call(
      'answerCallbackQuery',
      { callback_query_id: callbackId, ...(text ? { text } : {}) },
      z.unknown(),
    );
  }
}

/** Escapes text for Telegram's HTML parse mode, also inside attribute values (`href="…"`). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
