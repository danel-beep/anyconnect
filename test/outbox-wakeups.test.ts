import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbListener } from '../src/db/listener.js';
import { createLogger } from '../src/logger.js';
import type { MessengerAccounts } from '../src/messaging/accounts.js';
import { type DeliveryExecutor, Dispatcher } from '../src/messaging/dispatcher.js';
import { OUTBOX_CHANNEL, type Outbox } from '../src/messaging/outbox.js';
import type { MessageStore } from '../src/messaging/store.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * When the outbox dispatcher looks for work. Delivery itself is covered by the messenger tests;
 * here the outbox is a stand-in that only answers "what is due" and never hands out a job.
 */
describe('outbox dispatcher wake-ups', () => {
  let dispatcher: Dispatcher | undefined;
  afterEach(async () => {
    await dispatcher?.stop();
    dispatcher = undefined;
  });

  function setup(options: { connected: boolean; intervalMs?: number; backstopMs?: number }) {
    const looks: number[] = [];
    const state = { due: [] as string[], next: undefined as Date | undefined };
    const outbox = {
      dueAccounts: async () => {
        looks.push(Date.now());
        return state.due;
      },
      nextDue: async () => state.next,
      recoverInterrupted: async () => 0,
      // Another process is sending for the account: nothing can be taken.
      claim: async () => undefined,
    } as unknown as Outbox;
    let onNotify: (() => void) | undefined;
    const listener: DbListener = {
      connected: options.connected,
      listen: (channel, notify) => {
        expect(channel).toBe(OUTBOX_CHANNEL);
        onNotify = () => notify('acc_1');
        return () => {
          onNotify = undefined;
        };
      },
    };
    const executor: DeliveryExecutor = {
      accounts: () => ['acc_1'],
      idempotentSend: () => false,
      pacing: async () => {
        throw new Error('not used');
      },
      deliver: async () => undefined,
    };
    dispatcher = new Dispatcher({
      outbox,
      store: {} as MessageStore,
      messengerAccounts: { get: async () => undefined } as unknown as MessengerAccounts,
      executor,
      worker: 'test',
      logger: createLogger({ level: 'silent' }),
      listener,
      ...(options.intervalMs ? { intervalMs: options.intervalMs } : {}),
      ...(options.backstopMs ? { backstopMs: options.backstopMs } : {}),
    });
    return { looks, state, notify: () => onNotify?.() };
  }

  it('sleeps while idle and wakes on a notification from another process', async () => {
    const { looks, notify } = setup({ connected: true, intervalMs: 20 });
    dispatcher!.start();
    await vi.waitFor(() => expect(looks).toHaveLength(1));
    await sleep(150);
    // Polling every 20 ms would have looked ~7 times by now.
    expect(looks).toHaveLength(1);
    notify();
    await vi.waitFor(() => expect(looks).toHaveLength(2));
  });

  it('wakes when a held-back job is due, not before', async () => {
    const { looks, state } = setup({ connected: true, intervalMs: 20 });
    const started = Date.now();
    state.next = new Date(started + 250);
    dispatcher!.start();
    await vi.waitFor(() => expect(looks).toHaveLength(2), { timeout: 2_000, interval: 10 });
    expect(looks[1]! - started).toBeGreaterThanOrEqual(240);
  });

  it('retries a due job it cannot take after intervalMs, without spinning', async () => {
    const { looks, state } = setup({ connected: true, intervalMs: 100 });
    state.due = ['acc_1'];
    state.next = new Date(Date.now() - 1_000);
    dispatcher!.start();
    await sleep(550);
    // About one look per 100 ms (each drain ends at once: another process holds the account).
    expect(looks.length).toBeGreaterThanOrEqual(3);
    expect(looks.length).toBeLessThanOrEqual(8);
  });

  it('polls every intervalMs while notifications are unavailable', async () => {
    const { looks } = setup({ connected: false, intervalMs: 50, backstopMs: 60_000 });
    dispatcher!.start();
    await sleep(380);
    expect(looks.length).toBeGreaterThanOrEqual(4);
    expect(looks.length).toBeLessThanOrEqual(9);
  });
});
