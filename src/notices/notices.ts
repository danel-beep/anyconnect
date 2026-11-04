import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sentNotices, users, workspaceMembers } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { Mailer } from '../mail/mailer.js';
import { composeEmail, type EmailContent } from '../web/emails.js';
import type { Locale } from '../web/i18n.js';

export type NoticeOutcome = 'sent' | 'duplicate' | 'no_mailer' | 'no_recipient' | 'failed';

/**
 * Emails to a workspace's owners, each sent once per occasion: `(workspace, kind, key)` is claimed
 * in `sent_notices` before sending, so retries, several instances and repeated triggers send one
 * email. A failed send releases the claim and the next trigger tries again. Without a mailer
 * (`MAIL_PROVIDER=none`) nothing is claimed or sent.
 */
export class NoticeService {
  constructor(
    private readonly deps: { db: Db; mailer: Mailer | undefined; publicUrl: string; logger: Logger },
  ) {}

  get enabled(): boolean {
    return this.deps.mailer !== undefined;
  }

  async notify(
    workspaceId: string,
    kind: string,
    key: string,
    content: EmailContent,
  ): Promise<NoticeOutcome> {
    const mailer = this.deps.mailer;
    if (!mailer) return 'no_mailer';
    const recipients = await this.owners(workspaceId);
    if (!recipients.length) return 'no_recipient';
    const [claimed] = await this.deps.db
      .insert(sentNotices)
      .values({ workspaceId, kind, key })
      .onConflictDoNothing()
      .returning({ kind: sentNotices.kind });
    if (!claimed) return 'duplicate';
    try {
      for (const to of recipients) {
        await mailer.send(composeEmail(to, content, { billingUrl: `${this.deps.publicUrl}/app/billing` }));
      }
      this.deps.logger.info({ workspaceId, kind, mailer: mailer.id }, 'notice sent');
      return 'sent';
    } catch (err) {
      await this.deps.db
        .delete(sentNotices)
        .where(
          and(eq(sentNotices.workspaceId, workspaceId), eq(sentNotices.kind, kind), eq(sentNotices.key, key)),
        );
      this.deps.logger.warn({ workspaceId, kind, err }, 'notice not sent');
      return 'failed';
    }
  }

  async wasSent(workspaceId: string, kind: string, key: string): Promise<boolean> {
    const [row] = await this.deps.db
      .select({ kind: sentNotices.kind })
      .from(sentNotices)
      .where(
        and(eq(sentNotices.workspaceId, workspaceId), eq(sentNotices.kind, kind), eq(sentNotices.key, key)),
      )
      .limit(1);
    return Boolean(row);
  }

  private async owners(workspaceId: string) {
    const rows = await this.deps.db
      .select({ email: users.email, name: users.name, locale: users.locale })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.role, 'owner'),
          eq(users.status, 'active'),
        ),
      );
    return rows.map((r) => ({
      email: r.email,
      name: r.name,
      locale: (r.locale === 'ru' ? 'ru' : 'en') as Locale,
    }));
  }
}
