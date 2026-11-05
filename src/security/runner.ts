import { DueLoop } from '../lib/due-loop.js';
import type { Logger } from '../logger.js';
import type { ConfirmationCenter } from './confirmations.js';
import type { PendingCallRow, PendingCallService, StoredResult } from './pending-calls.js';

/** Executes an approved call as its original caller, skipping the confirmation stage. */
export type RunPendingCall = (row: PendingCallRow, args: Record<string, unknown>) => Promise<StoredResult>;

/**
 * Runs approved calls whose undo window has ended. Every hub instance runs one; claiming is
 * atomic (`FOR UPDATE SKIP LOCKED`), so a call runs exactly once.
 *
 * It does not poll: a call scheduled in this process wakes it exactly when the call is due, and
 * an idle runner looks at the database once per `backstopMs` (calls scheduled by another instance
 * that stopped before running them).
 */
export class PendingCallRunner {
  private readonly loop: DueLoop;
  private maintenance: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly deps: {
      pending: PendingCallService;
      center: ConfirmationCenter;
      run: RunPendingCall;
      logger: Logger;
      /** Longest sleep of an idle runner. */
      backstopMs: number;
    },
  ) {
    this.loop = new DueLoop({
      work: async () => {
        await this.tick();
        return this.deps.pending.nextDue();
      },
      idleMs: () => this.deps.backstopMs,
      onError: (error) => this.deps.logger.warn({ err: error }, 'pending call runner failed'),
    });
  }

  start(): void {
    if (this.maintenance) return;
    this.unsubscribe = this.deps.pending.onScheduled((at) => this.loop.wakeAt(at));
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
    clearInterval(this.maintenance);
    this.maintenance = undefined;
    await this.loop.stop();
    await this.running;
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
    let due: PendingCallRow[];
    try {
      due = await pending.claimDue();
    } catch (error) {
      logger.warn({ err: error }, 'could not claim pending calls');
      return;
    }
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
