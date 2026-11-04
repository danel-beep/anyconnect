import { z } from 'zod';
import type { BuiltinDeps } from '../src/connectors/index.js';
import { createBuiltinRegistry } from '../src/connectors/index.js';
import type { OutboundJob, SentReceipt } from '../src/connectors/messaging.js';
import { messengerActions } from '../src/connectors/messaging-actions.js';
import { defineConnector } from '../src/connectors/sdk.js';
import type { DriverSession, LiveSession, LoginFlow } from '../src/gateway/drivers/types.js';
import { SessionError } from '../src/gateway/drivers/types.js';

/** Built-in connectors plus `fakechat`, a messenger served by a gateway session. */
export function registryWithFakeChat(deps: BuiltinDeps) {
  return createBuiltinRegistry(deps).register(
    defineConnector({
      id: 'fakechat',
      name: 'FakeChat',
      description: 'Test messenger with a persistent session',
      version: '1.0.0',
      config: z.object({}),
      messenger: {
        transport: () => ({ kind: 'session' }),
        pacing: () => ({ minGapMs: 0, maxGapMs: 0, typing: true }),
      },
      actions: (action) => messengerActions(action, deps.messaging, { serviceName: 'FakeChat' }),
    }),
  );
}

/** Records what the gateway asked the fake messenger to do. */
export interface FakeLog {
  connects: number;
  sent: OutboundJob[];
  typed: number[];
}

export function createFakeLog(): FakeLog {
  return { connects: 0, sent: [], typed: [] };
}

/** A connection that stays up until stopped or until the test ends it with an error. */
export function fakeLive(log: FakeLog) {
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  closed.catch(() => {});
  let counter = 0;
  const live: LiveSession & { drop(error: SessionError): void } = {
    identity: '+10000000000',
    idempotentSend: true,
    closed,
    async send(job: OutboundJob): Promise<SentReceipt | undefined> {
      log.sent.push(job);
      if (job.kind === 'mark_read') return undefined;
      counter++;
      return { externalId: `out-${job.id}-${counter}`, sentAt: new Date() };
    },
    async resolveRecipient(to: string) {
      return { externalId: `chat-${to}`, kind: 'direct' as const, title: to };
    },
    async typing(_chat: string, durationMs: number) {
      log.typed.push(durationMs);
    },
    async stop() {
      resolveClosed();
    },
    drop(error: SessionError) {
      rejectClosed(error);
    },
  };
  return live;
}

export type FakeLiveSession = ReturnType<typeof fakeLive>;

/** Scriptable driver: connects with saved state; logs in with a QR code and then a code. */
export function fakeDriver(log: FakeLog) {
  const failures: SessionError[] = [];
  const lives = new Map<string, FakeLiveSession>();
  /** The last session handed to the driver per account (to test writes after a lost lease). */
  const sessions = new Map<string, DriverSession>();
  const connect = async (ds: DriverSession): Promise<LiveSession> => {
    log.connects++;
    sessions.set(ds.account.id, ds);
    const failure = failures.shift();
    if (failure) throw failure;
    const saved = await ds.state.get<{ device: string }>('device');
    if (!saved) throw new SessionError('logged_out', 'no saved device');
    const live = fakeLive(log);
    lives.set(ds.account.id, live);
    return live;
  };
  const login = (ds: DriverSession) => {
    sessions.set(ds.account.id, ds);
    return fakeLogin(ds, lives, log);
  };
  return { connectorId: 'fakechat', failures, lives, sessions, connect, login };
}

/** QR first, then a code; `12345` is the right one. Saving the device makes later connects work. */
function fakeLogin(ds: DriverSession, lives: Map<string, FakeLiveSession>, log: FakeLog): Promise<LoginFlow> {
  let step: 'scan_qr' | 'enter_code' | 'failed' = 'scan_qr';
  let error: string | undefined;
  let resolveDone!: (live: LiveSession) => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<LiveSession>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const flow: LoginFlow = {
    view: () => ({ step, ...(step === 'scan_qr' ? { qr: 'fake-qr' } : {}), ...(error ? { error } : {}) }),
    async submit(input) {
      if (step === 'scan_qr') {
        step = 'enter_code';
        return;
      }
      if (input.code !== '12345') {
        error = 'wrong code';
        return;
      }
      await ds.state.set('device', { device: 'fake-device' });
      const live = fakeLive(log);
      lives.set(ds.account.id, live);
      resolveDone(live);
    },
    async cancel() {
      step = 'failed';
      rejectDone(new Error('cancelled'));
    },
    done,
  };
  return Promise.resolve(flow);
}
