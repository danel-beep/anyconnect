import { describe, expect, it, vi } from 'vitest';
import { ConnectorError } from '../src/connectors/sdk.js';
import type { AccountRow } from '../src/core/accounts.js';
import { TriggerEngine } from '../src/triggers/engine.js';
import type { EventSource } from '../src/triggers/sources.js';
import type { Trigger } from '../src/triggers/store.js';

/**
 * A source that cannot be read: the service's own failure (Gmail answering 500, an expired sign-in)
 * is a warning and the account is read again later; only the hub's own failures become error groups.
 */
describe('trigger source read failures', () => {
  const account = { id: 'acc_1', connectorId: 'gmail', enabled: true, workspaceId: 'ws_1' } as AccountRow;
  const trigger = {
    id: 'trg_1',
    workspaceId: 'ws_1',
    source: 'mail',
    connectorId: null,
    accountIds: [],
    spec: { filter: {} },
  } as unknown as Trigger;

  const engineFailingWith = (error: unknown) => {
    const source = {
      source: 'mail',
      accounts: async () => [account],
      recent: async () => {
        throw error;
      },
    } as unknown as EventSource;
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const onError = vi.fn();
    const engine = new TriggerEngine({ sources: [source], logger, onError } as never);
    return { engine, logger, onError };
  };
  const tryIt = (engine: TriggerEngine) =>
    engine.test(trigger, { run: false, force: false, signal: AbortSignal.timeout(5000) });

  it('logs a service failure as a warning, not an error group', async () => {
    const { engine, logger, onError } = engineFailingWith(
      new ConnectorError('upstream', 'Internal error encountered.'),
    );
    expect(await tryIt(engine)).toEqual({ looked: 0, matched: false, ran: false });
    expect(onError).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'test', service: 'gmail', kind: 'upstream' }),
      expect.stringContaining('retried on the next pass'),
    );
  });

  it('reports the hub’s own failure to error tracking', async () => {
    const { engine, onError } = engineFailingWith(new TypeError('cannot read properties of undefined'));
    await tryIt(engine);
    expect(onError).toHaveBeenCalledWith(
      expect.any(TypeError),
      expect.objectContaining({ source: 'trigger', step: 'test', service: 'gmail' }),
    );
  });
});
