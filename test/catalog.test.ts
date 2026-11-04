import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import demo from '../src/connectors/builtin/demo.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { defineConnector } from '../src/connectors/sdk.js';
import type { AccountRow } from '../src/core/accounts.js';
import { buildCatalog, MAX_TOOL_NAME } from '../src/hub/catalog.js';

function account(partial: Partial<AccountRow> & { name: string }): AccountRow {
  const now = new Date();
  return {
    id: `acc_${partial.name}`,
    workspaceId: 'wsp_1',
    connectorId: 'demo',
    label: partial.name.toUpperCase(),
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
    checkedAt: null,
    ...partial,
  };
}

describe('tool catalog', () => {
  it('always exposes the hub tools, even with no accounts', () => {
    const catalog = buildCatalog({ connectors: [demo], accounts: [] });
    expect(catalog.listed.map((t) => t.name)).toEqual(['manyplug_list_accounts', 'manyplug_call_tools']);
    expect(catalog.listing).toBe('direct');
    expect(catalog.instructions).toContain('No services are connected');
  });

  it('groups accounts into one tool per action with an account argument', () => {
    const catalog = buildCatalog({
      connectors: [demo],
      accounts: [account({ name: 'work', metadata: { identity: 'me@work' } }), account({ name: 'home' })],
    });
    const echo = catalog.tools.find((t) => t.name === 'demo_echo')!;
    const props = echo.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
    expect(Object.keys(props)[0]).toBe('account');
    // Read tools default to every account at once.
    expect(props.account!.enum).toEqual(['work', 'home', 'all']);
    expect(props.account!.description).toContain('me@work');
    expect(echo.inputSchema.required).toEqual(['message']);
    expect(echo.target).toMatchObject({ kind: 'action', fanOut: true });
    expect(catalog.instructions).toContain('Demo (demo)');
  });

  it('makes the account argument optional when only one account exists', () => {
    const catalog = buildCatalog({ connectors: [demo], accounts: [account({ name: 'solo' })] });
    const echo = catalog.tools.find((t) => t.name === 'demo_echo')!;
    expect(echo.inputSchema.required).toEqual(['message']);
  });

  it('can expose one tool per account instead', () => {
    const catalog = buildCatalog({
      connectors: [demo],
      accounts: [account({ name: 'work' }), account({ name: 'home' })],
      mode: 'per_account',
    });
    const names = catalog.tools.map((t) => t.name);
    expect(names).toContain('demo_work_echo');
    expect(names).toContain('demo_home_echo');
    const tool = catalog.tools.find((t) => t.name === 'demo_work_echo')!;
    expect((tool.inputSchema.properties as Record<string, unknown>).account).toBeUndefined();
  });

  it('hides disabled accounts and per-account disabled actions', () => {
    const catalog = buildCatalog({
      connectors: [demo],
      accounts: [
        account({ name: 'work', settings: { disabledActions: ['fail'] } }),
        account({ name: 'old', enabled: false }),
      ],
    });
    expect(catalog.tools.some((t) => t.name === 'demo_fail')).toBe(false);
    const echo = catalog.tools.find((t) => t.name === 'demo_echo')!;
    expect((echo.inputSchema.properties as Record<string, { enum: string[] }>).account!.enum).toEqual([
      'work',
    ]);
  });

  it('keeps tool names valid for every AI client', () => {
    const long = defineConnector({
      id: 'a_very_long_service_id_x',
      name: 'Long',
      description: 'x',
      version: '1',
      actions: (action) => [
        action({
          name: 'an_extremely_long_action_name_for_tests',
          description: 'x',
          input: z.object({}),
          run: () => 'ok',
        }),
      ],
    });
    const catalog = buildCatalog({
      connectors: [long],
      accounts: [account({ name: 'account_name_that_is_long_too', connectorId: long.id })],
      mode: 'per_account',
    });
    for (const tool of catalog.tools) {
      expect(tool.name.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it('marks write actions as potentially destructive unless stated otherwise', () => {
    const svc = defineConnector({
      id: 'svc',
      name: 'Svc',
      description: 'x',
      version: '1',
      actions: (action) => [
        action({ name: 'send', description: 'Send', input: z.object({}), run: () => 'ok' }),
        action({
          name: 'read',
          description: 'Read',
          input: z.object({}),
          hints: { readOnly: true },
          run: () => 'ok',
        }),
      ],
    });
    const catalog = buildCatalog({
      connectors: [svc],
      accounts: [account({ name: 'a', connectorId: 'svc' })],
    });
    expect(catalog.tools.find((t) => t.name === 'svc_send')!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(catalog.tools.find((t) => t.name === 'svc_read')!.annotations.destructiveHint).toBe(false);
  });
});

describe('connector registry', () => {
  it('rejects invalid or reserved definitions', () => {
    const make = (id: string, input = z.object({})) =>
      defineConnector({
        id,
        name: 'X',
        description: 'x',
        version: '1',
        actions: (action) => [action({ name: 'do_it', description: 'x', input, run: () => 'ok' })],
      });
    expect(() => new ConnectorRegistry().register(make('Bad-Id'))).toThrow(/Invalid connector id/);
    expect(() => new ConnectorRegistry().register(make('manyplug'))).toThrow(/reserved/);
    expect(() => new ConnectorRegistry().register(make('ok', z.object({ account: z.string() })))).toThrow(
      /account/,
    );
    expect(() => new ConnectorRegistry().register(make('ok')).register(make('ok'))).toThrow(
      /already registered/,
    );
  });
});
