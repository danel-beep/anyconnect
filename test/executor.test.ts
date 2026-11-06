import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import {
  type ActionDefinition,
  actionIdempotent,
  actionRisk,
  type ConnectorDefinition,
  defineConnector,
} from '../src/connectors/sdk.js';
import { buildCatalog } from '../src/hub/catalog.js';
import { type CallContext, Executor, type Middleware, STAGE_ORDER } from '../src/hub/executor.js';
import { MemoryIdempotencyStore } from '../src/hub/idempotency.js';
import { dataResult, type ExecResult, errorResult } from '../src/hub/result.js';
import { automationStage } from '../src/hub/stages/automation.js';
import { circuitStage } from '../src/hub/stages/circuit.js';
import { idempotencyStage } from '../src/hub/stages/idempotency.js';
import { limitsStage } from '../src/hub/stages/limits.js';
import { riskStage } from '../src/hub/stages/risk.js';
import { shapeStage } from '../src/hub/stages/shape.js';
import { CircuitBreaker } from '../src/lib/circuit-breaker.js';
import { RateLimiter } from '../src/lib/rate-limit.js';

const svc = defineConnector({
  id: 'svc',
  name: 'Svc',
  description: 'Test service',
  version: '1',
  rateLimit: { requests: 2, perSeconds: 1 },
  actions: (action) => [
    action({
      name: 'read',
      description: 'Read',
      input: z.object({}),
      hints: { readOnly: true },
      run: () => 'ok',
    }),
    action({
      name: 'send',
      description: 'Send',
      input: z.object({ to: z.string() }),
      risk: 'write',
      undo: { kind: 'action', action: 'unsend' },
      assessRisk: ({ to }) =>
        to.startsWith('new') ? { risk: 'dangerous', reason: 'New recipient' } : undefined,
      run: () => ({ id: 'm1' }),
    }),
    action({ name: 'unsend', description: 'Unsend', input: z.object({ id: z.string() }), run: () => 'ok' }),
    action({
      name: 'wipe',
      description: 'Wipe',
      input: z.object({}),
      hints: { destructive: true },
      run: () => 'ok',
    }),
  ],
});

function call(
  actionName: string,
  input: Record<string, unknown> = {},
  extra: Partial<CallContext> = {},
): CallContext {
  const action = svc.actions.find((a) => a.name === actionName)!;
  const catalog = buildCatalog({ connectors: [svc], accounts: [] });
  const now = Date.now();
  return {
    principal: { kind: 'api_token', userId: 'u', workspaceId: 'w', scopes: [] },
    catalog,
    tool: { ...catalog.tools[0]!, name: `svc_${actionName}` },
    connector: svc,
    action,
    scope: 'account',
    account: { id: 'acc_1', name: 'main', label: 'Main', description: null, identity: null },
    accountRow: {} as never,
    input,
    options: {},
    risk: actionRisk(action),
    meta: { idempotent: actionIdempotent(action), capabilities: [] },
    context: async () => ({}) as never,
    signal: new AbortController().signal,
    deadline: now + 30_000,
    startedAt: now,
    audit: {},
    locals: {},
    ...extra,
  };
}

describe('action metadata', () => {
  it('derives risk and idempotency from hints when not declared', () => {
    const find = (name: string) => svc.actions.find((a) => a.name === name)!;
    expect(actionRisk(find('read'))).toBe('read');
    expect(actionRisk(find('send'))).toBe('write');
    expect(actionRisk(find('unsend'))).toBe('write');
    expect(actionRisk(find('wipe'))).toBe('dangerous');
    expect(actionIdempotent(find('read'))).toBe(true);
    expect(actionIdempotent(find('send'))).toBe(false);
  });

  it('validates undo, capabilities, limits and reserved inputs', () => {
    const make = (patch: Partial<ActionDefinition>, connector: Partial<ConnectorDefinition> = {}) => ({
      ...defineConnector({
        id: 'chk',
        name: 'Chk',
        description: 'x',
        version: '1',
        actions: (action) => [action({ name: 'a', description: 'x', input: z.object({}), run: () => 'ok' })],
      }),
      ...connector,
      actions: [{ name: 'a', description: 'x', input: z.object({}), run: () => 'ok', ...patch }],
    });
    const register = (c: ConnectorDefinition) => new ConnectorRegistry().register(c);
    expect(() => register(make({ undo: { kind: 'action', action: 'nope' } }))).toThrow(/unknown undo action/);
    expect(() => register(make({ undo: { kind: 'delay', seconds: 0 } }))).toThrow(/undo delay/);
    expect(() => register(make({ capability: 'nope.search' as never }))).toThrow(/unknown capability/);
    // A write action cannot implement a read capability (and the other way round).
    expect(() => register(make({ capability: 'mail.search' }))).toThrow(/risk "write"/);
    expect(() => register(make({ capability: 'mail.send', hints: { readOnly: true } }))).toThrow(
      /write-only/,
    );
    expect(() => register(make({ input: z.object({ fields: z.string() }) }))).toThrow(/"fields"/);
    expect(() => register(make({ rateLimit: { requests: 0, perSeconds: 1 } }))).toThrow(/rate limit/);
    expect(() => register({ ...make({}), id: 'mail' })).toThrow(/reserved/);
    expect(() => register(make({ capability: 'mail.search', hints: { readOnly: true } }))).not.toThrow();
  });

  it('maps risk to conservative MCP annotations', () => {
    const catalog = buildCatalog({
      connectors: [svc],
      accounts: [
        {
          id: 'acc_1',
          workspaceId: 'w',
          connectorId: 'svc',
          name: 'main',
          label: 'Main',
          description: null,
          config: {},
          dataKeyEncrypted: null,
          credentialsEncrypted: null,
          enabled: true,
          status: 'active',
          statusMessage: null,
          settings: {},
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          lastUsedAt: null,
          ownerUserId: null,
          checkedAt: null,
          reauthNotifiedAt: null,
        },
      ],
    });
    const byName = (n: string) => catalog.tools.find((t) => t.name === n)!;
    expect(byName('svc_send').annotations).toMatchObject({ destructiveHint: false, idempotentHint: false });
    expect(byName('svc_send').risk).toBe('write');
    expect(byName('svc_unsend').annotations.destructiveHint).toBe(true); // undeclared: assume the worst
    expect(byName('svc_wipe').risk).toBe('dangerous');
    expect(byName('svc_read').annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  });
});

describe('executor', () => {
  it('runs stages in the documented order and can skip them', async () => {
    const seen: string[] = [];
    const stages = Object.fromEntries(
      STAGE_ORDER.map((name) => [
        name,
        (async (_call, next) => {
          seen.push(name);
          return next();
        }) satisfies Middleware,
      ]),
    );
    const executor = new Executor(stages, async () => {
      seen.push('invoke');
      return dataResult('ok');
    });
    await executor.execute(call('read'));
    expect(seen).toEqual([...STAGE_ORDER, 'invoke']);
    seen.length = 0;
    await executor.execute(call('read'), { skip: ['confirm', 'policy'] });
    expect(seen).not.toContain('confirm');
    expect(seen).not.toContain('policy');
    expect(seen).toContain('invoke');
  });

  it('lets a stage short-circuit the chain', async () => {
    let invoked = false;
    const executor = new Executor(
      {
        policy: async (c) => {
          c.audit.outcome = 'denied';
          return errorResult('Not allowed', 'permission');
        },
      },
      async () => {
        invoked = true;
        return dataResult('ok');
      },
    );
    const unit = call('send', { to: 'bob' });
    const result = await executor.execute(unit);
    expect(result.isError).toBe(true);
    expect(invoked).toBe(false);
    expect(unit.audit.outcome).toBe('denied');
  });
});

describe('risk stage', () => {
  it('raises the risk of a particular call but never lowers it', async () => {
    const executor = new Executor({ risk: riskStage }, async () => dataResult('ok'));
    const risky = call('send', { to: 'new-person' });
    await executor.execute(risky);
    expect(risky.risk).toBe('dangerous');
    expect(risky.locals.riskReason).toBe('New recipient');
    const known = call('send', { to: 'bob' });
    await executor.execute(known);
    expect(known.risk).toBe('write');
  });
});

describe('automation stage', () => {
  const automation = (tools: string[], confirmRisky = true) => ({
    principal: {
      kind: 'automation' as const,
      userId: 'u',
      workspaceId: 'w',
      scopes: [],
      credentialId: 'trg_1',
      automation: { triggerId: 'trg_1', eventId: 'tev_1', tools, confirmRisky },
    },
  });

  it('lets a trigger call only the tools its rule lists, and never the setup tools', async () => {
    const executor = new Executor({ automation: automationStage }, async () => dataResult('ok'));
    const allowed = call('read', {}, automation(['svc_read']));
    expect((await executor.execute(allowed)).isError).toBeFalsy();
    const other = call('send', { to: 'bob' }, automation(['svc_read']));
    expect((await executor.execute(other)).isError).toBe(true);
    expect(other.audit.outcome).toBe('denied');
    const setup = call('read', {}, { ...automation(['svc_read']), scope: 'workspace' });
    expect((await executor.execute(setup)).isError).toBe(true);
  });

  it('makes risky calls wait for the user while the rule says so', async () => {
    const executor = new Executor({ risk: riskStage, automation: automationStage }, async () =>
      dataResult('ok'),
    );
    const asks = call('send', { to: 'new-person' }, automation(['svc_send']));
    await executor.execute(asks);
    expect(asks.mustConfirm).toBe(true);
    const trusted = call('send', { to: 'new-person' }, automation(['svc_send'], false));
    await executor.execute(trusted);
    expect(trusted.mustConfirm).toBeFalsy();
  });
});

describe('limits stage', () => {
  it('waits briefly for a free slot, then reports the limit', async () => {
    const limiter = new RateLimiter();
    let calls = 0;
    const executor = new Executor(
      { limits: limitsStage({ rateLimiter: limiter, maxWaitMs: 0 }) },
      async () => {
        calls++;
        return dataResult('ok');
      },
    );
    await executor.execute(call('read'));
    await executor.execute(call('read'));
    const third = call('read');
    const limited = await executor.execute(third);
    expect(limited.isError).toBe(true);
    expect(limited.error?.kind).toBe('rate_limited');
    expect(third.audit.outcome).toBe('rate_limited');
    expect(calls).toBe(2);

    const patient = new Executor(
      { limits: limitsStage({ rateLimiter: limiter, maxWaitMs: 2_000 }) },
      async () => dataResult('ok'),
    );
    const waited = await patient.execute(call('read'));
    expect(waited.isError).toBeFalsy();
    limiter.close();
  });

  it('retries transient failures only for idempotent actions', async () => {
    const limiter = new RateLimiter();
    const attempts: Record<string, number> = {};
    const executor = new Executor(
      { limits: limitsStage({ rateLimiter: limiter, backoffMs: 5 }) },
      async (c) => {
        attempts[c.action.name] = (attempts[c.action.name] ?? 0) + 1;
        return attempts[c.action.name]! < 3
          ? errorResult('Service unavailable', 'upstream')
          : dataResult('ok');
      },
    );
    const read = call('read');
    expect((await executor.execute(read)).isError).toBeFalsy();
    expect(attempts.read).toBe(3);
    expect(read.audit.retries).toBe(2);
    expect((await executor.execute(call('send', { to: 'bob' }))).isError).toBe(true);
    expect(attempts.send).toBe(1);
    limiter.close();
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures, lets one trial through, backs off', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ threshold: 3, openMs: 1_000, maxOpenMs: 4_000, now: () => now });
    for (let i = 0; i < 3; i++) {
      expect(breaker.check('a').allowed).toBe(true);
      breaker.failure('a');
    }
    expect(breaker.check('a')).toEqual({ allowed: false, retryAfterSeconds: 1, failures: 3 });
    expect(breaker.check('b').allowed).toBe(true); // other keys are not affected

    now = 1_000;
    expect(breaker.check('a')).toEqual({ allowed: true, trial: true });
    // Only one trial at a time.
    expect(breaker.check('a').allowed).toBe(false);
    breaker.failure('a'); // the trial failed: open twice as long
    now = 2_500;
    expect(breaker.check('a').allowed).toBe(false);
    now = 3_000;
    expect(breaker.check('a')).toEqual({ allowed: true, trial: true });
    breaker.success('a');
    expect(breaker.check('a')).toEqual({ allowed: true, trial: false });
  });

  it('a released trial lets the next call try', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ threshold: 1, openMs: 1_000, now: () => now });
    breaker.failure('a');
    now = 1_000;
    expect(breaker.check('a').allowed).toBe(true);
    breaker.release('a');
    expect(breaker.check('a').allowed).toBe(true);
  });

  it('fails fast for one account while its service keeps failing', async () => {
    const breaker = new CircuitBreaker({ threshold: 2, openMs: 60_000 });
    let calls = 0;
    let answer: ExecResult = errorResult('Service unavailable', 'upstream');
    const executor = new Executor({ circuit: circuitStage(breaker) }, async () => {
      calls++;
      return answer;
    });
    await executor.execute(call('read'));
    await executor.execute(call('read'));
    const blocked = call('read');
    const result = await executor.execute(blocked);
    expect(calls).toBe(2);
    expect(result.error).toEqual({ kind: 'upstream', retryAfterSeconds: 60 });
    expect(blocked.audit.outcome).toBe('circuit_open');
    expect(JSON.stringify(result.content)).toContain('Svc is not responding for account \\"main\\"');

    // Another account of the same service still goes through.
    const other = call(
      'read',
      {},
      { account: { id: 'acc_2', name: 'b', label: 'B', description: null, identity: null } },
    );
    answer = dataResult('ok');
    expect((await executor.execute(other)).isError).toBeFalsy();
    expect(calls).toBe(3);
  });

  it('counts only service-side failures of calls that reached the service', async () => {
    const breaker = new CircuitBreaker({ threshold: 2 });
    const answers: ExecResult[] = [
      errorResult('Service unavailable', 'upstream'),
      errorResult('No such message', 'not_found'), // the service answered: it is up
      errorResult('Service unavailable', 'upstream'),
    ];
    const executor = new Executor({ circuit: circuitStage(breaker) }, async () => answers.shift()!);
    for (let i = 0; i < 3; i++) await executor.execute(call('read'));
    expect(breaker.check('acct:acc_1').allowed).toBe(true);

    // A stage after it that refuses the call does not count either way.
    const refusing = new Executor(
      { circuit: circuitStage(breaker), idempotency: async () => errorResult('Duplicate', 'hub') },
      async () => dataResult('never'),
    );
    await refusing.execute(call('read'));
    expect(breaker.check('acct:acc_1').allowed).toBe(true);
  });

  it('judges each retry of the limits stage on its own', async () => {
    const limiter = new RateLimiter();
    const breaker = new CircuitBreaker({ threshold: 2, openMs: 60_000 });
    let calls = 0;
    const executor = new Executor(
      { limits: limitsStage({ rateLimiter: limiter, backoffMs: 1 }), circuit: circuitStage(breaker) },
      async () => {
        calls++;
        return errorResult('Service unavailable', 'upstream');
      },
    );
    const first = call('read');
    const result = await executor.execute(first);
    // Two real attempts open the circuit; the third (a retry) is stopped without calling.
    expect(calls).toBe(2);
    expect(first.audit.outcome).toBe('circuit_open');
    expect(result.isError).toBe(true);
    limiter.close();
  });
});

describe('idempotency stage', () => {
  const setup = () => {
    let runs = 0;
    let fail = false;
    const executor = new Executor(
      { idempotency: idempotencyStage({ store: new MemoryIdempotencyStore(), windowMs: 60_000 }) },
      async (): Promise<ExecResult> => {
        runs++;
        await new Promise((r) => setTimeout(r, 20));
        return fail ? errorResult('boom', 'upstream') : dataResult({ id: `m${runs}` });
      },
    );
    return {
      executor,
      runs: () => runs,
      setFail: (v: boolean) => {
        fail = v;
      },
    };
  };

  it('does not repeat an identical write and says so', async () => {
    const { executor, runs } = setup();
    await executor.execute(call('send', { to: 'bob' }));
    const again = call('send', { to: 'bob' });
    const result = await executor.execute(again);
    expect(runs()).toBe(1);
    expect(again.audit.outcome).toBe('deduplicated');
    expect(JSON.stringify(result.content)).toContain('Not repeated');
    expect(JSON.stringify(result.content)).toContain('m1');
    // A different input is a different call.
    await executor.execute(call('send', { to: 'alice' }));
    expect(runs()).toBe(2);
  });

  it('joins identical concurrent writes and lets failed ones be retried', async () => {
    const { executor, runs, setFail } = setup();
    await Promise.all([
      executor.execute(call('send', { to: 'x' })),
      executor.execute(call('send', { to: 'x' })),
    ]);
    expect(runs()).toBe(1);
    setFail(true);
    await executor.execute(call('send', { to: 'y' }));
    setFail(false);
    const retried = await executor.execute(call('send', { to: 'y' }));
    expect(retried.isError).toBeFalsy();
    expect(runs()).toBe(3);
  });

  it('ignores reads', async () => {
    const { executor, runs } = setup();
    await executor.execute(call('read'));
    await executor.execute(call('read'));
    expect(runs()).toBe(2);
  });
});

describe('shape stage', () => {
  it('applies declared fields and the budget, and leaves errors alone', async () => {
    const executor = new Executor({ shape: shapeStage({ maxResultTokens: 2000 }) }, async (c) =>
      c.action.name === 'read' ? dataResult([{ id: '1', a: 1, b: null, c: 'x' }]) : errorResult('nope'),
    );
    const read = call('read', {}, { options: { fields: ['a'] } });
    const result = await executor.execute(read);
    expect(result.content[0]).toEqual({ type: 'text', text: '[{"id":"1","a":1}]' });
    expect((await executor.execute(call('send', { to: 'b' }))).content[0]).toEqual({
      type: 'text',
      text: 'nope',
    });
  });
});
