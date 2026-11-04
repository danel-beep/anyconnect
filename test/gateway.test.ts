import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/core/principal.js';
import { accounts, messengerAccounts } from '../src/db/schema.js';
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
async function startGateway(instanceId: string, log: FakeLog) {
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
      leaseTtlMs: 1_500,
      dispatchIntervalMs: 100,
      host: { startJitterMs: 0, scanIntervalMs: 100, backoffBaseMs: 50, backoffMaxMs: 200, maxFailures: 3 },
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

  it('reconnects with backoff and opens the circuit after repeated failures', async () => {
    const account = await addLoggedInAccount();
    const connectsBefore = log.connects;
    gatewayA.driver.failures.push(
      new SessionError('network', 'connection reset'),
      new SessionError('network', 'connection reset'),
    );
    gatewayA.driver.lives.get(account.id)!.drop(new SessionError('network', 'connection reset'));

    const stopped = await until(async () => {
      const r = await row(account.id);
      return r.state === 'stopped' ? r : undefined;
    }, 'circuit breaker');
    expect(stopped).toMatchObject({ problem: 'failing', failures: 3 });
    expect(log.connects).toBe(connectsBefore + 2);
    const [status] = await hub.services.db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(status!.status).not.toBe('ok');

    // Nothing reconnects a stopped account until the user logs in again.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(log.connects).toBe(connectsBefore + 2);
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
});
