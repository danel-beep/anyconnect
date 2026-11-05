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
  private stopped = true;

  constructor(
    private readonly options: {
      /** Does what is due now; returns when the next known work is due (undefined: none known). */
      work: () => Promise<Date | undefined>;
      /** Longest sleep without a kick or a due time (may change, e.g. while events are unavailable). */
      idleMs: () => number;
      /** A failed run is reported and retried after `idleMs`; it never stops the loop. */
      onError: (error: unknown) => void;
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
    if (this.stopped || this.running) {
      if (this.running) this.again = true;
      return;
    }
    this.schedule(at.getTime() - this.now());
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
    let next: Date | undefined;
    try {
      next = await this.options.work();
    } catch (error) {
      this.options.onError(error);
    }
    if (this.stopped || this.again) return;
    const idle = this.options.idleMs();
    this.schedule(next ? Math.min(next.getTime() - this.now(), idle) : idle);
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
