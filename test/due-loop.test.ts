import { describe, expect, it, vi } from 'vitest';
import { DueLoop } from '../src/lib/due-loop.js';
import { createLogger } from '../src/logger.js';
import type { PendingCallRow, PendingCallService } from '../src/security/pending-calls.js';
import { PendingCallRunner } from '../src/security/runner.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('DueLoop', () => {
  it('runs at start, then only when kicked, due or idle for too long', async () => {
    const runs: number[] = [];
    const loop = new DueLoop({
      work: async () => {
        runs.push(Date.now());
        return undefined;
      },
      idleMs: () => 10_000,
      onError: () => {},
    });
    loop.start();
    await loop.idle();
    await sleep(50);
    expect(runs).toHaveLength(1); // idle: no polling
    loop.kick();
    await loop.idle();
    expect(runs).toHaveLength(2);
    await loop.stop();
  });

  it('wakes when the next due time it reported arrives', async () => {
    let calls = 0;
    const loop = new DueLoop({
      work: async () => {
        calls++;
        return calls === 1 ? new Date(Date.now() + 60) : undefined;
      },
      idleMs: () => 10_000,
      onError: () => {},
    });
    loop.start();
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 1000, interval: 10 });
    await loop.stop();
  });

  it('wakes earlier for work due before its next run, not later', async () => {
    let calls = 0;
    const loop = new DueLoop({
      work: async () => {
        calls++;
        return undefined;
      },
      idleMs: () => 10_000,
      onError: () => {},
    });
    loop.start();
    await loop.idle();
    loop.wakeAt(new Date(Date.now() + 40));
    loop.wakeAt(new Date(Date.now() + 5_000)); // later than the timer already set: ignored
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 1000, interval: 10 });
    await loop.stop();
  });

  it('keeps a wake-up asked for during a run for later, instead of running again at once', async () => {
    const runs: number[] = [];
    const loop: DueLoop = new DueLoop({
      work: async () => {
        runs.push(Date.now());
        if (runs.length === 1) loop.wakeAt(new Date(Date.now() + 300));
        await sleep(20);
        return undefined;
      },
      idleMs: () => 10_000,
      onError: () => {},
    });
    loop.start();
    await sleep(150);
    expect(runs).toHaveLength(1);
    await vi.waitFor(() => expect(runs).toHaveLength(2), { timeout: 2_000, interval: 10 });
    expect(runs[1]! - runs[0]!).toBeGreaterThanOrEqual(290);
    await loop.stop();
  });

  it('does not spin on a due time that is already past (work another process holds)', async () => {
    let calls = 0;
    const loop = new DueLoop({
      work: async () => {
        calls++;
        return new Date(0);
      },
      idleMs: () => 10_000,
      onError: () => {},
      minGapMs: 50,
    });
    loop.start();
    await sleep(275);
    await loop.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(7);
  });

  it('never overlaps runs, and runs again after a kick that came during a run', async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const loop = new DueLoop({
      work: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(30);
        active--;
        return undefined;
      },
      idleMs: () => 10_000,
      onError: () => {},
    });
    loop.start();
    loop.kick();
    loop.kick();
    await sleep(10);
    await loop.idle();
    expect(maxActive).toBe(1);
    expect(calls).toBe(2);
    await loop.stop();
  });

  it('reports a failed run and keeps going', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const loop = new DueLoop({
      work: async () => {
        calls++;
        if (calls === 1) throw new Error('database down');
        return undefined;
      },
      idleMs: () => 20,
      onError: (error) => errors.push(error),
    });
    loop.start();
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 1000, interval: 10 });
    expect(errors).toHaveLength(1);
    await loop.stop();
    const after = calls;
    await sleep(60);
    expect(calls).toBe(after); // stopped: no more runs
  });
});

describe('PendingCallRunner', () => {
  /** A pending-call store with one call due at `dueAt`, and the hooks the runner uses. */
  function fakePending(dueAt: Date) {
    let listener: ((at: Date) => void) | undefined;
    const ran: string[] = [];
    let open = true;
    const row = { id: 'pcl_1' } as PendingCallRow;
    const pending = {
      onScheduled: (l: (at: Date) => void) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      nextDue: async () => (open ? dueAt : undefined),
      claimDue: async () => {
        if (!open || dueAt.getTime() > Date.now()) return [];
        open = false;
        return [row];
      },
      args: () => ({}),
      complete: async () => row,
      maintain: async () => {},
    } as unknown as PendingCallService;
    return { pending, ran, schedule: (at: Date) => listener?.(at) };
  }

  it('runs a call when its undo window ends, without polling in between', async () => {
    const dueAt = new Date(Date.now() + 80);
    const { pending, ran, schedule } = fakePending(dueAt);
    const runner = new PendingCallRunner({
      pending,
      center: { refresh: async () => {} } as never,
      run: async (row) => {
        ran.push(row.id);
        return { content: [] };
      },
      logger: createLogger({ level: 'silent' }),
      backstopMs: 60_000,
    });
    runner.start();
    schedule(dueAt);
    expect(ran).toEqual([]);
    await vi.waitFor(() => expect(ran).toEqual(['pcl_1']), { timeout: 1000, interval: 10 });
    await runner.stop();
  });
});
