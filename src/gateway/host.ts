import { and, eq, inArray } from 'drizzle-orm';
import {
  DeliveryError,
  type InboundChat,
  type OutboundJob,
  type SentReceipt,
} from '../connectors/messaging.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { ConnectorError } from '../connectors/sdk.js';
import type { AccountService } from '../core/accounts.js';
import type { Db } from '../db/client.js';
import { accounts, messengerAccounts } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { NetworkPolicy } from '../lib/network.js';
import type { Logger } from '../logger.js';
import { describeProblem, FATAL_PROBLEMS } from '../messaging/accounts.js';
import type { DeliveryExecutor } from '../messaging/dispatcher.js';
import type {
  DriverStatus,
  LoginStepInput,
  LoginView,
  StartLoginInput,
} from '../messaging/gateway-client.js';
import type { Messaging } from '../messaging/index.js';
import type { DriverSession, LiveSession, LoginFlow, SessionDriver } from './drivers/types.js';
import { SessionError } from './drivers/types.js';
import type { LeaseManager } from './leases.js';
import { FencedSessionState } from './state.js';

export interface HostOptions {
  /** Upper bound of sessions on this instance (memory: see docs/MESSENGERS.md). */
  maxSessions: number;
  /** How often to look for accounts that need a session. */
  scanIntervalMs: number;
  /** Random delay before starting each session, so a restart does not reconnect everything at once. */
  startJitterMs: number;
  /** Reconnect backoff: base * 2^failures, capped, with full jitter. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /**
   * Consecutive failures after which the circuit opens: the account shows the problem to the user
   * and is only tried every `circuitRetryMs` from then on, so a long outage of the messenger or
   * the network heals by itself once it is over, without a new login.
   */
  maxFailures: number;
  circuitRetryMs: number;
  /**
   * How long a session must stay online to count as working again. One that drops sooner keeps
   * its failure count, so a session that connects and falls over at once backs off instead of
   * reconnecting every few seconds (which the messenger could take for abuse).
   */
  stableMs: number;
  loginTtlMs: number;
}

export const DEFAULT_HOST_OPTIONS: HostOptions = {
  maxSessions: 200,
  scanIntervalMs: 10_000,
  startJitterMs: 15_000,
  backoffBaseMs: 5_000,
  backoffMaxMs: 15 * 60_000,
  maxFailures: 8,
  circuitRetryMs: 30 * 60_000,
  stableMs: 2 * 60_000,
  loginTtlMs: 5 * 60_000,
};

interface Running {
  accountId: string;
  token: number;
  abort: AbortController;
  live?: LiveSession;
  /** When the session came online (for `stableMs`). */
  onlineAt?: number;
  /** Consecutive failures recorded before this attempt. */
  failuresBefore: number;
  renewTimer?: NodeJS.Timeout;
  /**
   * When the last successful renewal (or the claim) was sent. The database set the expiry later
   * than that, so the lease is certainly ours until `renewedAt + ttl`.
   */
  renewedAt: number;
  renewing?: boolean;
  login?: { id: string; flow: LoginFlow; expiresAt: Date; timer: NodeJS.Timeout };
  done: Promise<void>;
}

class HostError extends ConnectorError {}

/** How often a failed lease renewal is retried (at most; a fifteenth of the TTL in tests). */
const RENEW_RETRY_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Rejects when `promise` takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(ms)} ms`)), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Runs the messenger sessions of this gateway instance: claims accounts through leases, connects
 * them with their driver, keeps the lease alive, reconnects with jittered exponential backoff,
 * stops accounts with fatal problems or too many failures (circuit breaker), and runs
 * interactive logins. Also the delivery executor for the outbox of its sessions.
 */
export class SessionHost implements DeliveryExecutor {
  private readonly running = new Map<string, Running>();
  /**
   * Whether the last session of each account deduplicated sends. Kept after the session ends: a
   * job interrupted by the drop is judged by the transport that took it, not by the absence of one.
   */
  private readonly idempotent = new Map<string, boolean>();
  private scanTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly options: HostOptions;

  constructor(
    private readonly deps: {
      db: Db;
      accounts: AccountService;
      connectors: ConnectorRegistry;
      messaging: Messaging;
      network: NetworkPolicy;
      leases: LeaseManager;
      drivers: SessionDriver[];
      logger: Logger;
      /** A session came online: deliver its queued messages now. */
      onOnline?: (accountId: string) => void;
      random?: () => number;
    },
    options: Partial<HostOptions> = {},
  ) {
    this.options = { ...DEFAULT_HOST_OPTIONS, ...options };
  }

  private get random(): () => number {
    return this.deps.random ?? Math.random;
  }

  private driver(connectorId: string): SessionDriver | undefined {
    return this.deps.drivers.find((d) => d.connectorId === connectorId);
  }

  start(): void {
    this.stopping = false;
    void this.scan();
    this.scanTimer = setInterval(() => void this.scan(), this.options.scanIntervalMs);
    this.scanTimer.unref();
  }

  /** Graceful stop: sessions end and leases are released, so the next instance takes over at once. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    await Promise.all([...this.running.values()].map((r) => this.shutdown(r)));
  }

  /** The drivers of this gateway and whether each can take logins (see `SessionDriver.missing`). */
  driverStatus(): DriverStatus[] {
    return this.deps.drivers.map((d) => ({
      connectorId: d.connectorId,
      ready: !d.missing,
      ...(d.missing ? { missing: d.missing } : {}),
    }));
  }

  sessionCount(): number {
    return this.running.size;
  }

  isOnline(accountId: string): boolean {
    return Boolean(this.running.get(accountId)?.live);
  }

  // -------------------------------------------------------------------------
  // Picking accounts
  // -------------------------------------------------------------------------

  /** Accounts that should have a session now and are not running here. Exposed for tests. */
  async candidates(): Promise<string[]> {
    const connectorIds = this.deps.drivers.map((d) => d.connectorId);
    if (connectorIds.length === 0) return [];
    const rows = await this.deps.db
      .select({
        id: accounts.id,
        connectorId: accounts.connectorId,
        config: accounts.config,
        state: messengerAccounts.state,
        problem: messengerAccounts.problem,
        nextAttemptAt: messengerAccounts.nextAttemptAt,
        leaseExpiresAt: messengerAccounts.leaseExpiresAt,
      })
      .from(accounts)
      .innerJoin(messengerAccounts, eq(messengerAccounts.accountId, accounts.id))
      .where(and(inArray(accounts.connectorId, connectorIds), eq(accounts.enabled, true)));
    const now = new Date();
    return rows
      .filter((row) => {
        if (this.running.has(row.id)) return false;
        if (row.state === 'needs_login') return false;
        // Accounts stopped by an older gateway after too many failures are retried like an open
        // circuit; the rest of the stopped ones wait for the user.
        if (row.state === 'stopped' && row.problem !== 'failing') return false;
        if (row.nextAttemptAt && row.nextAttemptAt > now) return false;
        if (row.leaseExpiresAt && row.leaseExpiresAt > now) return false;
        const connector = this.deps.connectors.all().find((c) => c.id === row.connectorId);
        const config = connector?.config.safeParse(row.config ?? {});
        return Boolean(config?.success && connector?.messenger?.transport(config.data).kind === 'session');
      })
      .map((row) => row.id);
  }

  async scan(): Promise<void> {
    if (this.stopping) return;
    try {
      const free = this.options.maxSessions - this.running.size;
      if (free <= 0) return;
      for (const accountId of (await this.candidates()).slice(0, free)) {
        const delay = Math.round(this.random() * this.options.startJitterMs);
        setTimeout(() => void this.launch(accountId), delay).unref();
      }
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'session scan failed');
    }
  }

  // -------------------------------------------------------------------------
  // Running a session
  // -------------------------------------------------------------------------

  /** Claims the account and connects it with saved state. Exposed for tests. */
  async launch(accountId: string): Promise<boolean> {
    if (this.stopping || this.running.has(accountId)) return false;
    let token: number | undefined;
    const claimedAt = Date.now();
    try {
      token = await this.deps.leases.acquire(accountId);
    } catch (error) {
      // The account may have been deleted since the scan; the next scan decides again.
      this.deps.logger.warn({ err: error, account: accountId }, 'could not claim a messenger account');
      return false;
    }
    if (token === undefined) return false;
    const running = this.track(accountId, token, claimedAt);
    running.done = this.connectAndWatch(running);
    return true;
  }

  private track(accountId: string, token: number, claimedAt: number): Running {
    const running: Running = {
      accountId,
      token,
      renewedAt: claimedAt,
      abort: new AbortController(),
      failuresBefore: 0,
      done: Promise.resolve(),
    };
    this.running.set(accountId, running);
    // Renew at a third of the TTL: two renewals can fail before the lease runs out.
    running.renewTimer = setInterval(
      () => void this.renew(running),
      Math.max(1_000, this.deps.leases.ttlMs / 3),
    );
    running.renewTimer.unref();
    return running;
  }

  /**
   * Extends the lease. "Lost" (another owner has it) stops the session at once. A failed renewal
   * (the database restarts, a network blip) proves nothing either way, so it is retried every
   * couple of seconds while the lease is certainly still ours; only when that time is nearly up
   * does the session stop, before anyone else could take the account over. So a database hiccup
   * no longer drops every messenger session, and two copies of one session still never run.
   */
  private async renew(running: Running): Promise<void> {
    if (running.renewing || running.abort.signal.aborted) return;
    running.renewing = true;
    const ttl = this.deps.leases.ttlMs;
    // Stop with a sixth of the lease to spare: time to close the session before it can expire.
    const deadline = running.renewedAt + ttl - ttl / 6;
    try {
      for (let failures = 0; ; failures++) {
        const sentAt = Date.now();
        const left = deadline - sentAt;
        if (left <= 0) {
          this.deps.logger.warn(
            { account: running.accountId, failures },
            'session lease could not be renewed in time: stopping the session',
          );
          break;
        }
        try {
          // A renewal that hangs (network split) must not outlast the lease either.
          const renewed = await withTimeout(this.deps.leases.renew(running.accountId, running.token), left);
          if (renewed) {
            running.renewedAt = sentAt;
            if (failures > 0)
              this.deps.logger.info({ account: running.accountId, failures }, 'session lease renewed');
            return;
          }
          this.deps.logger.warn({ account: running.accountId }, 'session lease lost: stopping the session');
          break;
        } catch (error) {
          if (running.abort.signal.aborted) return;
          if (failures === 0)
            this.deps.logger.warn(
              { err: error, account: running.accountId },
              'session lease renewal failed, retrying',
            );
          await sleep(Math.min(RENEW_RETRY_MS, ttl / 15, Math.max(0, deadline - Date.now())));
        }
      }
    } finally {
      running.renewing = false;
    }
    running.abort.abort(new Error('lease lost'));
    await running.live?.stop().catch(() => {});
  }

  private async session(running: Running): Promise<{ driver: SessionDriver; session: DriverSession }> {
    const resolved = await this.deps.messaging.service.resolve(running.accountId);
    if (!resolved) throw new SessionError('protocol', 'account is gone or is not a messenger');
    const driver = this.driver(resolved.connector.id);
    if (!driver) throw new SessionError('protocol', `no driver for ${resolved.connector.id}`);
    const ctx = await this.deps.messaging.service.context(resolved, running.abort.signal);
    const { store } = this.deps.messaging;
    const accountId = running.accountId;
    return {
      driver,
      session: {
        account: { id: accountId, name: resolved.row.name, config: ctx.config, credentials: ctx.credentials },
        state: new FencedSessionState(this.deps.db, this.deps.messaging.ciphers, accountId, {
          owner: this.deps.leases.owner,
          token: running.token,
        }),
        ingest: async (messages) => {
          await store.ingest(accountId, messages);
        },
        upsertChats: async (chats: InboundChat[]) => {
          for (const chat of chats) await store.upsertChat(accountId, chat);
        },
        signal: running.abort.signal,
        logger: ctx.logger,
        network: this.deps.network,
      },
    };
  }

  private async connectAndWatch(running: Running): Promise<void> {
    const { accountId } = running;
    const state = this.deps.messaging.accounts;
    try {
      const before = await state.get(accountId);
      running.failuresBefore = before?.failures ?? 0;
      // An open circuit keeps showing its problem while it tries again.
      await state.setState(
        accountId,
        before?.problem === 'failing'
          ? { state: 'connecting', problem: 'failing', message: before.problemMessage }
          : { state: 'connecting' },
      );
      const { driver, session } = await this.session(running);
      const live = await driver.connect(session);
      await this.goOnline(running, live);
      await live.closed;
      await this.finish(running, undefined);
    } catch (error) {
      await this.finish(running, error);
    }
  }

  private async goOnline(running: Running, live: LiveSession): Promise<void> {
    running.live = live;
    running.onlineAt = Date.now();
    this.idempotent.set(running.accountId, live.idempotentSend);
    await this.deps.messaging.accounts.setState(running.accountId, { state: 'online' });
    if (live.identity) {
      const [row] = await this.deps.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, running.accountId))
        .limit(1);
      if (row && row.metadata.identity !== live.identity) {
        await this.deps.db
          .update(accounts)
          .set({ metadata: { ...row.metadata, identity: live.identity } })
          .where(eq(accounts.id, running.accountId));
      }
    }
    this.deps.onOnline?.(running.accountId);
    this.deps.logger.info({ account: running.accountId }, 'messenger session online');
  }

  /** Decides what happens after a session ended: nothing, backoff, or stop (circuit breaker). */
  private async finish(running: Running, error: unknown): Promise<void> {
    const { accountId } = running;
    if (running.renewTimer) clearInterval(running.renewTimer);
    this.running.delete(accountId);
    const state = this.deps.messaging.accounts;
    const lostLease = running.abort.signal.aborted && !this.stopping;
    try {
      if (this.stopping || lostLease) {
        // Shutdown or another instance took over: leave the status to whoever runs it next.
        return;
      }
      if (!error) {
        await state.setState(accountId, { state: 'connecting' });
        return;
      }
      const problem = error instanceof SessionError ? error.problem : 'protocol';
      const message = error instanceof Error ? error.message.slice(0, 300) : String(error);
      if (FATAL_PROBLEMS.has(problem)) {
        await state.setState(accountId, { state: 'stopped', problem, message });
        this.deps.logger.warn({ account: accountId, problem }, 'messenger session stopped');
        return;
      }
      // A session that stayed up long enough proved the account works: count afresh.
      const stable = running.onlineAt !== undefined && Date.now() - running.onlineAt >= this.options.stableMs;
      const failures = (stable ? 0 : running.failuresBefore) + 1;
      const retryAfter = error instanceof SessionError ? (error.options.retryAfterSeconds ?? 0) * 1_000 : 0;
      if (failures >= this.options.maxFailures) {
        // Open circuit: the user sees the problem, and the account is tried again only rarely.
        const retry = this.options.circuitRetryMs;
        await state.setState(accountId, {
          state: 'backoff',
          problem: 'failing',
          message: `${failures} failed attempts, last: ${describeProblem(problem, message)}`,
          failures,
          nextAttemptAt: new Date(
            Date.now() + Math.max(retryAfter, Math.round(retry * (0.75 + this.random() / 2))),
          ),
        });
        if (failures === this.options.maxFailures)
          this.deps.logger.warn({ account: accountId, failures }, 'messenger session circuit opened');
        return;
      }
      const cap = Math.min(this.options.backoffMaxMs, this.options.backoffBaseMs * 2 ** (failures - 1));
      const delay = Math.max(retryAfter, Math.round(cap / 2 + this.random() * (cap / 2)));
      await state.setState(accountId, {
        state: 'backoff',
        problem,
        message,
        failures,
        nextAttemptAt: new Date(Date.now() + delay),
      });
    } catch (recordError) {
      // Status could not be saved (database down, account deleted); the lease still goes back.
      this.deps.logger.warn({ err: recordError, account: accountId }, 'could not record session status');
    } finally {
      await this.deps.leases.release(accountId, running.token).catch(() => {});
    }
  }

  private async shutdown(running: Running): Promise<void> {
    if (running.login) {
      clearTimeout(running.login.timer);
      await running.login.flow.cancel().catch(() => {});
    }
    running.abort.abort(new Error('shutdown'));
    await running.live?.stop().catch(() => {});
    await Promise.race([running.done, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (this.running.get(running.accountId) === running) {
      if (running.renewTimer) clearInterval(running.renewTimer);
      this.running.delete(running.accountId);
      await this.deps.leases.release(running.accountId, running.token).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async startLogin(accountId: string, input: StartLoginInput): Promise<LoginView> {
    const existing = this.running.get(accountId);
    if (existing) await this.shutdown(existing);
    const claimedAt = Date.now();
    const token = await this.deps.leases.acquire(accountId);
    if (token === undefined) {
      throw new HostError('upstream', 'Another gateway instance holds this account; try again in a minute.');
    }
    const running = this.track(accountId, token, claimedAt);
    try {
      const { driver, session } = await this.session(running);
      if (!driver.login)
        throw new HostError('invalid_input', 'This messenger does not support interactive login.');
      await this.deps.messaging.accounts.setState(accountId, { state: 'needs_login' });
      const flow = await driver.login(session, input);
      const id = newId('lgn');
      const expiresAt = new Date(Date.now() + this.options.loginTtlMs);
      const timer = setTimeout(() => void this.abandonLogin(running), this.options.loginTtlMs);
      timer.unref();
      running.login = { id, flow, expiresAt, timer };
      running.done = flow.done
        .then(
          async (live) => {
            clearTimeout(timer);
            await this.goOnline(running, live);
            await live.closed;
            await this.finish(running, undefined);
          },
          async () => {
            clearTimeout(timer);
            await this.releaseIdle(running);
          },
        )
        .catch((error) => this.finish(running, error));
      return this.loginView(running);
    } catch (error) {
      await this.releaseIdle(running);
      throw error;
    }
  }

  private async abandonLogin(running: Running): Promise<void> {
    if (running.live) return;
    await running.login?.flow.cancel().catch(() => {});
  }

  /** Ends a login that never produced a session; the account stays `needs_login`. */
  private async releaseIdle(running: Running): Promise<void> {
    if (running.renewTimer) clearInterval(running.renewTimer);
    if (this.running.get(running.accountId) === running) this.running.delete(running.accountId);
    running.abort.abort(new Error('login ended'));
    await this.deps.leases.release(running.accountId, running.token).catch(() => {});
  }

  private loginOf(accountId: string, loginId: string): Running {
    const running = this.running.get(accountId);
    if (!running?.login || running.login.id !== loginId)
      throw new HostError('not_found', 'Login not found or expired.');
    return running;
  }

  loginView(running: Running): LoginView {
    const login = running.login!;
    return {
      ...login.flow.view(),
      id: login.id,
      accountId: running.accountId,
      expiresAt: login.expiresAt.toISOString(),
      ...(running.live
        ? { step: 'done' as const, ...(running.live.identity ? { identity: running.live.identity } : {}) }
        : {}),
    };
  }

  getLogin(accountId: string, loginId: string): LoginView {
    return this.loginView(this.loginOf(accountId, loginId));
  }

  async submitLogin(accountId: string, loginId: string, input: LoginStepInput): Promise<LoginView> {
    const running = this.loginOf(accountId, loginId);
    await running.login!.flow.submit(input);
    // Give a successful step a moment to turn into a live session before answering.
    await Promise.race([
      running.login!.flow.done.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1_500)),
    ]);
    return this.loginView(running);
  }

  async cancelLogin(accountId: string, loginId: string): Promise<void> {
    const running = this.loginOf(accountId, loginId);
    clearTimeout(running.login!.timer);
    await running.login!.flow.cancel();
  }

  async logout(accountId: string): Promise<void> {
    const running = this.running.get(accountId) ?? (await this.claimForMaintenance(accountId));
    try {
      await running?.live?.logout?.();
    } finally {
      if (running) {
        await new FencedSessionState(this.deps.db, this.deps.messaging.ciphers, accountId, {
          owner: this.deps.leases.owner,
          token: running.token,
        })
          .clear()
          .catch(() => {});
        await this.shutdown(running);
      }
      await this.deps.messaging.accounts.setState(accountId, { state: 'needs_login', message: null });
    }
  }

  private async claimForMaintenance(accountId: string): Promise<Running | undefined> {
    const claimedAt = Date.now();
    const token = await this.deps.leases.acquire(accountId);
    if (token === undefined) return undefined;
    return this.track(accountId, token, claimedAt);
  }

  // -------------------------------------------------------------------------
  // Live operations (internal API) and outbox delivery
  // -------------------------------------------------------------------------

  live(accountId: string): LiveSession {
    const live = this.running.get(accountId)?.live;
    if (!live)
      throw new HostError('upstream', 'The account is not connected right now. Its status explains why.');
    return live;
  }

  accounts(): string[] {
    return [...this.running.values()].filter((r) => r.live).map((r) => r.accountId);
  }

  idempotentSend(accountId: string): boolean {
    return this.running.get(accountId)?.live?.idempotentSend ?? this.idempotent.get(accountId) ?? false;
  }

  /**
   * The session a job goes out through. Without one nothing was sent, so the job waits for the
   * reconnect (a transient failure) instead of being reported as possibly sent.
   */
  private sender(accountId: string): LiveSession {
    const live = this.running.get(accountId)?.live;
    if (!live) {
      throw new DeliveryError(
        'transient',
        'The session dropped before sending; the message waits for the reconnect.',
      );
    }
    return live;
  }

  async pacing(accountId: string) {
    const resolved = await this.deps.messaging.service.resolve(accountId);
    if (!resolved) throw new Error(`account ${accountId} is gone`);
    return this.deps.messaging.service.pacing(resolved);
  }

  async typing(accountId: string, job: OutboundJob, durationMs: number): Promise<void> {
    const live = this.sender(accountId);
    if (live.typing) await live.typing(job.chat.externalId, durationMs);
    else await new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  async deliver(accountId: string, job: OutboundJob): Promise<SentReceipt | undefined> {
    return this.sender(accountId).send(job);
  }
}
