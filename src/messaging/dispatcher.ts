import {
  DeliveryError,
  type OutboundJob,
  type PacingLimits,
  type SentReceipt,
} from '../connectors/messaging.js';
import { isDatabaseUnavailable } from '../db/errors.js';
import type { DbListener } from '../db/listener.js';
import { DueLoop } from '../lib/due-loop.js';
import type { Logger } from '../logger.js';
import type { MessengerAccounts } from './accounts.js';
import { OUTBOX_CHANNEL, type Outbox, type OutboxRow } from './outbox.js';
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
/** Waits between attempts to record a delivery while the database is unavailable (~15 s in all). */
const RECORD_RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000];
/** A flood wait longer than this pauses all sending of the account and is reported to the user. */
const LONG_FLOOD_SECONDS = 300;
const SPAM_PAUSE_MS = 24 * 3_600_000;

/**
 * Takes jobs from the outbox one at a time per account, applies pacing, shows typing, delivers
 * and records the result. Runs in-process; several dispatchers (hub instances, gateway instances)
 * can work at once because jobs are claimed in the database.
 *
 * It does not poll every second: a queued job wakes it (Postgres NOTIFY on {@link OUTBOX_CHANNEL},
 * or `kick()` in the process that queued it), a job held back by pacing wakes it when due, and an
 * idle dispatcher looks once per `backstopMs`. Without notifications it checks every `intervalMs`.
 */
export class Dispatcher {
  private readonly loop: DueLoop;
  private unlisten: (() => void) | undefined;
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
      /** Polling interval while database notifications are unavailable (default 1 s). */
      intervalMs?: number;
      /** Longest sleep of an idle dispatcher while notifications work (default 60 s). */
      backstopMs?: number;
      /** Database notifications: a job queued by another process wakes this dispatcher. */
      listener?: DbListener;
      random?: () => number;
      /** Waits between attempts to record a delivery while the database is down (tests shorten them). */
      recordRetryMs?: readonly number[];
    },
  ) {
    this.loop = new DueLoop({
      work: () => this.tickAndPlan(),
      idleMs: () =>
        this.deps.listener?.connected ? (this.deps.backstopMs ?? 60_000) : (this.deps.intervalMs ?? 1_000),
      onError: (error) => this.deps.logger.warn({ err: error }, 'outbox tick failed'),
    });
  }

  start(): void {
    this.stopped = false;
    this.unlisten = this.deps.listener?.listen(
      OUTBOX_CHANNEL,
      () => this.loop.kick(),
      () => this.loop.kick(),
    );
    this.loop.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unlisten?.();
    await this.loop.stop();
    // Let in-flight deliveries finish so they are recorded (claims of the rest expire on their own).
    const deadline = Date.now() + 10_000;
    while (this.running.size > 0 && Date.now() < deadline) await sleep(50);
  }

  /** Looks for due jobs now instead of at the next interval. */
  kick(): void {
    if (!this.stopped) this.loop.kick();
  }

  /** Starts what is due, then says when to look again: the next held-back job of an idle account. */
  private async tickAndPlan(): Promise<Date | undefined> {
    await this.tick();
    const accounts = await this.deps.executor.accounts();
    // Accounts being drained plan their own next look when the drain ends (afterDrain).
    const due = await this.deps.outbox.nextDue(accounts.filter((id) => !this.running.has(id)));
    return due && this.notBeforeRetry(due);
  }

  /** A drain stopped: wake when its account's next job is due (held back by pacing, a flood wait…). */
  private async afterDrain(accountId: string): Promise<void> {
    this.running.delete(accountId);
    if (this.stopped) return;
    try {
      const due = await this.deps.outbox.nextDue([accountId]);
      if (due) this.loop.wakeAt(this.notBeforeRetry(due));
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'outbox tick failed');
    }
  }

  /**
   * A job that is already due but was not taken (another process is sending for that account, or a
   * drain stopped after its batch) is looked at again after `intervalMs`, not in a tight loop.
   */
  private notBeforeRetry(due: Date): Date {
    const retry = Date.now() + (this.deps.intervalMs ?? 1_000);
    return due.getTime() < retry ? new Date(retry) : due;
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
        void this.drain(accountId)
          .catch((error) => this.deps.logger.warn({ err: error }, 'outbox drain failed'))
          .then(() => this.afterDrain(accountId));
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
    const { executor, outbox } = this.deps;
    const random = this.deps.random ?? Math.random;
    let receipt: SentReceipt | undefined;
    let handedOver = false;
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

      handedOver = true;
      receipt = await executor.deliver(accountId, job);
    } catch (error) {
      if (!handedOver && !(error instanceof DeliveryError)) {
        // Nothing reached the messenger yet (e.g. the database did not answer the pacing read): it
        // is certainly unsent, so it waits and goes again instead of being reported as uncertain.
        this.deps.logger.warn({ err: error, job: row.id }, 'delivery postponed by an error before sending');
        return this.retry(row, 'Temporary error before sending, will retry', random);
      }
      return this.handleFailure(accountId, row, error);
    }
    // From here the message is out: only writing that down can fail, and that must never make it
    // look unsent (a retry would send it twice).
    return this.recordDelivery(accountId, row, job, receipt);
  }

  /**
   * Records a delivery. While the database is briefly unavailable this is retried for about 15 s;
   * if it still fails the job is at least marked sent. Returns false when the drain should pause.
   */
  private async recordDelivery(
    accountId: string,
    row: OutboxRow,
    job: OutboundJob,
    receipt: SentReceipt | undefined,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.record(accountId, row, job, receipt);
        return true;
      } catch (error) {
        const wait = (this.deps.recordRetryMs ?? RECORD_RETRY_MS)[attempt];
        if (wait === undefined || !isDatabaseUnavailable(error)) {
          this.deps.logger.warn({ err: error, job: row.id }, 'delivered, but could not record the delivery');
          await this.deps.outbox.markSent(row.id, { sentAt: receipt?.sentAt ?? new Date() }).catch(() => {});
          return false;
        }
        await sleep(wait);
      }
    }
  }

  private async record(
    accountId: string,
    row: OutboxRow,
    job: OutboundJob,
    receipt: SentReceipt | undefined,
  ): Promise<void> {
    const { outbox, store } = this.deps;
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
            ...(receipt.attachments?.length
              ? { attachments: receipt.attachments }
              : job.file
                ? {
                    attachments: [
                      {
                        externalId: `${receipt.externalId}:file`,
                        kind: job.file.kind,
                        ...(job.file.name ? { name: job.file.name } : {}),
                        // Not kept by the messenger in a form the hub can fetch: get_attachment says so.
                        locator: { sentLink: job.file.url },
                      },
                    ],
                  }
                : {}),
          },
        ]);
        messageId =
          stored?.id ?? (await store.findMessageByExternalId(accountId, row.chatId, receipt.externalId))?.id;
      }
      await outbox.markSent(row.id, {
        sentAt: receipt?.sentAt ?? new Date(),
        ...(messageId ? { messageId } : {}),
      });
    } else {
      await store.markChatRead(row.chatId);
      await outbox.markSent(row.id, { sentAt: new Date() });
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
