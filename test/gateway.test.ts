import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliveryError } from '../src/connectors/messaging.js';
import type { Principal } from '../src/core/principal.js';
import { accounts, messengerAccounts, messengerOutbox } from '../src/db/schema.js';
import { gatewayApi } from '../src/gateway/api.js';
import { loadGatewayConfig } from '../src/gateway/config.js';
import { SessionError } from '../src/gateway/drivers/types.js';
import { createGatewayRuntime } from '../src/gateway/runtime.js';
import { LeaseLostError } from '../src/gateway/state.js';
import { createLogger } from '../src/logger.js';
import { createFakeLog, type FakeLog, fakeDriver, registryWithFakeChat } from './fake-messenger.js';
import {
  resetDatabase,
  startTestHub,
  TEST_DATABASE_URL,
  TEST_KEY,
  type TestHub,
  unwrapUntrusted,
} from './helpers.js';

const TOKEN = 'gateway-test-token-0123456789abcdef';
const logger = createLogger({ level: 'silent' });

async function until<T>(
  probe: () => Promise<T> | T,
  what: string,
  timeoutMs = 8_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A gateway instance (runtime + internal API) on a random port, sharing the hub's database. */
async function startGateway(instanceId: string, log: FakeLog, options: { leaseTtlMs?: number } = {}) {
  let handler: ((req: Request) => Response | Promise<Response>) | undefined;
  const server = serve({
    fetch: (req) => (handler ? handler(req) : new Response('starting', { status: 503 })),
    hostname: '127.0.0.1',
    port: 0,
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const driver = fakeDriver(log);
  const runtime = createGatewayRuntime(
    loadGatewayConfig({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_POOL_MAX: '4',
      ENCRYPTION_KEY: TEST_KEY,
      GATEWAY_TOKEN: TOKEN,
      GATEWAY_ADVERTISE_URL: url,
      ALLOW_PRIVATE_NETWORK: 'true',
      LOG_LEVEL: 'silent',
    }),
    {
      logger,
      drivers: [driver],
      connectors: registryWithFakeChat,
      instanceId,
      leaseTtlMs: options.leaseTtlMs ?? 1_500,
      dispatchIntervalMs: 100,
      host: {
        startJitterMs: 0,
        scanIntervalMs: 100,
        backoffBaseMs: 50,
        backoffMaxMs: 200,
        maxFailures: 3,
        circuitRetryMs: 600,
      },
    },
  );
  await runtime.start();
  handler = gatewayApi({ host: runtime.host, token: TOKEN, logger, version: 'test' }).fetch;
  let closed = false;
  return {
    url,
    driver,
    runtime,
    async close() {
      if (closed) return;
      closed = true;
      await runtime.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Gateway = Awaited<ReturnType<typeof startGateway>>;

describe('messenger gateway: one session per account, login, reconnects, delivery', () => {
  let hub: TestHub;
  let log: FakeLog;
  let gatewayA: Gateway;
  let gatewayB: Gateway | undefined;
  let principal: Principal;

  const call = async (tool: string, args: Record<string, unknown>) => {
    const catalog = await hub.services.hub.getCatalog(principal);
    const result = await hub.services.hub.callTool(principal, catalog, tool, args);
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? '';
    if (result.isError) throw new Error(text);
    return JSON.parse(unwrapUntrusted(text));
  };
  const row = async (accountId: string) => (await hub.services.messaging.accounts.get(accountId))!;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    log = createFakeLog();
    // The hub must know the gateway URL at start, so the gateway listens first.
    gatewayA = await startGateway('gw-a', log);
    hub = await startTestHub({
      connectors: registryWithFakeChat,
      seed: false,
      env: { GATEWAY_URL: gatewayA.url, GATEWAY_TOKEN: TOKEN },
    });
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const user = (await hub.services.db.query.users.findFirst())!;
    principal = { kind: 'session', userId: user.id, workspaceId: workspace.id, scopes: ['mcp', 'api'] };
    // These tests are about delivery, not about the user's confirmation of each message.
    await hub.services.policies.createRule(workspace.id, { connectorId: 'fakechat', confirm: 'never' });
  });

  afterEach(async () => {
    await gatewayB?.close();
    gatewayB = undefined;
    await gatewayA.close();
    await hub.close();
  });

  /** Creates a fakechat account and logs it in through the hub's gateway client (HTTP). */
  async function addLoggedInAccount() {
    const account = await hub.services.accounts.create(principal.workspaceId, {
      connectorId: 'fakechat',
      name: 'personal',
      label: 'Личный',
      config: {},
      credentials: {},
    });
    const gateway = hub.services.messaging.gateway!;
    const started = await gateway.startLogin(account.id, { method: 'qr' });
    expect(started).toMatchObject({ step: 'scan_qr', qr: 'fake-qr', accountId: account.id });
    expect((await gateway.submitLogin(account.id, started.id, {})).step).toBe('enter_code');
    expect(await gateway.submitLogin(account.id, started.id, { code: '00000' })).toMatchObject({
      step: 'enter_code',
      error: 'wrong code',
    });
    expect(await gateway.submitLogin(account.id, started.id, { code: '12345' })).toMatchObject({
      step: 'done',
      identity: '+10000000000',
    });
    await until(async () => (await row(account.id)).state === 'online', 'online after login');
    return account;
  }

  it('logs in over the internal API, goes online and shows status to the AI', async () => {
    const account = await addLoggedInAccount();
    const [stored] = await hub.services.db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(stored!.metadata.identity).toBe('+10000000000');
    expect(await hub.services.messaging.service.forAccount(account.id).session()).toMatchObject({
      state: 'online',
    });
    expect(gatewayA.runtime.host.isOnline(account.id)).toBe(true);
    expect((await row(account.id)).leaseOwner).toBe('gw-a');

    // The internal API refuses calls without the shared token.
    const denied = await fetch(`${gatewayA.url}/v1/accounts/${account.id}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'qr' }),
    });
    expect(denied.status).toBe(401);
  });

  it('runs one session per account across instances and hands over on a graceful stop', async () => {
    const account = await addLoggedInAccount();
    gatewayB = await startGateway('gw-b', log);
    const connectsBefore = log.connects;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(gatewayB.runtime.host.isOnline(account.id)).toBe(false);
    expect(log.connects).toBe(connectsBefore);

    await gatewayA.close();
    await until(() => gatewayB!.runtime.host.isOnline(account.id), 'takeover by the second instance');
    // The host marks the session live in memory first and writes "online" to the row right after.
    await until(async () => (await row(account.id)).state === 'online', 'online row after the takeover');
    // B connected with the device saved during the login on A.
    expect(log.connects).toBe(connectsBefore + 1);
    const lease = await row(account.id);
    expect(lease).toMatchObject({ leaseOwner: 'gw-b', leaseOwnerUrl: gatewayB.url, state: 'online' });

    // Requests that need the live session follow the lease to B (A is gone).
    const sent = await call('fakechat_send', { to: '+79990000000', text: 'Добрый день!' });
    expect(sent.status).toBe('sent');
  });

  it('stops the session when the lease is lost and rejects its state writes', async () => {
    const account = await addLoggedInAccount();
    const live = gatewayA.driver.lives.get(account.id)!;
    const session = gatewayA.driver.sessions.get(account.id)!;
    let stopped = false;
    void live.closed.then(() => {
      stopped = true;
    });

    // Another owner takes the lease (as after a network split where ours expired).
    await hub.services.db
      .update(messengerAccounts)
      .set({
        leaseOwner: 'intruder',
        fencingToken: sql`${messengerAccounts.fencingToken} + 1`,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(messengerAccounts.accountId, account.id));

    await until(() => stopped, 'session stop after the lease was lost');
    expect(gatewayA.runtime.host.isOnline(account.id)).toBe(false);
    await expect(session.state.set('device', { device: 'stale' })).rejects.toBeInstanceOf(LeaseLostError);
    expect(session.signal.aborted).toBe(true);
    // The status is left to the new owner.
    expect((await row(account.id)).leaseOwner).toBe('intruder');
  });

  it('rides out a short database hiccup, and stops before the lease can expire when it lasts', async () => {
    const account = await addLoggedInAccount();
    // A 6 s lease, renewed every 2 s: an outage of 2.5 s always spans a renewal.
    gatewayB = await startGateway('gw-b', log, { leaseTtlMs: 6_000 });
    await gatewayA.close();
    await until(() => gatewayB!.runtime.host.isOnline(account.id), 'takeover by the long-lease instance');
    const gateway = gatewayB;
    const live = gateway.driver.lives.get(account.id)!;
    let stopped = false;
    void live.closed.then(() => {
      stopped = true;
    });
    const { leases } = gateway.runtime;
    const renew = leases.renew.bind(leases);
    const down = () => Promise.reject(new Error('Connection terminated unexpectedly'));

    // Renewals fail for 2.5 s: the session stays up, unchanged (it used to stop at the first one).
    leases.renew = down;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    leases.renew = renew;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stopped).toBe(false);
    expect(gateway.driver.lives.get(account.id)).toBe(live);
    expect(gateway.runtime.host.isOnline(account.id)).toBe(true);

    // Renewals keep failing: the session stops while the lease is still ours, so no second
    // instance can be running it at the same time.
    leases.renew = down;
    await new Promise((resolve) => setTimeout(resolve, 50)); // a renewal already under way lands
    const expiresAt = (await row(account.id)).leaseExpiresAt!.getTime();
    await until(() => stopped, 'session stop after renewals kept failing', 8_000);
    expect(Date.now()).toBeLessThan(expiresAt);
    leases.renew = renew;
  });

  it('reconnects with backoff, opens the circuit after repeated failures and heals after it', async () => {
    const account = await addLoggedInAccount();
    const connectsBefore = log.connects;
    gatewayA.driver.lives.get(account.id)!.drop(new SessionError('network', 'connection reset'));
    // The reconnect works, but the session falls over at once: that does not count as working
    // again, so the failures keep adding up instead of reconnecting every few seconds forever.
    await until(
      () => log.connects > connectsBefore && gatewayA.runtime.host.isOnline(account.id),
      'reconnect',
    );
    gatewayA.driver.failures.push(new SessionError('network', 'connection reset'));
    gatewayA.driver.lives.get(account.id)!.drop(new SessionError('network', 'connection reset'));

    const open = await until(async () => {
      const r = await row(account.id);
      return r.problem === 'failing' ? r : undefined;
    }, 'circuit breaker');
    expect(open).toMatchObject({ state: 'backoff', failures: 3 });
    expect(log.connects).toBe(connectsBefore + 2);
    // The user sees why in the account's status.
    const [status] = await hub.services.db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(status).toMatchObject({ status: 'error' });
    expect(status!.statusMessage).toContain('keeps failing');
    expect(status!.statusMessage).toContain('connection reset');

    // No reconnects in the meantime, then one try after `circuitRetryMs`: the outage is over, the
    // session comes back with its saved state, no new login needed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(log.connects).toBe(connectsBefore + 2);
    await until(async () => (await row(account.id)).state === 'online', 'online after the circuit retry');
    expect(log.connects).toBe(connectsBefore + 3);
    expect(await row(account.id)).toMatchObject({ failures: 0, problem: null });
    const [healed] = await hub.services.db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(healed).toMatchObject({ status: 'active', statusMessage: null });
  });

  it('retries an account an older gateway stopped after too many failures', async () => {
    const account = await addLoggedInAccount();
    await gatewayA.close();
    await hub.services.messaging.accounts.setState(account.id, {
      state: 'stopped',
      problem: 'failing',
      message: '8 failed attempts',
      failures: 8,
    });
    gatewayB = await startGateway('gw-b', log);
    await until(async () => (await row(account.id)).state === 'online', 'online again');
  });

  it('recovers from one transient failure and stops at once on a ban', async () => {
    const account = await addLoggedInAccount();
    const before = log.connects;
    gatewayA.driver.lives.get(account.id)!.drop(new SessionError('network', 'connection reset'));
    // The backoff is a few tens of milliseconds here, too short to observe reliably: wait for the
    // reconnect itself, then check that the failure counter was reset.
    await until(
      async () => log.connects > before && (await row(account.id)).state === 'online',
      'reconnect after a transient failure',
    );
    expect((await row(account.id)).failures).toBe(0);

    const connects = log.connects;
    gatewayA.driver.lives.get(account.id)!.drop(new SessionError('banned', 'account banned'));
    const stopped = await until(async () => {
      const r = await row(account.id);
      return r.state === 'stopped' ? r : undefined;
    }, 'fatal stop');
    expect(stopped.problem).toBe('banned');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(log.connects).toBe(connects);
  });

  it('delivers queued messages through the session with typing first', async () => {
    const account = await addLoggedInAccount();
    const sent = await call('fakechat_send', { to: '+79991112233', text: 'Счёт отправлю сегодня вечером' });
    expect(sent).toMatchObject({ status: 'sent' });
    const job = log.sent.find((j) => j.kind === 'message');
    expect(job).toMatchObject({
      text: 'Счёт отправлю сегодня вечером',
      chat: { externalId: 'chat-+79991112233' },
    });
    expect(log.typed[0]).toBeGreaterThanOrEqual(1_000);
    expect(log.typed[0]).toBeLessThanOrEqual(8_000);

    // The sent message is in the store, so the AI sees its own reply in the chat.
    const chats = await call('fakechat_list_chats', {});
    expect(chats.chats).toHaveLength(1);
    const chat = await call('fakechat_read_chat', { chat: chats.chats[0].id });
    expect(chat.messages.map((m: { text: string }) => m.text)).toContain('Счёт отправлю сегодня вечером');

    // Same request again, past the hub's duplicate check: the outbox merges it with the first.
    const again = await hub.services.messaging.service
      .forAccount(account.id)
      .send({ to: '+79991112233', text: 'Счёт отправлю сегодня вечером' });
    expect(again).toMatchObject({ status: 'sent', deduplicated: true });
    expect(log.sent.filter((j) => j.kind === 'message')).toHaveLength(1);
  });

  it('delivers a message left mid-send by a gateway that died, with nothing else queued', async () => {
    const account = await addLoggedInAccount();
    await call('fakechat_send', { to: '+79991112233', text: 'first' });
    const chatId = (await call('fakechat_list_chats', {})).chats[0].id as string;
    await gatewayA.close();

    // The gateway crashed after claiming the job: it stays `sending` until its claim runs out.
    const { outbox } = hub.services.messaging;
    const { row: job } = await outbox.enqueue({
      accountId: account.id,
      chatId,
      kind: 'message',
      payload: { text: 'second' },
    });
    await hub.services.db
      .update(messengerOutbox)
      .set({
        status: 'sending',
        claimedBy: 'gw-a',
        claimExpiresAt: new Date(Date.now() - 1_000),
        attempts: 1,
      })
      .where(eq(messengerOutbox.id, job.id));

    gatewayB = await startGateway('gw-b', log);
    const sent = await until(async () => {
      const r = await outbox.get(job.id);
      return r?.status === 'sent' ? r : undefined;
    }, 'recovered job delivered');
    expect(sent.messageId).toBeTruthy();
    expect(log.sent.filter((j) => j.text === 'second')).toHaveLength(1);
  });

  it('keeps a job whose session dropped before sending in the queue, not as possibly sent', async () => {
    const account = await addLoggedInAccount();
    const { host } = gatewayA.runtime;
    expect(host.idempotentSend(account.id)).toBe(true);
    // Two failed reconnects open the circuit: the account stays offline for a while.
    gatewayA.driver.failures.push(new SessionError('network', 'down'), new SessionError('network', 'down'));
    gatewayA.driver.lives.get(account.id)!.drop(new SessionError('network', 'connection reset'));
    await until(() => !host.isOnline(account.id), 'session down');

    const job = {
      id: 'out_test',
      attempt: 1,
      kind: 'message' as const,
      chat: { externalId: 'c', kind: 'direct' as const },
      text: 'hi',
    };
    // Nothing reached the messenger: a transient failure, which the dispatcher retries.
    const error = await host.deliver(account.id, job).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveryError);
    expect((error as DeliveryError).kind).toBe('transient');
    // The transport of the account still deduplicates, so an interrupted job is safe to resend.
    expect(host.idempotentSend(account.id)).toBe(true);
  });
});
