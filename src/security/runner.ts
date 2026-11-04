import type { Logger } from '../logger.js';
import type { ConfirmationCenter } from './confirmations.js';
import type { PendingCallRow, PendingCallService, StoredResult } from './pending-calls.js';

/** Executes an approved call as its original caller, skipping the confirmation stage. */
export type RunPendingCall = (row: PendingCallRow, args: Record<string, unknown>) => Promise<StoredResult>;

/**
 * Runs approved calls whose undo window has ended. Every hub instance runs one; claiming is
 * atomic (`FOR UPDATE SKIP LOCKED`), so a call runs exactly once.
 */
export class PendingCallRunner {
  private timer: NodeJS.Timeout | undefined;
  private maintenance: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly deps: {
      pending: PendingCallService;
      center: ConfirmationCenter;
      run: RunPendingCall;
      logger: Logger;
      intervalMs: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
    this.maintenance = setInterval(
      () =>
        void this.deps.pending
          .maintain()
          .catch((err) => this.deps.logger.warn({ err }, 'pending maintenance')),
      60_000,
    );
    this.timer.unref();
    this.maintenance.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    clearInterval(this.maintenance);
    this.timer = undefined;
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
