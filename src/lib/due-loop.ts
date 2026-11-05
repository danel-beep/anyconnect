/**
 * Runs `work` when something may be due, instead of on a fast fixed interval:
 *
 * - at once when kicked (new work arrived: a call was scheduled, an event came in);
 * - when the next due time that `work` reported arrives (a call's undo window ends);
 * - at the latest after `idleMs()`, as a safety net for work it was not told about (another
 *   instance scheduled it, an event was lost).
 *
 * So an idle loop costs one run per `idleMs` instead of one per second, and due work runs on
 * time rather than up to one interval late. Runs never overlap; a kick during a run starts
 * another run right after it.
 */
export class DueLoop {
  private timer: NodeJS.Timeout | undefined;
  private timerAt: number | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  /** Earliest `wakeAt` asked for during a run; the run's own plan takes it into account. */
  private wakeDuringRun: number | undefined;
  private stopped = true;

  constructor(
    private readonly options: {
      /** Does what is due now; returns when the next known work is due (undefined: none known). */
      work: () => Promise<Date | undefined>;
      /** Longest sleep without a kick or a due time (may change, e.g. while events are unavailable). */
      idleMs: () => number;
      /** A failed run is reported and retried after `idleMs`; it never stops the loop. */
      onError: (error: unknown) => void;
      /**
       * Shortest pause before a run started by a due time (default 200 ms), so a due time that is
       * already past (work another process holds) cannot make the loop spin. Kicks are not delayed.
       */
      minGapMs?: number;
      now?: () => number;
    },
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.kick();
  }

  /** Runs now (or right after the current run). */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.clearTimer();
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** Makes sure the loop runs no later than `at` (e.g. a call scheduled for the end of its undo window). */
  wakeAt(at: Date): void {
    if (this.stopped) return;
    if (this.running) {
      this.wakeDuringRun = Math.min(this.wakeDuringRun ?? Number.POSITIVE_INFINITY, at.getTime());
      return;
    }
    this.schedule(Math.max(this.options.minGapMs ?? 200, at.getTime() - this.now()));
  }

  /** Waits for the current run; no run starts afterwards. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    await this.running;
  }

  /** Resolves when the loop is idle (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async run(): Promise<void> {
    let next: number | undefined;
    try {
      next = (await this.options.work())?.getTime();
    } catch (error) {
      this.options.onError(error);
    }
    // A kick during the run starts another run at once; that run's plan includes what was asked.
    if (this.stopped || this.again) return;
    const asked = this.wakeDuringRun;
    this.wakeDuringRun = undefined;
    if (asked !== undefined) next = Math.min(next ?? asked, asked);
    const gap = this.options.minGapMs ?? 200;
    const untilDue = next !== undefined ? Math.max(gap, next - this.now()) : Number.POSITIVE_INFINITY;
    this.schedule(Math.min(untilDue, this.options.idleMs()));
  }

  private schedule(inMs: number): void {
    const delay = Math.max(0, inMs);
    if (this.timer && this.timerAt !== undefined && this.timerAt <= this.now() + delay) return;
    this.clearTimer();
    this.timerAt = this.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = undefined;
      this.kick();
    }, delay);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = undefined;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
