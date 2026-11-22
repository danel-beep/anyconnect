import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../src/connectors/index.js';
import type { AccountRow } from '../src/core/accounts.js';
import { buildCatalog, buildInstructions, MAX_INSTRUCTIONS_CHARS } from '../src/hub/catalog.js';
import { SETUP_CONNECTOR } from '../src/hub/setup-tools.js';

/**
 * What AI clients keep of the hub's catalog. Claude Code cuts server instructions and every tool
 * description at 2048 characters and silently drops the rest, so the hub must fit on its own:
 * the rules first, then the connected services, then hints.
 */
const registry = createBuiltinRegistry();
const now = new Date();

function accountsFor(services: string[], perService: number): AccountRow[] {
  return services.flatMap((connectorId) =>
    Array.from({ length: perService }, (_, i) => ({
      id: `acc_${connectorId}_${i}`,
      workspaceId: 'wsp_1',
      connectorId,
      name: i === 0 ? connectorId : `${connectorId}_${i + 1}`,
      label: `${connectorId} account ${i + 1}`,
      description: null,
      config: {},
      dataKeyEncrypted: null,
      credentialsEncrypted: null,
      enabled: true,
      status: 'active' as const,
      statusMessage: null,
      settings: {},
      metadata: { identity: `person${i}@${connectorId}.example` },
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      ownerUserId: null,
      checkedAt: null,
      reauthNotifiedAt: null,
    })),
  );
}

const catalogFor = (services: string[], perService = 2) =>
  buildCatalog({
    connectors: registry.all(),
    accounts: accountsFor(services, perService),
    setup: SETUP_CONNECTOR,
  });

const RULES = ['⟦untrusted', 'same arguments', '"account" argument'];

describe('what AI clients keep of the catalog', () => {
  it('keeps every tool description within the 2048 characters Claude Code shows', () => {
    const catalog = catalogFor(registry.all().map((c) => c.id));
    const long = catalog.tools
      .filter((t) => t.description.length > MAX_INSTRUCTIONS_CHARS)
      .map((t) => t.name);
    expect(long).toEqual([]);
  });

  it.each([
    ['a typical workspace', ['gmail', 'gcal', 'telegram'], 3],
    ['every built-in service', registry.all().map((c) => c.id), 2],
    ['one service with many accounts', ['gmail'], 40],
  ])('fits the server instructions of %s into the budget, rules first', (_name, services, perService) => {
    const { instructions } = catalogFor(services, perService);
    expect(instructions.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    for (const rule of RULES) expect(instructions).toContain(rule);
  });

  it('lists the services of a typical workspace with their hints and the setup line', () => {
    const { instructions } = catalogFor(['gmail', 'gcal'], 3);
    expect(instructions).toContain('- Gmail (gmail): "gmail" — gmail account 1 (person0@gmail.example)');
    expect(instructions).toContain('Gmail search syntax');
    expect(instructions).toContain('RFC 3339');
    expect(instructions).toContain('manyplug_connect_account');
  });

  it('drops hints before services, and points to list_accounts for services that do not fit', () => {
    const catalog = catalogFor(['gmail', 'gcal', 'telegram'], 3);
    const tight = buildInstructions(catalog.services, 'grouped', 'discovery', {
      setup: true,
      maxChars: 1300,
    });
    expect(tight.length).toBeLessThanOrEqual(1300);
    expect(tight).not.toContain('Gmail search syntax');
    for (const rule of RULES) expect(tight).toContain(rule);
    expect(tight).toMatch(/- and \d more: call manyplug_list_accounts\./);

    const roomy = buildInstructions(catalog.services, 'grouped', 'discovery', {
      setup: true,
      maxChars: 10_000,
    });
    expect(roomy).toContain('- Telegram (telegram)');
    expect(roomy).toContain('telegram_whats_new');
  });
});
