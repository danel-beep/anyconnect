import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { notificationChannels, users } from '../db/schema.js';
import { hashToken } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';

const LINK_TTL_MS = 15 * 60_000;

/** A linked Telegram chat and the language to write to it in. */
export interface TelegramTarget {
  chat: string;
  /** The user's saved language, else the one of the page the chat was linked from (may be null). */
  locale: string | null;
}

export interface ChannelStatus {
  telegram: { linked: boolean; label: string | null; linkedAt: string | null };
}

/**
 * Where the hub reaches its owner. Today: a Telegram chat with the hub's bot, linked by opening
 * `t.me/<bot>?start=<one-time code>`. More kinds (web push, email) fit the same table.
 */
export class NotificationChannels {
  constructor(private readonly db: Db) {}

  /**
   * Starts (or restarts) linking Telegram; returns the one-time code for the deep link. `locale` is
   * the language of the page the link was made on, used for the bot's messages unless the user saved
   * a language in their settings.
   */
  async startTelegramLink(userId: string, locale?: string | null): Promise<string> {
    const code = randomBytes(18).toString('base64url');
    const values = {
      linkCodeHash: hashToken(code),
      linkExpiresAt: new Date(Date.now() + LINK_TTL_MS),
      locale: locale ?? null,
    };
    await this.db
      .insert(notificationChannels)
      .values({ id: newId('ntf'), userId, kind: 'telegram', ...values })
      .onConflictDoUpdate({ target: [notificationChannels.userId, notificationChannels.kind], set: values });
    return code;
  }

  /** Completes linking from the bot's `/start <code>`. Returns the user id, or undefined. */
  async completeTelegramLink(
    code: string,
    chatId: string,
    label: string | null,
  ): Promise<string | undefined> {
    const [row] = await this.db
      .update(notificationChannels)
      .set({ address: chatId, label, verifiedAt: new Date(), linkCodeHash: null, linkExpiresAt: null })
      .where(
        and(
          eq(notificationChannels.kind, 'telegram'),
          eq(notificationChannels.linkCodeHash, hashToken(code)),
          gt(notificationChannels.linkExpiresAt, new Date()),
        ),
      )
      .returning({ userId: notificationChannels.userId });
    return row?.userId;
  }

  /** The user's linked Telegram chat with the language for it, if linked. */
  async telegram(userId: string): Promise<TelegramTarget | undefined> {
    const [row] = await this.db
      .select({
        address: notificationChannels.address,
        channelLocale: notificationChannels.locale,
        userLocale: users.locale,
      })
      .from(notificationChannels)
      .innerJoin(users, eq(users.id, notificationChannels.userId))
      .where(
        and(
          eq(notificationChannels.userId, userId),
          eq(notificationChannels.kind, 'telegram'),
          isNotNull(notificationChannels.verifiedAt),
        ),
      )
      .limit(1);
    return row?.address ? { chat: row.address, locale: row.userLocale ?? row.channelLocale } : undefined;
  }

  async telegramChat(userId: string): Promise<string | undefined> {
    return (await this.telegram(userId))?.chat;
  }

  async status(userId: string): Promise<ChannelStatus> {
    const [row] = await this.db
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.kind, 'telegram')))
      .limit(1);
    const linked = Boolean(row?.verifiedAt && row.address);
    return {
      telegram: {
        linked,
        label: linked ? (row?.label ?? null) : null,
        linkedAt: linked ? row!.verifiedAt!.toISOString() : null,
      },
    };
  }

  async unlinkTelegram(userId: string): Promise<void> {
    await this.db
      .delete(notificationChannels)
      .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.kind, 'telegram')));
  }
}
