import { describe, expect, it } from 'vitest';
import { getPlan, PLANS, yearlyFreeMonths } from '../src/billing/plans.js';
import { createBuiltinRegistry } from '../src/connectors/index.js';
import type { AccountRow } from '../src/core/accounts.js';
import { buildCatalog } from '../src/hub/catalog.js';

function account(connectorId: string): AccountRow {
  const now = new Date();
  return {
    id: `acc_${connectorId}`,
    workspaceId: 'wsp_1',
    connectorId,
    name: connectorId,
    label: connectorId,
    description: null,
    config: {},
    dataKeyEncrypted: null,
    credentialsEncrypted: null,
    enabled: true,
    status: 'active',
    statusMessage: null,
    settings: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    ownerUserId: null,
    checkedAt: null,
    reauthNotifiedAt: null,
  };
}

describe('landing claims', () => {
  it('keeps the tool list within 3k tokens with every service connected, against 60k+ for every tool', () => {
    // The "A short menu, however many services" tile (landing.f.context.*) quotes these numbers.
    const connectors = createBuiltinRegistry()
      .all()
      .filter((c) => c.id !== 'demo' && c.id !== 'http' && c.actions.length > 0);
    const { stats } = buildCatalog({ connectors, accounts: connectors.map((c) => account(c.id)) });
    expect(stats.directTokens).toBeGreaterThan(60_000);
    expect(stats.listedTokens).toBeLessThanOrEqual(3_000);
  });

  it('promises only the free months every public paid plan really gives on yearly billing', () => {
    // Today every paid plan costs ten months a year.
    expect(yearlyFreeMonths()).toBe(2);
    const pro = getPlan('pro');
    // One plan with a smaller discount lowers the promise for all of them.
    expect(yearlyFreeMonths([...PLANS, { ...pro, id: 'odd', priceMonthly: 10, priceYearly: 115 }])).toBe(0);
    expect(yearlyFreeMonths([{ ...pro, priceMonthly: 10, priceYearly: 90 }])).toBe(3);
    // Hidden and free plans do not count; no paid plans means no promise.
    expect(yearlyFreeMonths([{ ...pro, public: false, priceYearly: 0 }, getPlan('free')])).toBe(0);
  });
});
