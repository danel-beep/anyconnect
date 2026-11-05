import pg from 'pg';
import { BRAND } from '../brand.js';
import type { Logger } from '../logger.js';

/**
 * Postgres LISTEN/NOTIFY for a whole process: one dedicated connection carries every channel, so a
 * background loop waits for "new work" instead of asking the database every second.
 *
 * A notification is only a hint to look now; the data is always read from the tables. Notifications
 * sent while the connection is down are lost, so every subscriber's `onResync` runs whenever the
 * connection drops or comes back: it re-reads as if notified. While `connected` is false, loops fall
 * back to polling (see `DueLoop`'s `idleMs`).
 */
export interface DbListener {
  /**
   * Calls `onNotify(payload)` for each notification on `channel`, and `onResync()` when notifications
   * may have been missed. Returns a function that stops listening.
   */
  listen(channel: string, onNotify: (payload: string) => void, onResync?: () => void): () => void;
  /** True while notifications are delivered. */
  readonly connected: boolean;
}

interface Subscription {
  channel: string;
  onNotify: (payload: string) => void;
  onResync?: () => void;
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

export class PgListener implements DbListener {
  private client: pg.Client | undefined;
  private readonly subscriptions = new Set<Subscription>();
  private stopped = true;
  private retryMs: number;
  private retryTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private isConnected = false;

  constructor(
    private readonly options: {
      connectionString: string;
      logger: Logger;
      /** Reconnect delays: doubles from `min` up to `max` (default 1 s → 30 s). */
      retry?: { minMs: number; maxMs: number };
      /** A dead TCP connection can look idle: a cheap query this often proves it is alive (default 60 s). */
      pingMs?: number;
    },
  ) {
    this.retryMs = options.retry?.minMs ?? 1000;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  listen(channel: string, onNotify: (payload: string) => void, onResync?: () => void): () => void {
    const subscription: Subscription = { channel, onNotify, ...(onResync ? { onResync } : {}) };
    const first = ![...this.subscriptions].some((s) => s.channel === channel);
    this.subscriptions.add(subscription);
    if (first && this.client && this.isConnected) {
      this.client.query(`LISTEN ${quoteIdent(channel)}`).catch((err) => this.lost(err));
    }
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  /** Connects in the background; never throws (the process works without notifications too). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const client = this.client;
    this.client = undefined;
    this.isConnected = false;
    await client?.end().catch(() => {});
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({
      connectionString: this.options.connectionString,
      keepAlive: true,
      application_name: `${BRAND.slug}-listener`,
    });
    client.on('notification', (message) => {
      for (const s of this.subscriptions) {
        if (s.channel === message.channel) this.safely(() => s.onNotify(message.payload ?? ''));
      }
    });
    client.on('error', (err) => this.lost(err, client));
    client.on('end', () => this.lost(undefined, client));
    try {
      await client.connect();
      const channels = new Set([...this.subscriptions].map((s) => s.channel));
      for (const channel of channels) await client.query(`LISTEN ${quoteIdent(channel)}`);
    } catch (err) {
      await client.end().catch(() => {});
      this.retry(err);
      return;
    }
    if (this.stopped) {
      await client.end().catch(() => {});
      return;
    }
    this.client = client;
    this.isConnected = true;
    this.retryMs = this.options.retry?.minMs ?? 1000;
    this.pingTimer = setInterval(() => {
      client.query('SELECT 1').catch((err) => this.lost(err, client));
    }, this.options.pingMs ?? 60_000);
    this.pingTimer.unref();
    this.resyncAll();
  }

  /** The connection failed or ended: switch subscribers to polling and reconnect. */
  private lost(err: unknown, client = this.client): void {
    if (!client || client !== this.client) return;
    this.client = undefined;
    this.isConnected = false;
    clearInterval(this.pingTimer);
    client.end().catch(() => {});
    if (this.stopped) return;
    this.options.logger.warn({ err }, 'database notifications lost, reconnecting');
    this.resyncAll();
    this.retry(err);
  }

  private retry(err: unknown): void {
    if (this.stopped) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.options.retry?.maxMs ?? 30_000);
    this.options.logger.debug({ err, delay }, 'database listener: retrying');
    this.retryTimer = setTimeout(() => void this.connect(), delay);
    this.retryTimer.unref();
  }

  private resyncAll(): void {
    for (const s of this.subscriptions) if (s.onResync) this.safely(s.onResync);
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.options.logger.warn({ err }, 'database notification handler failed');
    }
  }
}
