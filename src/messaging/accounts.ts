import { eq, sql } from 'drizzle-orm';
import type { SessionStatusView } from '../connectors/messaging.js';
import type { Db } from '../db/client.js';
import {
  accounts,
  type MessengerProblem,
  type MessengerSessionState,
  messengerAccounts,
} from '../db/schema.js';

export type MessengerAccountRow = typeof messengerAccounts.$inferSelect;

/** Problems the user has to fix; the gateway does not retry them on its own. */
export const FATAL_PROBLEMS: ReadonlySet<MessengerProblem> = new Set([
  'logged_out',
  'needs_password',
  'frozen',
  'banned',
]);

const PROBLEM_TEXT: Record<MessengerProblem, string> = {
  logged_out: 'The session was logged out (on the phone or by the messenger). Log in again.',
  needs_password: 'Two-step verification password is required. Finish the login.',
  frozen: 'The messenger has frozen this account (restricted for suspected spam).',
  banned: 'The messenger has banned this account.',
  phone_offline: 'The phone has not been online for a long time; open the messenger on the phone.',
  flood: 'The messenger asked to slow down; sending is paused for a while.',
  network: 'Cannot reach the messenger right now; reconnecting.',
  protocol: 'The messenger rejected the connection (protocol error); reconnecting.',
  failing: 'The connection keeps failing; stopped after several attempts.',
};

export function describeProblem(problem: MessengerProblem, detail?: string | null): string {
  return detail ? `${PROBLEM_TEXT[problem]} (${detail})` : PROBLEM_TEXT[problem];
}

/** Runtime state of messenger accounts (connection status, sending pause), mirrored to `accounts.status`. */
export class MessengerAccounts {
  constructor(private readonly db: Db) {}

  async get(accountId: string): Promise<MessengerAccountRow | undefined> {
    const [row] = await this.db
      .select()
      .from(messengerAccounts)
      .where(eq(messengerAccounts.accountId, accountId))
      .limit(1);
    return row;
  }

  async ensure(accountId: string): Promise<MessengerAccountRow> {
    await this.db.insert(messengerAccounts).values({ accountId }).onConflictDoNothing();
    return (await this.get(accountId))!;
  }

  /**
   * Records the connection state. The account's own status follows, so the problem shows up in
   * the panel and in `anyconnect_list_accounts` without the AI having to ask the gateway.
   */
  async setState(
    accountId: string,
    update: {
      state: MessengerSessionState;
      problem?: MessengerProblem | null;
      message?: string | null;
      failures?: number;
      nextAttemptAt?: Date | null;
    },
  ): Promise<void> {
    await this.ensure(accountId);
    const problem = update.problem ?? null;
    await this.db
      .update(messengerAccounts)
      .set({
        state: update.state,
        problem,
        problemMessage: update.message ?? null,
        ...(update.failures !== undefined ? { failures: update.failures } : {}),
        ...(update.nextAttemptAt !== undefined ? { nextAttemptAt: update.nextAttemptAt } : {}),
        ...(update.state === 'online' ? { lastOnlineAt: new Date(), failures: 0, nextAttemptAt: null } : {}),
      })
      .where(eq(messengerAccounts.accountId, accountId));

    let status: 'active' | 'error' | 'needs_reauth' = 'active';
    let statusMessage: string | null = null;
    if (update.state === 'needs_login' || problem === 'logged_out' || problem === 'needs_password') {
      status = 'needs_reauth';
      statusMessage = problem ? describeProblem(problem, update.message) : 'Log in to connect this account.';
    } else if (
      problem &&
      (FATAL_PROBLEMS.has(problem) || problem === 'failing' || update.state === 'stopped')
    ) {
      status = 'error';
      statusMessage = describeProblem(problem, update.message);
    }
    await this.db
      .update(accounts)
      .set({ status, statusMessage, updatedAt: sql`${accounts.updatedAt}` })
      .where(eq(accounts.id, accountId));
  }

  async pauseSending(accountId: string, until: Date, reason: string): Promise<void> {
    await this.ensure(accountId);
    await this.db
      .update(messengerAccounts)
      .set({ sendPausedUntil: until, sendPauseReason: reason.slice(0, 300) })
      .where(eq(messengerAccounts.accountId, accountId));
  }

  async resumeSending(accountId: string): Promise<void> {
    await this.db
      .update(messengerAccounts)
      .set({ sendPausedUntil: null, sendPauseReason: null })
      .where(eq(messengerAccounts.accountId, accountId));
  }

  static view(row: MessengerAccountRow): SessionStatusView {
    return {
      state: row.state,
      ...(row.problem
        ? { problem: row.problem, message: describeProblem(row.problem, row.problemMessage) }
        : {}),
      ...(row.sendPausedUntil && row.sendPausedUntil > new Date()
        ? { sendPausedUntil: row.sendPausedUntil.toISOString() }
        : {}),
    };
  }
}
