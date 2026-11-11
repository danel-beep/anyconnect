/** Runs `fn` over items with limited parallelism, keeping the order of results. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!, index);
      }
    }),
  );
  return results;
}

/**
 * Lets at most `slots` callers run at a time; the rest wait in line (first come, first served).
 * Used where each caller holds something scarce while it works, e.g. a database connection kept
 * across a request to another service: a burst then queues here instead of emptying the pool.
 */
export class Semaphore {
  private free: number;
  private readonly waiting: Array<() => void> = [];

  constructor(slots: number) {
    this.free = Math.max(1, Math.floor(slots));
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next in line, so a newcomer cannot jump the queue.
      const next = this.waiting.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}
