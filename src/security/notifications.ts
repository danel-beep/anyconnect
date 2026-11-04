import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { notificationChannels } from '../db/schema.js';
import { hashToken } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';

const LINK_TTL_MS = 15 * 60_000;

export interface ChannelStatus {
  telegram: { linked: boolean; label: string | null; linkedAt: string | null };
}

/**
 * Where the hub reaches its owner. Today: a Telegram chat with the hub's bot, linked by opening
 * `t.me/<bot>?start=<one-time code>`. More kinds (web push, email) fit the same table.
 */
export class NotificationChannels {
  constructor(private readonly db: Db) {}

  /** Starts (or restarts) linking Telegram; returns the one-time code for the deep link. */
  async startTelegramLink(userId: string): Promise<string> {
    const code = randomBytes(18).toString('base64url');
    const values = {
      linkCodeHash: hashToken(code),
      linkExpiresAt: new Date(Date.now() + LINK_TTL_MS),
    };
    await this.db
      .insert(notificationChannels)
      .values({ id: newId('ntf'), userId, kind: 'telegram', ...values })
      .onConflictDoUpdate({ target: [notificationChannels.userId, notificationChannels.kind], set: values });
    return code;
  }

  /** Completes linking from the bot's `/start <code>`. Returns the user id, or undefined. */
  async completeTelegramLink(code: string, chatId: string, label: string | null): Promise<string | undefined> {
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

  async telegramChat(userId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ address: notificationChannels.address })
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.userId, userId),
          eq(notificationChannels.kind, 'telegram'),
          isNotNull(notificationChannels.verifiedAt),
        ),
      )
      .limit(1);
    return row?.address ?? undefined;
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
