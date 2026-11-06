import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import demo from '../src/connectors/builtin/demo.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import type { Principal } from '../src/core/principal.js';
import { toolCalls } from '../src/db/schema.js';
import type { ToolCallResult } from '../src/hub/result.js';
import { base32Decode, totp } from '../src/lib/totp.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/** Managing the hub from the chat: the `manyplug_*` setup tools run on the workspace. */
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
    hub = await startTestHub({
      connectors: new ConnectorRegistry().register(demo),
      seed: false,
      env: { CONFIRMATION_WAIT_SECONDS: '0' },
    });
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
    expect(setup).toEqual(expect.arrayContaining(['manyplug_services', 'manyplug_connect_account']));
    expect(catalog.listed.map((t) => t.name)).toContain('manyplug_connect_account');
    expect(catalog.instructions).toContain('manyplug_connect_account');
    expect(catalog.instructions).toContain('never ask for passwords');
    const removal = catalog.tools.find((t) => t.name === 'manyplug_remove_account')!;
    expect(removal.annotations.destructiveHint).toBe(true);
  });

  it('lists the services that can be connected', async () => {
    const data = json(await call('manyplug_services'));
    expect(data.services).toEqual([
      expect.objectContaining({ service: 'demo', connect: 'form', ready: true, accounts: 0, custom: false }),
    ]);
  });

  it('returns a link to connect an account, never asking for the secret', async () => {
    const data = json(
      await call('manyplug_connect_account', { service: 'demo', label: 'Work', name: 'work' }),
    );
    expect(data.url).toBe(`${hub.baseUrl}/connect/demo?label=Work&name=work`);
    expect(data.method).toBe('form');
    const unknown = await call('manyplug_connect_account', { service: 'nope' });
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
      await call('manyplug_update_account', {
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

    const missing = await call('manyplug_update_account', { account: 'demo:nobody', label: 'X' });
    expect(missing.isError).toBe(true);
  });

  it('checks an account', async () => {
    const data = json(await call('manyplug_test_account', { account: 'demo:personal' }));
    expect(data).toMatchObject({ account: 'demo:personal', ok: true, identity: 'demo:personal' });
  });

  it('never removes data or adds a service without the user’s confirmation', async () => {
    // Even a rule that turns confirmations off cannot lift it for setup actions.
    await hub.services.policies.createRule(workspaceId, { connectorId: 'manyplug', confirm: 'never' });

    const removal = await call('manyplug_remove_account', { account: 'demo:personal' });
    expect(text(removal)).toContain('/confirm/');
    expect(await hub.services.accounts.findByName(workspaceId, 'demo', 'personal')).toBeDefined();

    const added = await call('manyplug_add_service', {
      mcp_url: 'https://example.com/mcp',
      name: 'Example',
    });
    expect(text(added)).toContain('/confirm/');
    expect(await hub.services.customServices.list(workspaceId)).toEqual([]);

    const open = await hub.services.pendingCalls.listOpen(workspaceId);
    expect(open.map((r) => [r.connectorId, r.action, r.accountId]).sort()).toEqual([
      ['manyplug', 'add_service', null],
      ['manyplug', 'remove_account', null],
    ]);
    const addRow = open.find((r) => r.action === 'add_service')!;
    await hub.services.pendingCalls.decide(addRow.id, false, 'web');
    expect(
      text(await call('manyplug_add_service', { mcp_url: 'https://example.com/mcp', name: 'Example' })),
    ).toContain('declined');
  });

  it('runs a confirmed setup action once the user approves it', async () => {
    const [row] = await hub.services.pendingCalls.listOpen(workspaceId);
    expect(row).toMatchObject({ action: 'remove_account', accountId: null });
    await hub.services.pendingCalls.decide(row!.id, true, 'web');
    await hub.services.pendingRunner.tick();
    expect(await hub.services.accounts.findByName(workspaceId, 'demo', 'personal')).toBeUndefined();
    // The AI repeats the call and gets the result of the approved run.
    const repeat = await call('manyplug_remove_account', { account: 'demo:personal' });
    expect(json(repeat)).toEqual({ removed: 'demo:personal' });
  });

  it('keeps setup out of reach of a persona connection', async () => {
    const persona = await hub.services.personas.create(workspaceId, {
      name: 'Work',
      slug: 'work',
      accountIds: [],
    });
    const catalog = await hub.services.hub.getCatalog({ ...principal, personaId: persona.id });
    expect(catalog.tools.filter((t) => t.target.kind === 'workspace')).toEqual([]);
  });

  it('changes hub settings', async () => {
    const data = json(await call('manyplug_update_settings', { tool_listing: 'discovery' }));
    expect(data.settings).toEqual({ tool_listing: 'discovery', tool_exposure: 'grouped' });
    const catalog = await hub.services.hub.getCatalog(principal);
    expect(catalog.listing).toBe('discovery');
    // Setup tools stay reachable through search.
    const found = json(await call('manyplug_search_tools', { query: 'connect an account' }));
    expect(found.tools.map((t: { name: string }) => t.name)).toContain('manyplug_connect_account');
  });

  it('audits setup calls against the workspace, not an account', async () => {
    const rows = await hub.services.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.toolName, 'manyplug_update_account'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ connectorId: 'manyplug', action: 'update_account', accountId: null });
    const declined = await hub.services.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.toolName, 'manyplug_remove_account'));
    expect(declined.map((r) => r.outcome)).toContain('awaiting_confirmation');
    expect(declined.every((r) => r.risk === 'dangerous' && r.accountId === null)).toBe(true);
  });

  it('counts executed calls as usage, but not refused ones', async () => {
    const usage = await hub.services.usage.list(workspaceId, '2000-01-01');
    const actions = usage.filter((r) => r.connectorId === 'manyplug').map((r) => r.action);
    expect(actions).toContain('update_account');
    expect(actions).toContain('remove_account'); // ran once the user approved it
    expect(actions).not.toContain('add_service');
    expect(usage.every((r) => r.caller === `user:${principal.userId}`)).toBe(true);
  });

  describe('access rules from the chat', () => {
    const approveOpen = async (action: string) => {
      const row = (await hub.services.pendingCalls.listOpen(workspaceId)).find((r) => r.action === action);
      expect(row).toBeDefined();
      await hub.services.pendingCalls.decide(row!.id, true, 'web');
      await hub.services.pendingRunner.tick();
    };
    const accountRule = async () => {
      const account = (await hub.services.accounts.findByName(workspaceId, 'demo', 'rules'))!;
      return (await hub.services.policies.listRules(workspaceId)).find((r) => r.accountId === account.id);
    };

    beforeAll(async () => {
      await hub.services.accounts.create(workspaceId, {
        connectorId: 'demo',
        name: 'rules',
        label: 'Rules',
        credentials: { secret: 's' },
      });
    });

    it('shows the defaults and what applies to this app on each account', async () => {
      const data = json(await call('manyplug_rules'));
      expect(data.defaults).toEqual({
        access: 'full',
        confirm: 'dangerous',
        confirm_in: 'link',
        undo_window_seconds: 0,
      });
      expect(data.for_this_app).toContainEqual({
        account: 'demo:rules',
        label: 'Rules',
        access: 'full',
        confirm: 'dangerous',
      });
      expect(data.levels.confirm).toContain('dangerous');
    });

    it('applies a change that only tightens at once', async () => {
      const data = json(await call('manyplug_set_rule', { account: 'demo:rules', confirm: 'always' }));
      expect(data.saved).toBe(true);
      // Unset values are left out of results.
      expect(data.rules).toContainEqual({ account: 'demo:rules', confirm: 'always' });
      expect(await accountRule()).toMatchObject({ confirm: 'always' });
    });

    it('holds a change that loosens protection until the user confirms it, whatever the rules say', async () => {
      // The setup tools already run with "never ask" (rule from an earlier test): it does not help.
      const held = await call('manyplug_set_rule', { account: 'demo:rules', confirm: 'never' });
      expect(text(held)).toContain('/confirm/');
      expect(await accountRule()).toMatchObject({ confirm: 'always' });
      const [row] = (await hub.services.pendingCalls.listOpen(workspaceId)).filter(
        (r) => r.action === 'set_rule',
      );
      expect(row).toMatchObject({
        risk: 'dangerous',
        reason: expect.stringContaining('Lowers your protection'),
      });

      await approveOpen('set_rule');
      expect(await accountRule()).toMatchObject({ confirm: 'never' });
      const repeat = json(await call('manyplug_set_rule', { account: 'demo:rules', confirm: 'never' }));
      expect(repeat.saved).toBe(true);
    });

    it('treats the defaults the same way', async () => {
      const stricter = json(await call('manyplug_set_rule', { confirm: 'write', undo_window_seconds: 20 }));
      expect(stricter.defaults).toEqual({
        access: 'full',
        confirm: 'write',
        confirm_in: 'link',
        undo_window_seconds: 20,
      });
      const looser = await call('manyplug_set_rule', { undo_window_seconds: 0 });
      expect(text(looser)).toContain('/confirm/');
      expect((await hub.services.admin.security(workspaceId)).undoWindowSeconds).toBe(20);
      await approveOpen('set_rule');
      expect((await hub.services.admin.security(workspaceId)).undoWindowSeconds).toBe(0);
    });

    it('asks before turning back on a tool the user turned off', async () => {
      const hidden = json(
        await call('manyplug_update_account', { account: 'demo:rules', disable_tools: ['fail'] }),
      );
      expect(hidden.updated.disabledTools).toEqual(['fail']);
      const back = await call('manyplug_update_account', { account: 'demo:rules', enable_tools: ['fail'] });
      expect(text(back)).toContain('/confirm/');
      await approveOpen('update_account');
      const account = await hub.services.accounts.findByName(workspaceId, 'demo', 'rules');
      expect(account!.settings.disabledActions).toEqual([]);
    });

    it('explains a mistake without asking the user anything', async () => {
      const unknown = await call('manyplug_set_rule', { app: 'Nope', confirm: 'never' });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toContain('AI app "Nope" not found');
      const removal = await call('manyplug_set_rule', { confirm: null });
      expect(text(removal)).toContain('can be changed, not removed');
      const open = await hub.services.pendingCalls.listOpen(workspaceId);
      expect(open.filter((r) => r.action === 'set_rule')).toEqual([]);
    });
  });

  describe('access profiles from the chat', () => {
    const approveOpen = async (action: string) => {
      const row = (await hub.services.pendingCalls.listOpen(workspaceId)).find((r) => r.action === action);
      expect(row).toBeDefined();
      await hub.services.pendingCalls.decide(row!.id, true, 'web');
      await hub.services.pendingRunner.tick();
    };
    const profile = async (slug: string) => hub.services.personas.bySlug(workspaceId, slug);
    const idOf = async (name: string) =>
      (await hub.services.accounts.findByName(workspaceId, 'demo', name))!.id;

    beforeAll(async () => {
      await hub.services.accounts.create(workspaceId, {
        connectorId: 'demo',
        name: 'extra',
        label: 'Extra',
        credentials: { secret: 's' },
      });
    });

    it('lists the profiles with their address, accounts and access', async () => {
      const data = json(await call('manyplug_access_profiles'));
      expect(data.profiles).toContainEqual({
        profile: 'Work',
        address: 'work',
        url: `${hub.baseUrl}/mcp/work`,
        // No accounts: empty lists are left out of results.
        max_access: 'full',
        apps_connected: 0,
      });
    });

    it('creates a profile with an address made from its name', async () => {
      const data = json(
        await call('manyplug_create_access_profile', {
          name: 'Рабочий ИИ',
          accounts: ['demo:rules', 'demo:extra'],
          max_access: 'read',
        }),
      );
      expect(data.created).toMatchObject({
        profile: 'Рабочий ИИ',
        address: 'rabochiy-ii',
        url: `${hub.baseUrl}/mcp/rabochiy-ii`,
        accounts: ['demo:rules', 'demo:extra'],
        max_access: 'read',
      });
      expect(data.next).toContain('url');
      // A taken address gets a number.
      const second = json(
        await call('manyplug_create_access_profile', { name: 'Work', accounts: ['demo:rules'] }),
      );
      expect(second.created.address).toBe('work-2');
      const bad = await call('manyplug_create_access_profile', {
        name: 'X',
        accounts: ['demo:rules'],
        address: 'Not valid!',
      });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toContain('lowercase letters');
    });

    it('narrows a profile at once and asks before widening it', async () => {
      const narrowed = json(
        await call('manyplug_update_access_profile', {
          profile: 'rabochiy-ii',
          remove_accounts: ['demo:extra'],
        }),
      );
      expect(narrowed.updated.accounts).toEqual(['demo:rules']);

      const held = await call('manyplug_update_access_profile', {
        profile: 'Рабочий ИИ',
        add_accounts: ['demo:extra'],
      });
      expect(text(held)).toContain('/confirm/');
      expect((await profile('rabochiy-ii'))!.accountIds).toEqual([await idOf('rules')]);
      const [row] = (await hub.services.pendingCalls.listOpen(workspaceId)).filter(
        (r) => r.action === 'update_access_profile',
      );
      expect(row).toMatchObject({
        risk: 'dangerous',
        reason: expect.stringContaining('Lowers your protection: profile Рабочий ИИ shows 1 more account'),
      });
      await approveOpen('update_access_profile');
      expect((await profile('rabochiy-ii'))!.accountIds).toEqual([await idOf('rules'), await idOf('extra')]);

      const raise = await call('manyplug_update_access_profile', {
        profile: 'rabochiy-ii',
        max_access: 'full',
      });
      expect(text(raise)).toContain('/confirm/');
      expect((await profile('rabochiy-ii'))!.maxAccess).toBe('read');
      await approveOpen('update_access_profile');
      expect((await profile('rabochiy-ii'))!.maxAccess).toBe('full');

      // Lowering it again and renaming need no confirmation.
      const lowered = json(
        await call('manyplug_update_access_profile', {
          profile: 'rabochiy-ii',
          max_access: 'write',
          name: 'Office',
        }),
      );
      expect(lowered.updated).toMatchObject({
        profile: 'Office',
        address: 'rabochiy-ii',
        max_access: 'write',
      });
    });

    it('deletes a profile only after the user confirms, disconnecting its tokens', async () => {
      const persona = (await profile('rabochiy-ii'))!;
      const { row: token } = await hub.services.apiTokens.create({
        workspaceId,
        userId: principal.userId,
        name: 'office script',
        personaId: persona.id,
      });
      expect(json(await call('manyplug_access_profiles')).profiles).toContainEqual(
        expect.objectContaining({ address: 'rabochiy-ii', apps_connected: 1 }),
      );
      const held = await call('manyplug_delete_access_profile', { profile: 'office' });
      expect(text(held)).toContain('/confirm/');
      expect(await profile('rabochiy-ii')).toBeDefined();
      await approveOpen('delete_access_profile');
      expect(await profile('rabochiy-ii')).toBeUndefined();
      expect((await hub.services.apiTokens.list(workspaceId)).map((t) => t.id)).not.toContain(token.id);
    });

    it('explains an unknown profile or account without asking anything', async () => {
      const unknown = await call('manyplug_update_access_profile', { profile: 'nope', name: 'X' });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toContain('Access profile "nope" not found');
      const account = await call('manyplug_update_access_profile', {
        profile: 'work',
        add_accounts: ['demo:nobody'],
      });
      expect(account.isError).toBe(true);
      const open = await hub.services.pendingCalls.listOpen(workspaceId);
      expect(open.filter((r) => r.action === 'update_access_profile')).toEqual([]);
    });
  });

  describe('AI apps from the chat', () => {
    let cursor: { id: string };
    let tokenId: string;
    const as = (app: { id: string }, credentialId?: string): Principal => ({
      ...principal,
      aiClientId: app.id,
      ...(credentialId ? { credentialId } : {}),
    });
    const callAs = async (who: Principal, tool: string, args: Record<string, unknown> = {}) => {
      const catalog = await hub.services.hub.getCatalog(who);
      return hub.services.hub.callTool(who, catalog, tool, args);
    };
    const today = new Date().toISOString().slice(0, 10);

    beforeAll(async () => {
      cursor = await hub.services.aiClients.createUnique(workspaceId, 'Cursor', 'api_token');
      tokenId = (
        await hub.services.apiTokens.create({
          workspaceId,
          userId: principal.userId,
          name: 'Cursor',
          aiClientId: cursor.id,
        })
      ).row.id;
      const scripts = await hub.services.personas.create(workspaceId, {
        slug: 'scripts',
        name: 'Scripts',
        accountIds: [],
      });
      const report = await hub.services.aiClients.createUnique(workspaceId, 'Report script', 'api_token');
      await hub.services.apiTokens.create({
        workspaceId,
        userId: principal.userId,
        name: 'Report script',
        aiClientId: report.id,
        personaId: scripts.id,
      });
    });

    it('lists the apps with how they connect and through which profile', async () => {
      const data = json(await callAs(as(cursor, tokenId), 'manyplug_apps'));
      expect(data.apps).toContainEqual({
        app: 'Cursor',
        id: cursor.id,
        this_app: true,
        kind: 'personal token',
        connected: true,
        connections: [{ via: 'token', since: today }],
      });
      expect(data.apps).toContainEqual(
        expect.objectContaining({
          app: 'Report script',
          connections: [{ via: 'token', profile: 'Scripts', since: today }],
        }),
      );
      expect(data.apps.find((a: { app: string }) => a.app === 'Report script')).not.toHaveProperty(
        'this_app',
      );
    });

    it('renames an app by name (any case) or as "this"', async () => {
      const renamed = json(await call('manyplug_rename_app', { app: 'cursor', name: 'Cursor at work' }));
      expect(renamed.renamed).toMatchObject({ app: 'Cursor at work', id: cursor.id });
      const self = json(await callAs(as(cursor), 'manyplug_rename_app', { app: 'this', name: 'Cursor' }));
      expect(self.renamed).toMatchObject({ app: 'Cursor', this_app: true });
      // A connection with no app behind it has to name one.
      const unlinked = await call('manyplug_rename_app', { app: 'this', name: 'X' });
      expect(unlinked.isError).toBe(true);
      expect(text(unlinked)).toContain('name the app');
      const unknown = await call('manyplug_rename_app', { app: 'nope', name: 'X' });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toContain('AI app "nope" not found');
    });

    it('disconnects an app only after the user confirms, keeping its rules', async () => {
      await hub.services.policies.setScopedRule(
        workspaceId,
        { aiClientId: cursor.id },
        { access: 'read', confirm: null },
      );
      const held = await call('manyplug_disconnect_app', { app: 'Cursor' });
      expect(text(held)).toContain('/confirm/');
      expect((await hub.services.apiTokens.list(workspaceId)).map((t) => t.id)).toContain(tokenId);
      const row = (await hub.services.pendingCalls.listOpen(workspaceId)).find(
        (r) => r.action === 'disconnect_app',
      );
      expect(row).toBeDefined();
      await hub.services.pendingCalls.decide(row!.id, true, 'web');
      await hub.services.pendingRunner.tick();
      expect((await hub.services.apiTokens.list(workspaceId)).map((t) => t.id)).not.toContain(tokenId);
      const after = json(await call('manyplug_apps'));
      expect(after.apps).toContainEqual(expect.objectContaining({ app: 'Cursor', connected: false }));
      const rules = await hub.services.policies.listRules(workspaceId);
      expect(rules).toContainEqual(expect.objectContaining({ aiClientId: cursor.id, access: 'read' }));
    });
  });

  describe('sign-in security from the chat', () => {
    it('shows two-step sign-in and recovery codes with the pages to change them, read only', async () => {
      const before = json(await call('manyplug_security'));
      expect(before.two_step).toMatchObject({ on: false, authenticator_app: false, passkeys: 0 });
      expect(before.advice[0]).toContain(`${hub.baseUrl}/security`);
      expect(before.change_at).toEqual({
        sign_in: `${hub.baseUrl}/security`,
        browsers: `${hub.baseUrl}/app/settings#sessions`,
      });
      // This server has no Telegram bot, so approvals in Telegram are not mentioned.
      expect(before).not.toHaveProperty('telegram_approvals');
      expect(before.note).toContain('cannot be changed from the chat');

      const user = (await hub.services.users.get(principal.userId))!;
      const { totp: authenticator, recoveryCodes } = hub.services.secondFactors;
      const { secret } = await authenticator.beginEnrollment(user);
      expect(await authenticator.confirm(user.id, totp(base32Decode(secret), Date.now()))).toBe(true);
      const codes = await recoveryCodes.regenerate(user.id);
      for (const code of codes.slice(2)) expect(await recoveryCodes.consume(user.id, code)).toBe(true);

      const after = json(await call('manyplug_security'));
      expect(after.two_step).toMatchObject({ on: true, authenticator_app: true, recovery_codes_left: 2 });
      expect(after.advice).toEqual([expect.stringContaining(`${hub.baseUrl}/security#recovery`)]);
      // Nothing here can be changed from the chat.
      const catalog = await hub.services.hub.getCatalog(principal);
      expect(catalog.tools.find((t) => t.name === 'manyplug_security')?.annotations.readOnlyHint).toBe(true);
    });
  });
});
