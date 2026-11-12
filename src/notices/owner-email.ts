import { eq } from 'drizzle-orm';
import type { NoticeDelivery, OwnerNotice, OwnerNotifier } from '../core/owner-notices.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { Mailer } from '../mail/mailer.js';
import { composeEmail, type EmailContent } from '../web/emails.js';
import type { Key, Locale } from '../web/i18n.js';

/**
 * Owner notices by email, for owners who have not linked Telegram (see `FallbackOwnerNotifier`).
 * Without a mailer (`MAIL_PROVIDER=none`) there is no channel. Third-party text (previews) goes in
 * as values, which `composeEmail` escapes.
 */
export class EmailOwnerNotifier implements OwnerNotifier {
  constructor(
    private readonly deps: { db: Db; mailer: Mailer | undefined; publicUrl: string; logger: Logger },
  ) {}

  async notify(userId: string, notice: OwnerNotice): Promise<NoticeDelivery> {
    const { mailer, db, logger } = this.deps;
    if (!mailer) return 'no_channel';
    const content = emailOf(notice);
    if (!content) return 'no_channel';
    const [user] = await db
      .select({ email: users.email, name: users.name, locale: users.locale, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user || user.status !== 'active') return 'no_channel';
    const locale: Locale = user.locale === 'ru' ? 'ru' : 'en';
    try {
      await mailer.send(
        composeEmail({ email: user.email, name: user.name, locale }, content, {
          billingUrl: `${this.deps.publicUrl}/app/billing`,
        }),
      );
      return 'sent';
    } catch (error) {
      logger.warn({ err: error, notice: notice.kind }, 'owner notice email not delivered');
      return 'failed';
    }
  }
}

/** The email for a notice; undefined for kinds that have their own email elsewhere. */
export function emailOf(notice: OwnerNotice): EmailContent | undefined {
  switch (notice.kind) {
    case 'confirmation_waiting':
      return {
        tag: 'notice.confirmation_waiting',
        subject: 'email.confirm.subject',
        paragraphs: ['email.confirm.body', 'email.confirm.expires', 'email.notice.telegramTip'],
        cta: { label: 'email.confirm.cta', url: notice.url },
        vars: {
          action: notice.action,
          service: notice.service,
          account: notice.account,
          minutes: notice.expiresMinutes,
        },
      };
    case 'trigger_fired': {
      const paragraphs: Key[] = ['email.trigger.what'];
      if (notice.title) paragraphs.push('email.trigger.titleLine');
      if (notice.preview) paragraphs.push('email.trigger.preview');
      if (notice.summary) paragraphs.push('email.trigger.ai');
      paragraphs.push('email.notice.telegramTip');
      return {
        tag: 'notice.trigger_fired',
        subject: 'email.trigger.subject',
        paragraphs,
        cta: { label: 'email.trigger.cta', url: notice.url },
        vars: {
          trigger: notice.trigger,
          service: notice.service,
          account: notice.account,
          from: notice.from ?? '—',
          title: notice.title ?? '',
          preview: notice.preview,
          summary: notice.summary ?? '',
        },
      };
    }
    case 'trigger_paused':
      return {
        tag: 'notice.trigger_paused',
        subject: notice.reason === 'limit' ? 'email.paused.subject' : 'email.aiLimit.subject',
        paragraphs: ['email.paused.body'],
        cta: { label: 'email.paused.cta', url: notice.url },
        vars: { trigger: notice.trigger, n: notice.limit },
      };
    case 'security':
      return {
        tag: `notice.security.${notice.event}`,
        subject: `notice.security.${notice.event}.title`,
        paragraphs: [
          ...(notice.subject ? (['notice.security.subject'] as const) : []),
          `notice.security.${notice.event}.fix`,
        ],
        cta: { label: `notice.security.${notice.event}.cta`, url: notice.url },
        vars: { subject: notice.subject },
      };
    case 'accounts_need_reauth':
      return undefined;
  }
}

/** Tries each channel in order and stops at the first that delivers (Telegram, then email). */
export class FallbackOwnerNotifier implements OwnerNotifier {
  constructor(private readonly channels: OwnerNotifier[]) {}

  async notify(userId: string, notice: OwnerNotice): Promise<NoticeDelivery> {
    let result: NoticeDelivery = 'no_channel';
    for (const channel of this.channels) {
      const delivery = await channel.notify(userId, notice);
      if (delivery === 'sent') return 'sent';
      if (delivery === 'failed') result = 'failed';
    }
    return result;
  }
}
