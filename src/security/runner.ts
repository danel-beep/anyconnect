import type { DbListener } from '../db/listener.js';
import { DueLoop } from '../lib/due-loop.js';
import type { Logger } from '../logger.js';
import type { ConfirmationCenter } from './confirmations.js';
import {
  PENDING_CALLS_CHANNEL,
  type PendingCallRow,
  type PendingCallService,
  type StoredResult,
} from './pending-calls.js';

/** Executes an approved call as its original caller, skipping the confirmation stage. */
export type RunPendingCall = (row: PendingCallRow, args: Record<string, unknown>) => Promise<StoredResult>;

/**
 * Runs approved calls whose undo window has ended. Every hub instance runs one; claiming is
 * atomic (`FOR UPDATE SKIP LOCKED`), so a call runs exactly once.
 *
 * It does not poll: a call scheduled in this process wakes it exactly when the call is due, one
 * scheduled by another instance wakes it through Postgres NOTIFY, and an idle runner looks at the
 * database once per `backstopMs` as a safety net. While notifications are down it looks every
 * `pollMs`, so a call another instance scheduled (and maybe left behind) is not late.
 */
export class PendingCallRunner {
  private readonly loop: DueLoop;
  private maintenance: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private unlisten: (() => void) | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly deps: {
      pending: PendingCallService;
      center: ConfirmationCenter;
      run: RunPendingCall;
      logger: Logger;
      /** Longest sleep of an idle runner. */
      backstopMs: number;
      /** Calls scheduled by other instances (absent: only this process schedules). */
      listener?: DbListener;
      /** Longest sleep while the listener is not connected (default 5 s). */
      pollMs?: number;
    },
  ) {
    this.loop = new DueLoop({
      work: async () => {
        await this.tick();
        return this.deps.pending.nextDue();
      },
      idleMs: () =>
        this.deps.listener && !this.deps.listener.connected
          ? (this.deps.pollMs ?? 5_000)
          : this.deps.backstopMs,
      onError: (error) => this.deps.logger.warn({ err: error }, 'pending call runner failed'),
    });
  }

  start(): void {
    if (this.maintenance) return;
    this.unsubscribe = this.deps.pending.onScheduled((at) => this.loop.wakeAt(at));
    this.unlisten = this.deps.listener?.listen(
      PENDING_CALLS_CHANNEL,
      () => this.loop.kick(),
      () => this.loop.kick(),
    );
    this.loop.start();
    this.maintenance = setInterval(
      () =>
        void this.deps.pending
          .maintain()
          .catch((err) => this.deps.logger.warn({ err }, 'pending maintenance')),
      60_000,
    );
    this.maintenance.unref();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unlisten?.();
    clearInterval(this.maintenance);
    this.maintenance = undefined;
    await this.loop.stop();
    // A failed claim is already reported by the loop; it must not abort shutdown.
    await this.running?.catch(() => {});
  }

  /** Runs everything that is due now. Overlapping ticks are skipped. */
  tick(): Promise<void> {
    if (!this.running) {
      this.running = this.runDue().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async runDue(): Promise<void> {
    const { pending, center, run, logger } = this.deps;
    // A failed claim fails the run: the loop reports it and backs off, instead of seeing the
    // unclaimed call as due right now and trying again in a tight loop.
    const due: PendingCallRow[] = await pending.claimDue();
    await Promise.all(
      due.map(async (row) => {
        let result: StoredResult;
        try {
          result = await run(row, pending.args(row));
        } catch (error) {
          logger.error({ err: error, pendingCall: row.id }, 'pending call failed');
          result = {
            content: [{ type: 'text', text: 'Internal error while running the call.' }],
            isError: true,
          };
        }
        await pending
          .complete(row.id, result)
          .catch((err) => logger.error({ err }, 'could not store result'));
        await center.refresh(row.id);
      }),
    );
  }
}
