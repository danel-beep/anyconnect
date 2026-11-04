import { z } from 'zod';
import type { Logger } from '../logger.js';

/**
 * Minimal Telegram Bot API client for the hub's own notification bot (confirmations, alerts).
 * Not a connector: it talks only to the bot the hub owner configured in TELEGRAM_BOT_TOKEN.
 * The token is never logged; errors carry the method name only.
 */

export interface InlineButton {
  text: string;
  callback_data: string;
}

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

export class TelegramApiError extends Error {
  override name = 'TelegramApiError';
}

export class TelegramBot {
  private username: string | undefined;

  constructor(
    private readonly token: string,
    private readonly options: { apiUrl: string; logger: Logger; fetch?: typeof fetch },
  ) {}

  private async call<T>(method: string, params: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const doFetch = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.options.apiUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(10_000),
      });
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

  async getUsername(): Promise<string> {
    if (!this.username) {
      const me = await this.call('getMe', {}, z.object({ username: z.string() }));
      this.username = me.username;
    }
    return this.username;
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call(
      'setWebhook',
      { url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'] },
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

  async answerCallback(callbackId: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text }, z.unknown());
  }
}

/** Escapes text for Telegram's HTML parse mode, also inside attribute values (`href="…"`). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
