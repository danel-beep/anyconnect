import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { planEmbeddedGateway, startEmbeddedGateway } from '../src/gateway/embedded.js';
import { createLogger } from '../src/logger.js';
import { HttpGatewayClient } from '../src/messaging/gateway-client.js';
import { resetDatabase, TEST_DATABASE_URL, TEST_KEY } from './helpers.js';

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
    const plan = planEmbeddedGateway({ ...env, GATEWAY_EMBEDDED_PORT: '19431' })!;
    expect(plan.url).toBe('http://127.0.0.1:19431');
    expect(plan.token.length).toBeGreaterThanOrEqual(32);
    expect(planEmbeddedGateway({ ...env, GATEWAY_EMBEDDED_PORT: '19431' })!.token).not.toBe(plan.token);
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
    } finally {
      await gateway.stop();
    }
  });
});
