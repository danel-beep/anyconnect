import { describe, expect, it } from 'vitest';
import type { OutboundJob, SentReceipt } from '../src/connectors/messaging.js';
import { createLogger } from '../src/logger.js';
import type { MessengerAccounts } from '../src/messaging/accounts.js';
import { type DeliveryExecutor, Dispatcher } from '../src/messaging/dispatcher.js';
import type { Outbox, OutboxRow } from '../src/messaging/outbox.js';
import type { MessageStore } from '../src/messaging/store.js';

/** What node-postgres throws when the database restarts under an open connection. */
const dbDown = () => new Error('Connection terminated unexpectedly');

/**
 * The outbox while the database blinks: a message the messenger accepted is never reported as
 * "maybe not sent" (the AI or the user would send it again), and one that never reached the
 * messenger is never reported as uncertain either.
 */
describe('outbox delivery during a database outage', () => {
  function setup(options: { failIngest?: number; failPacing?: boolean }) {
    const row = {
      id: 'obx_1',
      chatId: 'cht_1',
      attempts: 1,
      newContact: false,
      kind: 'message',
    } as OutboxRow;
    const job: OutboundJob = {
      id: 'obx_1',
      attempt: 1,
      kind: 'message',
      chat: { externalId: 'c1', kind: 'direct' },
      text: 'hello',
    };
    const calls: string[] = [];
    let claimed = false;
    let ingestFailures = options.failIngest ?? 0;
    const outbox = {
      // The loop itself finds nothing: these tests drive `drain` directly.
      dueAccounts: async () => [],
      nextDue: async () => undefined,
      recoverInterrupted: async () => 0,
      claim: async () => {
        if (claimed) return undefined;
        claimed = true;
        return { row, job };
      },
      recentSends: async () => [],
      markSent: async (_id: string, result: { messageId?: string }) => {
        calls.push(`sent:${result.messageId ?? '-'}`);
      },
      markFailed: async (_id: string, _message: string, status = 'failed') => {
        calls.push(`failed:${status}`);
      },
      release: async (_row: OutboxRow, _at: Date, message?: string) => {
        calls.push(`release:${message}`);
      },
    } as unknown as Outbox;
    const store = {
      ingest: async () => {
        if (ingestFailures > 0) {
          ingestFailures--;
          calls.push('ingest:down');
          throw dbDown();
        }
        calls.push('ingest');
        return [{ id: 'msg_1' }];
      },
    } as unknown as MessageStore;
    const executor: DeliveryExecutor = {
      accounts: () => ['acc_1'],
      idempotentSend: () => false,
      pacing: async () => {
        if (options.failPacing) throw dbDown();
        return {
          perMinute: 1000,
          perHour: 1000,
          perDay: 1000,
          newContactsPerDay: 1000,
          minGapMs: 0,
          maxGapMs: 0,
          typing: false,
        };
      },
      deliver: async (): Promise<SentReceipt> => {
        calls.push('deliver');
        return { externalId: 'm1', sentAt: new Date() };
      },
    };
    const dispatcher = new Dispatcher({
      outbox,
      store,
      messengerAccounts: { get: async () => undefined } as unknown as MessengerAccounts,
      executor,
      worker: 'test',
      logger: createLogger({ level: 'silent' }),
      recordRetryMs: [10, 20, 40],
    });
    dispatcher.start();
    return { dispatcher, calls };
  }

  it('records a delivered message once the database answers again, never as uncertain', async () => {
    const { dispatcher, calls } = setup({ failIngest: 2 });
    await dispatcher.drain('acc_1');
    await dispatcher.stop();
    expect(calls).toEqual(['deliver', 'ingest:down', 'ingest:down', 'ingest', 'sent:msg_1']);
  });

  it('marks a delivered message sent even when its copy cannot be stored', async () => {
    const { dispatcher, calls } = setup({ failIngest: 99 });
    await dispatcher.drain('acc_1');
    await dispatcher.stop();
    expect(calls.filter((c) => c === 'deliver')).toHaveLength(1);
    expect(calls.at(-1)).toBe('sent:-');
    expect(calls.filter((c) => c === 'ingest:down')).toHaveLength(4);
    expect(calls.some((c) => c.startsWith('failed'))).toBe(false);
  });

  it('retries a message the database stopped before it was sent, instead of calling it uncertain', async () => {
    const { dispatcher, calls } = setup({ failPacing: true });
    await dispatcher.drain('acc_1');
    await dispatcher.stop();
    expect(calls).toEqual(['release:Temporary error before sending, will retry']);
  });
});
