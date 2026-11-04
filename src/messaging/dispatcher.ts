import {
  DeliveryError,
  type OutboundJob,
  type PacingLimits,
  type SentReceipt,
} from '../connectors/messaging.js';
import type { Logger } from '../logger.js';
import type { MessengerAccounts } from './accounts.js';
import type { Outbox, OutboxRow } from './outbox.js';
import { nextSendTime, typingDurationMs } from './pacing.js';
import type { MessageStore } from './store.js';

/** What a dispatcher needs from the process it runs in (the hub for direct APIs, the gateway for sessions). */
export interface DeliveryExecutor {
  /** Accounts this process delivers for right now. */
  accounts(): Promise<string[]> | string[];
  idempotentSend(accountId: string): boolean;
  pacing(accountId: string): Promise<PacingLimits>;
  /** Show "typing..." in the chat for about `durationMs`, then resolve. */
  typing?(accountId: string, job: OutboundJob, durationMs: number): Promise<void>;
  /** Delivers the job; throws {@link DeliveryError} to tell the dispatcher what to do next. */
  deliver(accountId: string, job: OutboundJob): Promise<SentReceipt | undefined>;
  /** Credentials stopped working. */
  onAuthError?(accountId: string, message: string): Promise<void>;
}

const MAX_ATTEMPTS = 5;
/** A flood wait longer than this pauses all sending of the account and is reported to the user. */
const LONG_FLOOD_SECONDS = 300;
const SPAM_PAUSE_MS = 24 * 3_600_000;

/**
 * Takes jobs from the outbox one at a time per account, applies pacing, shows typing, delivers
 * and records the result. Runs in-process; several dispatchers (hub instances, gateway instances)
 * can work at once because jobs are claimed in the database.
 */
export class Dispatcher {
  private timer: NodeJS.Timeout | undefined;
  private readonly running = new Set<string>();
  private ticking = false;
  private stopped = true;

  constructor(
    private readonly deps: {
      outbox: Outbox;
      store: MessageStore;
      messengerAccounts: MessengerAccounts;
      executor: DeliveryExecutor;
      worker: string;
      logger: Logger;
      intervalMs?: number;
      random?: () => number;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 1_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // Let in-flight deliveries finish so they are recorded (claims of the rest expire on their own).
    const deadline = Date.now() + 10_000;
    while (this.running.size > 0 && Date.now() < deadline) await sleep(50);
  }

  /** Looks for due jobs now instead of at the next interval. */
  kick(): void {
    if (!this.stopped) void this.tick();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const accounts = await this.deps.executor.accounts();
      const due = await this.deps.outbox.dueAccounts(accounts);
      for (const accountId of due) {
        if (this.running.has(accountId) || this.stopped) continue;
        this.running.add(accountId);
        void this.drain(accountId).finally(() => this.running.delete(accountId));
      }
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'outbox tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Delivers due jobs of one account in order until none is due. Exposed for tests. */
  async drain(accountId: string): Promise<void> {
    const { executor, outbox } = this.deps;
    await outbox.recoverInterrupted(accountId, executor.idempotentSend(accountId));
    for (let i = 0; i < 50 && !this.stopped; i++) {
      const state = await this.deps.messengerAccounts.get(accountId);
      if (state?.sendPausedUntil && state.sendPausedUntil > new Date()) {
        await outbox.holdAccount(accountId, state.sendPausedUntil);
        return;
      }
      const claimed = await outbox.claim(accountId, this.deps.worker);
      if (!claimed) return;
      const done = await this.process(accountId, claimed.row, claimed.job);
      if (!done) return;
    }
  }

  /** Returns false when the account must wait (pacing, flood, error). */
  private async process(accountId: string, row: OutboxRow, job: OutboundJob): Promise<boolean> {
    const { executor, outbox, store } = this.deps;
    const random = this.deps.random ?? Math.random;
    try {
      if (job.kind === 'message') {
        const limits = await executor.pacing(accountId);
        const sends = await outbox.recentSends(accountId);
        const decision = nextSendTime(
          limits,
          {
            lastSentAt: sends.reduce<Date | null>((a, s) => (!a || s.sentAt > a ? s.sentAt : a), null),
            sentLastDay: sends.map((s) => s.sentAt),
            newContactsLastDay: sends.filter((s) => s.newContact).map((s) => s.sentAt),
          },
          { now: new Date(), newContact: row.newContact, random },
        );
        if (decision.at.getTime() > Date.now()) {
          await outbox.release(row, decision.at, decision.ok ? undefined : `Waiting: ${decision.reason}`);
          return false;
        }
        if (limits.typing && executor.typing && job.text) {
          await executor.typing(accountId, job, typingDurationMs(job.text, random));
        }
      }

      const receipt = await executor.deliver(accountId, job);
      if (job.kind === 'message') {
        let messageId: string | undefined;
        if (receipt) {
          const [stored] = await store.ingest(accountId, [
            {
              chat: { externalId: job.chat.externalId, kind: job.chat.kind },
              externalId: receipt.externalId,
              direction: 'out',
              sentAt: receipt.sentAt,
              text: job.text ?? '',
              ...(job.replyToExternalId ? { replyToExternalId: job.replyToExternalId } : {}),
              ...(job.file
                ? {
                    attachments: [
                      {
                        externalId: `${receipt.externalId}:file`,
                        kind: job.file.kind,
                        name: job.file.name ?? fileNameOf(job.file.url),
                      },
                    ],
                  }
                : {}),
            },
          ]);
          messageId =
            stored?.id ??
            (await store.findMessageByExternalId(accountId, row.chatId, receipt.externalId))?.id;
        }
        await outbox.markSent(row.id, {
          sentAt: receipt?.sentAt ?? new Date(),
          ...(messageId ? { messageId } : {}),
        });
      } else {
        await store.markChatRead(row.chatId);
        await outbox.markSent(row.id, { sentAt: new Date() });
      }
      return true;
    } catch (error) {
      return this.handleFailure(accountId, row, error);
    }
  }

  private async handleFailure(accountId: string, row: OutboxRow, error: unknown): Promise<boolean> {
    const { executor, outbox, logger } = this.deps;
    const random = this.deps.random ?? Math.random;
    if (!(error instanceof DeliveryError)) {
      // We do not know whether the request reached the messenger.
      logger.warn({ err: error, job: row.id }, 'delivery failed with an unexpected error');
      if (executor.idempotentSend(accountId) || row.kind === 'mark_read') {
        return this.retry(row, 'Unexpected error, will retry', random);
      }
      await outbox.markFailed(
        row.id,
        'Delivery was interrupted by an unexpected error; it may or may not have been sent.',
        'uncertain',
      );
      return true;
    }
    switch (error.kind) {
      case 'rate_limited': {
        const seconds = Math.max(1, error.options.retryAfterSeconds ?? 30);
        const until = new Date(Date.now() + seconds * 1_000 + random() * 2_000);
        if (seconds > LONG_FLOOD_SECONDS) {
          await this.deps.messengerAccounts.pauseSending(
            accountId,
            until,
            `Flood wait of ${seconds} s: ${error.message}`,
          );
        }
        await outbox.release(row, until, `Rate limited for ${seconds} s`);
        return false;
      }
      case 'spam_warning': {
        const until = new Date(
          Date.now() + Math.max(SPAM_PAUSE_MS, (error.options.retryAfterSeconds ?? 0) * 1_000),
        );
        await this.deps.messengerAccounts.pauseSending(accountId, until, error.message);
        await outbox.release(row, until, `Sending paused: ${error.message}`);
        logger.warn({ account: accountId }, 'messenger spam warning: sending paused');
        return false;
      }
      case 'auth':
        await outbox.markFailed(row.id, error.message);
        await executor.onAuthError?.(accountId, error.message);
        return false;
      case 'rejected':
        await outbox.markFailed(row.id, error.message);
        return true;
      default:
        return this.retry(row, error.message, random);
    }
  }

  private async retry(row: OutboxRow, message: string, random: () => number): Promise<boolean> {
    if (row.attempts >= MAX_ATTEMPTS) {
      await this.deps.outbox.markFailed(row.id, `Gave up after ${row.attempts} attempts: ${message}`);
      return true;
    }
    const delay = Math.min(10 * 60_000, 5_000 * 2 ** (row.attempts - 1)) * (0.5 + random());
    await this.deps.outbox.release(row, new Date(Date.now() + delay), message);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The last path segment of a file URL, for the hub's copy of a sent file. */
function fileNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '') || 'file';
  } catch {
    return 'file';
  }
}
