import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { planEmbeddedGateway, startEmbeddedGateway } from '../src/gateway/embedded.js';
import { createLogger } from '../src/logger.js';
import { HttpGatewayClient } from '../src/messaging/gateway-client.js';
import { freePort, resetDatabase, TEST_DATABASE_URL, TEST_KEY } from './helpers.js';

describe('gateway client', () => {
  it('sends each id as one path segment, whatever characters it has', async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new HttpGatewayClient({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        token: 'x'.repeat(32),
        messengerAccounts: { get: async () => undefined } as never,
      });
      // What a signed-in user could put in the address of the login page to reach another account.
      await client.cancelLogin('acc_mine', '../../acc_victim/logout');
      await client.cancelLogin('acc_mine', 'lgn_1?x=1#y');
      expect(seen).toEqual([
        'DELETE /v1/accounts/acc_mine/login/..%2F..%2Facc_victim%2Flogout',
        'DELETE /v1/accounts/acc_mine/login/lgn_1%3Fx%3D1%23y',
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('embedded messenger gateway', () => {
  it('is off by default and refuses to run next to a separate gateway', () => {
    expect(planEmbeddedGateway({})).toBeUndefined();
    expect(() => planEmbeddedGateway({ GATEWAY_EMBEDDED: 'true', GATEWAY_URL: 'http://gw:10000' })).toThrow(
      /exclude each other/,
    );
  });

  it('listens on localhost with its own token, which the hub configuration picks up', async () => {
    await resetDatabase();
    const env = {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      ENCRYPTION_KEY: TEST_KEY,
      LOG_LEVEL: 'silent',
      GATEWAY_EMBEDDED: 'true',
      GATEWAY_EMBEDDED_PORT: '0',
    };
    expect(() => planEmbeddedGateway(env)).toThrow(/not a port/);
    const port = String(await freePort());
    const plan = planEmbeddedGateway({ ...env, GATEWAY_EMBEDDED_PORT: port })!;
    expect(plan.url).toBe(`http://127.0.0.1:${port}`);
    expect(plan.token.length).toBeGreaterThanOrEqual(32);
    expect(planEmbeddedGateway({ ...env, GATEWAY_EMBEDDED_PORT: port })!.token).not.toBe(plan.token);
    const hubConfig = loadConfig({ ...env, GATEWAY_URL: plan.url, GATEWAY_TOKEN: plan.token });
    expect(hubConfig.gateway).toEqual({ url: plan.url, token: plan.token });

    const gateway = await startEmbeddedGateway(plan, createLogger({ level: 'silent' }));
    try {
      const health = await fetch(`${plan.url}/healthz`);
      expect(health.status).toBe(200);
      expect((await fetch(`${plan.url}/v1/accounts/acc_x/login/lgn_x`)).status).toBe(401);
      const client = new HttpGatewayClient({
        baseUrl: plan.url,
        token: plan.token,
        messengerAccounts: gateway.runtime.messaging.accounts,
      });
      await expect(client.getLogin('acc_x', 'lgn_x')).rejects.toThrow(/not found/i);
      // An id is one path segment: it cannot lead to another account's endpoint.
      await expect(client.cancelLogin('acc_x', '..')).rejects.toThrow(/not found/i);
      await expect(client.getLogin('..', 'lgn_x')).rejects.toThrow(/not found/i);
    } finally {
      await gateway.stop();
    }
  });
});
