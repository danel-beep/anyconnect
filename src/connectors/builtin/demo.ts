import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ConnectorError, defineConnector } from '../sdk.js';

/**
 * A self-contained test service. It needs no external API, so it is the quickest way to check
 * that an AI client sees the hub, its accounts and can call tools. It also exercises the whole
 * pipeline: per-account config, encrypted credentials, multi-account routing and error handling.
 */
export default defineConnector({
  id: 'demo',
  name: 'Demo',
  description:
    'Test service built into AnyConnect. Use it to check that the hub and multi-account routing work.',
  version: '1.0.0',
  config: z.object({
    greeting: z.string().max(200).default('Hello').describe('Greeting this account uses'),
  }),
  credentials: z.object({
    secret: z.string().min(1).describe('Any secret value; stored encrypted, never returned in full'),
  }),
  async test(ctx) {
    return { ok: true, identity: `demo:${ctx.account.name}` };
  },
  actions: (action) => [
    action({
      name: 'echo',
      title: 'Echo',
      description:
        'Returns the message back, prefixed with the greeting of the chosen account. Use it to test that the AnyConnect hub works.',
      input: z.object({
        message: z.string().min(1).max(2000).describe('Text to echo back'),
      }),
      hints: { readOnly: true, idempotent: true, openWorld: false },
      run: ({ message }, ctx) =>
        `${ctx.config.greeting} from account "${ctx.account.label}" (${ctx.account.name}): ${message}`,
    }),
    action({
      name: 'account_info',
      title: 'Account info',
      description:
        'Shows which account handled the call and a fingerprint of its stored secret (proves credentials are decrypted per account).',
      input: z.object({}),
      hints: { readOnly: true, idempotent: true, openWorld: false },
      run: (_input, ctx) => ({
        account: ctx.account,
        greeting: ctx.config.greeting,
        secretFingerprint: createHash('sha256').update(ctx.credentials.secret).digest('hex').slice(0, 12),
        serverTime: new Date().toISOString(),
      }),
    }),
    action({
      name: 'fail',
      title: 'Simulate an error',
      description: 'Always fails with the chosen error kind. Only for testing error handling.',
      input: z.object({
        kind: z
          .enum(['invalid_input', 'not_found', 'upstream'])
          .default('upstream')
          .describe('Error kind to simulate'),
      }),
      hints: { readOnly: true, openWorld: false },
      run: ({ kind }) => {
        throw new ConnectorError(kind, `Simulated ${kind} error from the demo service`);
      },
    }),
  ],
});
