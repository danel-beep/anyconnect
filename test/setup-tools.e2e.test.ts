import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import demo from '../src/connectors/builtin/demo.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import type { Principal } from '../src/core/principal.js';
import { toolCalls } from '../src/db/schema.js';
import type { ToolCallResult } from '../src/hub/result.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/** Managing the hub from the chat: the `anyconnect_*` setup tools run on the workspace. */
describe('setup tools (manage the hub from the AI assistant)', () => {
  let hub: TestHub;
  let principal: Principal;
  let workspaceId: string;

  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const catalog = await hub.services.hub.getCatalog(principal);
    return hub.services.hub.callTool(principal, catalog, tool, args);
  };
  const json = (result: ToolCallResult): any =>
    result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text);
  const text = (result: ToolCallResult) => (result.content[0] as { text: string }).text;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ connectors: new ConnectorRegistry().register(demo), seed: false });
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const user = (await hub.services.db.query.users.findFirst())!;
    workspaceId = workspace.id;
    principal = { kind: 'api_token', userId: user.id, workspaceId, scopes: ['mcp'] };
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('offers setup tools and tells a new user how to start', async () => {
    const catalog = await hub.services.hub.getCatalog(principal);
    const setup = catalog.tools.filter((t) => t.target.kind === 'workspace').map((t) => t.name);
    expect(setup).toEqual(expect.arrayContaining(['anyconnect_services', 'anyconnect_connect_account']));
    expect(catalog.listed.map((t) => t.name)).toContain('anyconnect_connect_account');
    expect(catalog.instructions).toContain('anyconnect_connect_account');
    expect(catalog.instructions).toContain('never ask for passwords');
    const removal = catalog.tools.find((t) => t.name === 'anyconnect_remove_account')!;
    expect(removal.annotations.destructiveHint).toBe(true);
  });

  it('lists the services that can be connected', async () => {
    const data = json(await call('anyconnect_services'));
    expect(data.services).toEqual([
      expect.objectContaining({ service: 'demo', connect: 'form', ready: true, accounts: 0, custom: false }),
    ]);
  });

  it('returns a link to connect an account, never asking for the secret', async () => {
    const data = json(
      await call('anyconnect_connect_account', { service: 'demo', label: 'Work', name: 'work' }),
    );
    expect(data.url).toBe(`${hub.baseUrl}/connect/demo?label=Work&name=work`);
    expect(data.method).toBe('form');
    const unknown = await call('anyconnect_connect_account', { service: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('Unknown service');
  });

  it('renames an account and hides some of its tools', async () => {
    await hub.services.accounts.create(workspaceId, {
      connectorId: 'demo',
      name: 'main',
      label: 'Main',
      credentials: { secret: 's' },
    });
    const updated = json(
      await call('anyconnect_update_account', {
        account: 'demo:main',
        rename: 'personal',
        label: 'Personal',
        disable_tools: ['fail'],
      }),
    );
    expect(updated.updated).toMatchObject({
      account: 'demo:personal',
      label: 'Personal',
      disabledTools: ['fail'],
    });
    const catalog = await hub.services.hub.getCatalog(principal);
    expect(catalog.tools.map((t) => t.name)).not.toContain('demo_fail');
    expect(catalog.instructions).toContain('Personal');

    const missing = await call('anyconnect_update_account', { account: 'demo:nobody', label: 'X' });
    expect(missing.isError).toBe(true);
  });

  it('checks an account', async () => {
    const data = json(await call('anyconnect_test_account', { account: 'demo:personal' }));
    expect(data).toMatchObject({ account: 'demo:personal', ok: true, identity: 'demo:personal' });
  });

  it('never removes data or adds a service without the user’s confirmation', async () => {
    const removal = await call('anyconnect_remove_account', { account: 'demo:personal' });
    expect(removal.isError).toBe(true);
    expect(text(removal)).toContain('confirmation');
    expect(await hub.services.accounts.findByName(workspaceId, 'demo', 'personal')).toBeDefined();

    const added = await call('anyconnect_add_service', {
      mcp_url: 'https://example.com/mcp',
      name: 'Example',
    });
    expect(added.isError).toBe(true);
    expect(await hub.services.customServices.list(workspaceId)).toEqual([]);
  });

  it('changes hub settings', async () => {
    const data = json(await call('anyconnect_update_settings', { tool_listing: 'discovery' }));
    expect(data.settings).toEqual({ tool_listing: 'discovery', tool_exposure: 'grouped' });
    const catalog = await hub.services.hub.getCatalog(principal);
    expect(catalog.listing).toBe('discovery');
    // Setup tools stay reachable through search.
    const found = json(await call('anyconnect_search_tools', { query: 'connect an account' }));
    expect(found.tools.map((t: { name: string }) => t.name)).toContain('anyconnect_connect_account');
  });

  it('audits setup calls against the workspace, not an account', async () => {
    const rows = await hub.services.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.toolName, 'anyconnect_update_account'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ connectorId: 'anyconnect', action: 'update_account', accountId: null });
    const declined = await hub.services.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.toolName, 'anyconnect_remove_account'));
    expect(declined[0]).toMatchObject({ outcome: 'declined', risk: 'dangerous' });
  });

  it('counts executed calls as usage, but not refused ones', async () => {
    const usage = await hub.services.usage.list(workspaceId, '2000-01-01');
    const actions = usage.filter((r) => r.connectorId === 'anyconnect').map((r) => r.action);
    expect(actions).toContain('update_account');
    expect(actions).not.toContain('remove_account');
    expect(usage.every((r) => r.caller === `user:${principal.userId}`)).toBe(true);
  });
});
