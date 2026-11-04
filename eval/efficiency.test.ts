import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/hub/catalog.js';
import { searchTools } from '../src/hub/discovery.js';
import { toolListTokens } from '../src/hub/tokens.js';
import { resetDatabase } from '../test/helpers.js';
import { ACCOUNTS, CONNECTORS } from './fixtures.js';
import { type EvalHub, session, startEvalHub } from './harness.js';
import { SEARCH_CASES, TASKS } from './tasks.js';

/**
 * The stage-1 efficiency gate, run in CI:
 * - `tools/list` stays within ~3000 tokens however many services and accounts are connected;
 * - typical tasks are solvable in 1–3 calls;
 * - tool search finds the right tool for plain-language requests.
 * Any change to the hub that makes these numbers worse fails the build.
 */
const BUDGET = 3000;

function rows(services: string[]) {
  const now = new Date();
  return services.flatMap((connectorId) =>
    (ACCOUNTS[connectorId] ?? []).map(([name, label, identity]) => ({
      id: `acc_${connectorId}_${name}`,
      workspaceId: 'w',
      connectorId,
      name,
      label,
      description: null,
      config: {},
      credentialsEncrypted: null,
      dataKeyEncrypted: null,
      enabled: true,
      status: 'active' as const,
      statusMessage: null,
      settings: {},
      metadata: { identity },
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      checkedAt: null,
    })),
  );
}

describe('tool list budget', () => {
  const all = CONNECTORS.map((c) => c.id);
  const sizes = [1, 3, 6, 10, all.length];

  it.each(sizes)('stays within %i services → ≤ 3000 tokens', (n) => {
    const services = all.slice(0, n);
    const catalog = buildCatalog({ connectors: CONNECTORS, accounts: rows(services) });
    expect(catalog.stats.listedTokens).toBeLessThanOrEqual(BUDGET);
    expect(toolListTokens(catalog.listed)).toBe(catalog.stats.listedTokens);
  });

  it('switches to discovery only when listing everything would not fit', () => {
    const small = buildCatalog({ connectors: CONNECTORS, accounts: rows(['gmail', 'outlook']) });
    expect(small.listing).toBe('direct');
    const big = buildCatalog({ connectors: CONNECTORS, accounts: rows(all) });
    expect(big.listing).toBe('discovery');
    expect(big.stats.directTokens).toBeGreaterThan(BUDGET);
    // The unified tools stay listed: they cover most everyday tasks without a search.
    for (const name of [
      'mail_search',
      'messages_search',
      'messages_send',
      'calendar_list_events',
      'tasks_list',
    ]) {
      expect(big.listed.map((t) => t.name)).toContain(name);
    }
    console.info(
      `[eval] ${big.stats.totalTools} tools: direct listing ~${big.stats.directTokens} tokens, discovery ~${big.stats.listedTokens} tokens (${big.listed.length} listed)`,
    );
  });

  it('respects client tool-count limits', () => {
    const catalog = buildCatalog({
      connectors: CONNECTORS,
      accounts: rows(['gmail', 'outlook', 'telegram', 'whatsapp', 'slack', 'gcal']),
      client: { tokenBudget: 100_000, maxTools: 12 },
    });
    expect(catalog.listing).toBe('discovery');
    expect(catalog.listed.length).toBeLessThanOrEqual(12);
  });

  it('keeps the most used tools listed in discovery mode', () => {
    const catalog = buildCatalog({
      connectors: CONNECTORS,
      accounts: rows(all),
      usage: { stripe_list_charges: 40, github_list_notifications: 12 },
    });
    const names = catalog.listed.map((t) => t.name);
    expect(names).toContain('stripe_list_charges');
    expect(names).toContain('github_list_notifications');
    expect(catalog.stats.listedTokens).toBeLessThanOrEqual(BUDGET);
  });
});

describe('tool search', () => {
  const catalog = buildCatalog({ connectors: CONNECTORS, accounts: rows(CONNECTORS.map((c) => c.id)) });

  it.each(SEARCH_CASES)('"%s" → %s in the top 3', (query, tool) => {
    const top = searchTools(catalog.tools, query, { limit: 3 }).map((t) => t.name);
    const accepted = Array.isArray(tool) ? tool : [tool];
    expect(
      top.filter((t) => accepted.includes(t)),
      top.join(', '),
    ).not.toHaveLength(0);
  });
});

describe('tasks in 1–3 calls (real hub, scripted agent)', () => {
  let evalHub: EvalHub | undefined;

  beforeAll(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await evalHub?.close();
    evalHub = undefined;
  });

  for (const listing of ['auto', 'direct'] as const) {
    it.each(TASKS.map((t) => [t.id, t] as const))(`${listing} listing: %s`, async (_id, task) => {
      evalHub = await startEvalHub({ listing });
      const s = await session(evalHub);
      if (listing === 'auto') expect(s.listing).toBe('discovery');
      await task.solve(s);
      task.check();
      expect(s.calls.length, s.calls.map((c) => c.tool).join(' → ')).toBeLessThanOrEqual(task.maxCalls);
    });
  }
});
