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
    'Test service built into Manyplug. Use it to check that the hub and multi-account routing work.',
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
  ui: {
    locales: {
      ru: {
        name: 'Демо',
        description:
          'Тестовый сервис Manyplug: помогает убедиться, что хаб и работа с несколькими аккаунтами настроены верно.',
        fields: {
          greeting: { label: 'Приветствие', hint: 'С него начинаются ответы этого аккаунта' },
          secret: {
            label: 'Секрет',
            hint: 'Любое значение. Хранится зашифрованным и целиком не показывается.',
          },
        },
        actions: {
          echo: {
            title: 'Эхо',
            description:
              'Возвращает сообщение с приветствием выбранного аккаунта. Подходит для проверки хаба.',
          },
          account_info: {
            title: 'Об аккаунте',
            description:
              'Показывает, какой аккаунт обработал вызов, и отпечаток его секрета: видно, что ключи расшифровываются для каждого аккаунта отдельно.',
          },
          fail: {
            title: 'Имитация ошибки',
            description:
              'Всегда завершается ошибкой выбранного вида. Нужна только для проверки обработки ошибок.',
          },
        },
      },
      en: {
        fields: {
          greeting: { label: 'Greeting', hint: 'Replies from this account start with it' },
          secret: { label: 'Secret', hint: 'Any value. Stored encrypted and never shown in full.' },
        },
        actions: {
          echo: {
            title: 'Echo',
            description:
              'Returns the message with the greeting of the chosen account. Handy for testing the hub.',
          },
          account_info: {
            title: 'Account info',
            description:
              'Shows which account handled the call and a fingerprint of its secret, proving that keys are decrypted per account.',
          },
          fail: {
            title: 'Simulate an error',
            description: 'Always fails with the chosen kind of error. Only for testing error handling.',
          },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'echo',
      title: 'Echo',
      description:
        'Returns the message back, prefixed with the greeting of the chosen account. Use it to test that the Manyplug hub works.',
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
      tags: ['test_only'],
      run: ({ kind }) => {
        throw new ConnectorError(kind, `Simulated ${kind} error from the demo service`);
      },
    }),
  ],
});
