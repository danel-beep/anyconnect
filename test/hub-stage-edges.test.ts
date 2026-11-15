import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { actionIdempotent, actionRisk, defineConnector } from '../src/connectors/sdk.js';
import type { Principal } from '../src/core/principal.js';
import { buildCatalog } from '../src/hub/catalog.js';
import { type CallContext, unitKey, unitLabel } from '../src/hub/executor.js';
import { MemoryIdempotencyStore } from '../src/hub/idempotency.js';
import { dataResult, type ExecResult, errorResult } from '../src/hub/result.js';
import { automationStage, outsideLimits } from '../src/hub/stages/automation.js';
import { confirmFloorStage } from '../src/hub/stages/confirm-floor.js';
import { idempotencyStage, stableStringify } from '../src/hub/stages/idempotency.js';
import { defaultStages } from '../src/hub/stages/index.js';
import { limitsStage } from '../src/hub/stages/limits.js';
import { meterStage } from '../src/hub/stages/meter.js';
import { riskStage } from '../src/hub/stages/risk.js';
import type { UsageMeter } from '../src/hub/usage.js';
import { CircuitBreaker } from '../src/lib/circuit-breaker.js';
import { RateLimiter } from '../src/lib/rate-limit.js';

/**
 * Stage branches that executor.test.ts does not reach: the confirmation floor, risk checks that
 * fail, trigger scopes on workspace tools and accounts, retries cut short, metering failures.
 */

const svc = defineConnector({
  id: 'svc',
  name: 'Svc',
  description: 'Test service',
  version: '1',
  actions: (action) => [
    action({
      name: 'read',
      description: 'Read',
      input: z.object({}),
      hints: { readOnly: true },
      run: () => 'ok',
    }),
    action({
      name: 'post',
      description: 'Post',
      input: z.object({ to: z.string() }),
      risk: 'write',
      rateLimit: { requests: 1, perSeconds: 60 },
      run: () => 'ok',
    }),
    action({
      name: 'pay',
      description: 'Pay',
      input: z.object({}),
      risk: 'write',
      requiresConfirmation: true,
      run: () => 'ok',
    }),
    action({
      name: 'flaky_check',
      description: 'Risk check throws',
      input: z.object({}),
      risk: 'read',
      assessRisk: () => {
        throw new Error('lookup failed');
      },
      run: () => 'ok',
    }),
    action({
      name: 'confirm_check',
      description: 'Risk check asks to confirm without raising the risk',
      input: z.object({}),
      risk: 'write',
      assessRisk: () => ({ risk: 'read', reason: 'Large amount', confirm: true }),
      run: () => 'ok',
    }),
  ],
});

const principal: Principal = { kind: 'api_token', userId: 'u', workspaceId: 'w', scopes: [] };

function call(actionName: string, extra: Partial<CallContext> = {}): CallContext {
  const action = svc.actions.find((a) => a.name === actionName)!;
  const catalog = buildCatalog({ connectors: [svc], accounts: [] });
  const now = Date.now();
  return {
    principal,
    catalog,
    tool: { ...catalog.tools[0]!, name: `svc_${actionName}` },
    connector: svc,
    action,
    scope: 'account',
    account: { id: 'acc_1', name: 'main', label: 'Main', description: null, identity: null },
    accountRow: {} as never,
    input: {},
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

const ok = async (): Promise<ExecResult> => dataResult({ ok: true });

describe('unit keys and labels', () => {
  it('names an account or the workspace', () => {
    expect(unitKey(call('read'))).toBe('acc_1');
    expect(unitLabel(call('read'))).toBe('account "main"');
    const workspace = call('read', { scope: 'workspace', account: undefined });
    expect(unitKey(workspace)).toBe('workspace:w');
    expect(unitLabel(workspace)).toBe('this workspace');
  });
});

describe('confirmation floor (hub without the security layer)', () => {
  it('refuses actions that always need confirmation, and calls the risk check flagged', async () => {
    const next = vi.fn(ok);
    const pay = call('pay');
    const refused = await confirmFloorStage(pay, next);
    expect(refused).toMatchObject({ isError: true, error: { kind: 'permission' } });
    expect(pay.audit.outcome).toBe('declined');
    const flagged = call('post', { mustConfirm: true });
    expect((await confirmFloorStage(flagged, next)).isError).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets pre-approved and ordinary calls through', async () => {
    const next = vi.fn(ok);
    expect((await confirmFloorStage(call('pay', { preApproved: true }), next)).isError).toBeFalsy();
    expect((await confirmFloorStage(call('post'), next)).isError).toBeFalsy();
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('risk stage edges', () => {
  it('treats a failing risk check as dangerous', async () => {
    const unit = call('flaky_check');
    await riskStage(unit, ok);
    expect(unit.risk).toBe('dangerous');
    expect(unit.audit.riskReason).toBe('The risk check of this action failed');
  });

  it('asks for confirmation when the check says so, without lowering the risk', async () => {
    const unit = call('confirm_check');
    await riskStage(unit, ok);
    expect(unit).toMatchObject({ risk: 'write', mustConfirm: true, locals: { riskReason: 'Large amount' } });
  });
});

describe('automation stage edges', () => {
  type Scope = Omit<NonNullable<Principal['automation']>, 'triggerId' | 'eventId'>;
  const automation = (scope?: Scope): Principal => ({
    ...principal,
    kind: 'automation',
    ...(scope ? { automation: { triggerId: 'trg_1', eventId: 'tev_1', ...scope } } : {}),
  });

  it('keeps triggers away from the hub settings and from a missing scope', async () => {
    const next = vi.fn(ok);
    const setup = call('read', {
      scope: 'workspace',
      account: undefined,
      principal: automation({ tools: ['svc_read'], confirmRisky: true }),
    });
    expect(await automationStage(setup, next)).toMatchObject({ isError: true });
    expect(setup.audit.outcome).toBe('denied');
    expect((await automationStage(call('read', { principal: automation() }), next)).isError).toBe(true);
    const none = await automationStage(
      call('read', { principal: automation({ tools: [], confirmRisky: true }) }),
      next,
    );
    expect(none.content[0]).toMatchObject({ text: expect.stringContaining('It may use: no tools.') });
    expect(next).not.toHaveBeenCalled();
  });

  it('marks a rule that acts without asking as approved', async () => {
    const unit = call('post', { principal: automation({ tools: ['svc_post'], confirmRisky: false }) });
    await automationStage(unit, ok);
    expect(unit.ruleApproved).toBe(true);
    expect(unit.mustConfirm).toBeUndefined();
  });

  it('limits arguments and accounts, refusing values it cannot read', () => {
    const unit = call('post');
    expect(outsideLimits(undefined, unit)).toBeUndefined();
    expect(outsideLimits({ account: ['svc:main'] }, unit)).toBeUndefined();
    expect(outsideLimits({ account: ['other'] }, unit)).toEqual({ argument: 'account', allowed: ['other'] });
    expect(outsideLimits({ account: ['main'] }, { ...unit, account: undefined })).toBeDefined();
    expect(outsideLimits({ to: ['a'] }, { ...unit, input: { to: { nested: 'a' } } })).toBeDefined();
    expect(outsideLimits({ to: ['a'] }, { ...unit, input: { to: null } })).toBeDefined();
    expect(outsideLimits({ to: ['1', '2'] }, { ...unit, input: { to: [1, '2'] } })).toBeUndefined();
  });
});

describe('idempotency stage edges', () => {
  it('is off with a zero window', async () => {
    const next = vi.fn(ok);
    const stage = idempotencyStage({ store: new MemoryIdempotencyStore(), windowMs: 0 });
    await stage(call('post', { input: { to: 'a' } }), next);
    await stage(call('post', { input: { to: 'a' } }), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('frees the key when the call throws, so a retry runs', async () => {
    const stage = idempotencyStage({ store: new MemoryIdempotencyStore(), windowMs: 60_000 });
    await expect(
      stage(call('post', { input: { to: 'a' } }), async () => {
        throw new Error('crash');
      }),
    ).rejects.toThrow('crash');
    const next = vi.fn(ok);
    await stage(call('post', { input: { to: 'a' } }), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes a failed concurrent twin’s error through as is', async () => {
    const stage = idempotencyStage({ store: new MemoryIdempotencyStore(), windowMs: 60_000 });
    let fail!: (r: ExecResult) => void;
    const first = stage(call('post', { input: { to: 'b' } }), () => new Promise((r) => (fail = r)));
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
    const second = stage(call('post', { input: { to: 'b' } }), ok);
    await new Promise((r) => setImmediate(r));
    fail(errorResult('Service down', 'upstream'));
    expect((await first).isError).toBe(true);
    const twin = await second;
    expect(twin.isError).toBe(true);
    expect(JSON.stringify(twin.content)).not.toContain('Not repeated');
  });

  it('serializes values stably', () => {
    expect(stableStringify({ b: 1, a: [undefined, { d: undefined, c: 2 }] })).toBe(
      '{"a":[null,{"c":2}],"b":1}',
    );
    expect(stableStringify(undefined)).toBe('null');
  });
});

describe('limits stage edges', () => {
  it('applies the action’s own limit and reports it with a retry time', async () => {
    const stage = limitsStage({ rateLimiter: new RateLimiter(), maxWaitMs: 10 });
    expect((await stage(call('post'), ok)).isError).toBeFalsy();
    const unit = call('post');
    const denied = await stage(unit, ok);
    expect(denied).toMatchObject({ isError: true, error: { kind: 'rate_limited', retryAfterSeconds: 60 } });
    expect(unit.audit.outcome).toBe('rate_limited');
  });

  it('does not wait past the call’s deadline', async () => {
    const limiter = new RateLimiter();
    const stage = limitsStage({ rateLimiter: limiter, maxWaitMs: 120_000 });
    await stage(call('post'), ok);
    const started = Date.now();
    const denied = await stage(call('post', { deadline: Date.now() + 50 }), ok);
    expect(denied.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops retrying when the provider asks to wait too long or the call is cancelled', async () => {
    const stage = limitsStage({ rateLimiter: new RateLimiter(), maxWaitMs: 1_000, backoffMs: 1 });
    const slow = vi.fn(async () => errorResult('Slow down', 'rate_limited', 30));
    await stage(call('read'), slow);
    expect(slow).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const flaky = vi.fn(async () => {
      controller.abort();
      return errorResult('Down', 'upstream');
    });
    await stage(call('read', { signal: controller.signal }), flaky);
    expect(flaky).toHaveBeenCalledOnce();

    const recovering = vi
      .fn<() => Promise<ExecResult>>()
      .mockResolvedValueOnce(errorResult('Down', 'upstream'))
      .mockResolvedValueOnce(dataResult('fine'));
    const unit = call('read');
    expect((await stage(unit, recovering)).isError).toBeFalsy();
    expect(unit.audit.retries).toBe(1);
  });
});

describe('meter stage edges', () => {
  const meter = (record: UsageMeter['record']) => ({ record }) as unknown as UsageMeter;
  const logger = { warn: vi.fn() } as never;

  it('charges the payer, skips free and refused units, and survives a failing meter', async () => {
    const recorded: unknown[] = [];
    const stage = meterStage({
      meter: meter(async (e) => void recorded.push(e)),
      logger,
      payer: async () => 'payer_ws',
    });
    const invoked = call('read');
    await stage(invoked, async () => {
      invoked.invoked = true;
      return errorResult('x', 'upstream');
    });
    expect(recorded).toEqual([
      expect.objectContaining({ payerId: 'payer_ws', failed: true, action: 'read' }),
    ]);
    const free = call('read', { free: true });
    await stage(free, async () => {
      free.invoked = true;
      return dataResult(1);
    });
    await stage(call('read'), ok);
    expect(recorded).toHaveLength(1);

    const warn = vi.fn();
    const broken = meterStage({
      meter: meter(async () => {
        throw new Error('db down');
      }),
      logger: { warn } as never,
    });
    const unit = call('read');
    const result = await broken(unit, async () => {
      unit.invoked = true;
      return dataResult(1);
    });
    expect(result.isError).toBeFalsy();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('defaultStages', () => {
  const base = {
    db: {} as never,
    logger: { warn: vi.fn() } as never,
    rateLimiter: new RateLimiter(),
    idempotency: new MemoryIdempotencyStore(),
    idempotencyWindowMs: 1000,
    maxResultTokens: 1000,
  };

  it('fills only the slots whose dependencies are given', () => {
    expect(Object.keys(defaultStages(base)).sort()).toEqual(
      ['audit', 'automation', 'confirm', 'idempotency', 'limits', 'risk', 'shape'].sort(),
    );
    const full = defaultStages({
      ...base,
      meter: { record: async () => {} } as unknown as UsageMeter,
      quota: { checkAction: async () => ({ allowed: true }) as never, payerOf: async () => 'p' },
      circuitBreaker: new CircuitBreaker(),
      openWorld: async () => false,
      setIdentity: async () => {},
    });
    expect(Object.keys(full)).toEqual(
      expect.arrayContaining(['meter', 'quota', 'exposure', 'circuit', 'identity']),
    );
  });

  it('meters against the quota’s payer', async () => {
    const recorded: Array<{ payerId: string }> = [];
    const stages = defaultStages({
      ...base,
      meter: { record: async (e: { payerId: string }) => void recorded.push(e) } as unknown as UsageMeter,
      quota: { checkAction: async () => ({ allowed: true }) as never, payerOf: async () => 'team_payer' },
    });
    const unit = call('read');
    await stages.meter!(unit, async () => {
      unit.invoked = true;
      return dataResult(1);
    });
    expect(recorded[0]!.payerId).toBe('team_payer');
  });
});
