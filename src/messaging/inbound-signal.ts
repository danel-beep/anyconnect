import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { DbListener } from '../db/listener.js';

/** Postgres NOTIFY channel: a new incoming message was stored (payload: the account id). */
export const INBOUND_CHANNEL = 'messenger_inbound';

/** How often a wait looks at the store when notifications are not delivered (no listener, lost connection). */
const POLL_MS = 2_000;

/**
 * Wakes the AI's waits for replies (`wait_for_reply`) as soon as a message arrives, in this process
 * directly and in other processes (the gateway, other hub instances) through Postgres NOTIFY. A
 * wake is only a hint: the wait then reads the store, so a lost or extra wake costs nothing.
 */
export class InboundSignal {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly db: Db,
    private readonly listener?: DbListener,
  ) {
    listener?.listen(
      INBOUND_CHANNEL,
      (accountId) => this.wake(accountId),
      () => this.wakeAll(),
    );
  }

  /** Called after a new incoming message was stored. Never throws. */
  async notify(accountId: string): Promise<void> {
    this.wake(accountId);
    await this.db.execute(sql`select pg_notify(${INBOUND_CHANNEL}, ${accountId})`).catch(() => {});
  }

  /** Resolves when a message may have arrived for the account, after `ms`, or when `signal` aborts. */
  wait(accountId: string, ms: number, signal?: AbortSignal): Promise<void> {
    const delay = this.listener?.connected ? ms : Math.min(ms, POLL_MS);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        const set = this.waiters.get(accountId);
        set?.delete(done);
        if (set?.size === 0) this.waiters.delete(accountId);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, delay));
      if (signal?.aborted) return done();
      signal?.addEventListener('abort', done, { once: true });
      let set = this.waiters.get(accountId);
      if (!set) {
        set = new Set();
        this.waiters.set(accountId, set);
      }
      set.add(done);
    });
  }

  private wake(accountId: string): void {
    for (const done of [...(this.waiters.get(accountId) ?? [])]) done();
  }

  private wakeAll(): void {
    for (const accountId of [...this.waiters.keys()]) this.wake(accountId);
  }
}
