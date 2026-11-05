import {
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import demo from '../src/connectors/builtin/demo.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { ConnectorError, defineConnector } from '../src/connectors/sdk.js';
import { AccountAlerts } from '../src/core/account-alerts.js';
import { createUser } from '../src/core/identity.js';
import type { Principal } from '../src/core/principal.js';
import { accountShares, oauthGrants, users, workspaces } from '../src/db/schema.js';
import type { ToolCallResult } from '../src/hub/result.js';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/** A notebook per account: one action that reads and one that writes, to see access levels at work. */
const notes = defineConnector({
  id: 'notes',
  name: 'Notes',
  description: 'A notebook per account',
  version: '1.0.0',
  actions: (action) => [
    action({
      name: 'read',
      description: 'Reads the notes',
      input: z.object({}),
      hints: { readOnly: true },
      run: (_input, ctx) => ({ notebook: ctx.account.name }),
    }),
    action({
      name: 'add',
      description: 'Adds a note',
      input: z.object({ text: z.string() }),
      risk: 'write',
      run: ({ text }, ctx) => ({ added: text, notebook: ctx.account.name }),
    }),
    action({
      name: 'sync',
      description: 'Syncs the notebook (its sign-in has expired)',
      input: z.object({}),
      hints: { readOnly: true },
      run: () => {
        throw new ConnectorError('auth', 'Token expired');
      },
    }),
  ],
});

type Tokens = Parameters<OAuthClientProvider['saveTokens']>[0];
type Stored = Parameters<NonNullable<OAuthClientProvider['saveClientInformation']>>[0];

/** An AI app's OAuth client, in memory (the way Claude Code or ChatGPT behave). */
class AppClient implements OAuthClientProvider {
  client?: Stored;
  saved?: Tokens;
  verifier = '';
  authorizationUrl?: URL;
  discovery?: unknown;
  readonly redirectUrl = 'http://localhost:7777/callback';
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Team Test App',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(info: Stored) {
    this.client = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: Tokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(state: unknown) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery as never;
  }
}

interface Person {
  id: string;
  email: string;
  password: string;
  personal: string;
  browser: TestBrowser;
}

/**
 * Teams end to end: one connector address for the whole team, each member signs in to it as
 * themselves, and every account belongs to someone (a member or the team) and is shared on purpose.
 */
describe('teams: one connector address, everyone signs in as themselves', () => {
  let hub: TestHub;
  let teamUrl: string;
  let teamId: string;
  const people: Record<'ann' | 'bob' | 'carol', Person> = {} as never;
  const slug = 'acme-sales';
  const teamPage = `/app/team/${slug}`;
  /** Bob's AI app's sign-in to the team (OAuth access token). */
  let bobToken = '';

  const as = (who: Person, extra: Partial<Principal> = {}): Principal => ({
    kind: 'api_token',
    userId: who.id,
    workspaceId: teamId,
    scopes: ['mcp'],
    ...extra,
  });
  const catalogOf = (principal: Principal) => hub.services.hub.getCatalog(principal);
  const call = async (principal: Principal, tool: string, args: Record<string, unknown> = {}) =>
    hub.services.hub.callTool(principal, await catalogOf(principal), tool, args);
  const json = (result: ToolCallResult): any =>
    result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text);
  const text = (result: ToolCallResult) => (result.content[0] as { text: string }).text;
  /** The account names a tool offers in its `account` argument. */
  const accountChoices = async (principal: Principal, tool: string): Promise<string[]> => {
    const found = (await catalogOf(principal)).tools.find((t) => t.name === tool);
    const property = (found?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)
      ?.account;
    return property?.enum ?? [];
  };
  const csrf = async (who: Person) =>
    TestBrowser.hiddenInputs(await (await who.browser.request('/app/teams')).text()).csrf!;
  const post = async (who: Person, path: string, form: Record<string, string> = {}) =>
    who.browser.request(path, { form: { csrf: await csrf(who), ...form } });
  const approveOpen = async (who: Person, action: string) => {
    const row = (await hub.services.pendingCalls.listOpenFor(who.id)).find((r) => r.action === action);
    expect(row, `a held ${action} call for ${who.email}`).toBeDefined();
    await hub.services.pendingCalls.decide(row!.id, true, 'web');
    await hub.services.pendingRunner.tick();
    expect((await hub.services.pendingCalls.get(row!.id))?.status).toBe('succeeded');
  };
  const rpc = (url: string, token: string | undefined, body: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const connectWithToken = async (url: string, token: string) => {
    const client = new Client({ name: 'team-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const accountByName = async (workspaceId: string, name: string) =>
    hub.services.accounts.findByName(workspaceId, 'notes', name);

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      connectors: new ConnectorRegistry().register(demo).register(notes),
      seed: false,
      env: { BILLING_PROVIDER: 'test', CONFIRMATION_WAIT_SECONDS: '0' },
    });
    teamUrl = `${hub.mcpUrl}/team/${slug}`;
    const db = hub.services.db;
    await db.update(users).set({ name: 'Ann Lee' }).where(eq(users.email, ADMIN.email));
    const annUser = (await db.query.users.findFirst({ where: eq(users.email, ADMIN.email) }))!;
    const annHome = (await db.query.workspaceMembers.findFirst({
      where: (m, { eq: is }) => is(m.userId, annUser.id),
    }))!;
    people.ann = {
      id: annUser.id,
      email: ADMIN.email,
      password: ADMIN.password,
      personal: annHome.workspaceId,
      browser: new TestBrowser(hub.baseUrl),
    };
    for (const [key, name] of [
      ['bob', 'Bob Stone'],
      ['carol', 'Carol Diaz'],
    ] as const) {
      const email = `${key}@example.com`;
      const password = `${key}-correct-horse-battery`;
      const { user, workspace } = await createUser(db, { email, password, name });
      people[key] = {
        id: user.id,
        email,
        password,
        personal: workspace.id,
        browser: new TestBrowser(hub.baseUrl),
      };
    }
    for (const key of ['ann', 'carol'] as const) {
      const who = people[key];
      expect((await who.browser.login(who.email, who.password)).status).toBe(303);
    }
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('creates a team with its own connector address', async () => {
    const created = await post(people.ann, '/app/teams', { name: 'Acme Sales' });
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toBe(teamPage);
    const team = (await hub.services.teams.bySlug(slug))!;
    teamId = team.id;
    expect(team).toMatchObject({ kind: 'team', name: 'Acme Sales' });
    // The owner's own workspace stays theirs: an admin signing in again does not put the team on
    // the admin's unlimited plan, and the admin panel keeps showing the personal workspace.
    expect((await hub.services.users.ownedWorkspaces(people.ann.id)).map((w) => w.kind)).toEqual([
      'personal',
      'team',
    ]);
    expect((await hub.services.users.personalWorkspace(people.ann.id))?.id).toBe(people.ann.personal);
    expect((await new TestBrowser(hub.baseUrl).login()).status).toBe(303);
    expect((await hub.services.entitlements.entitlements(teamId)).plan.id).toBe('free');

    const list = await (await people.ann.browser.request('/app/teams')).text();
    expect(list).toContain(`href="${teamPage}"`);
    const page = await (await people.ann.browser.request(teamPage)).text();
    expect(page).toContain(teamUrl);
    expect(page).toContain(`claude mcp add --transport http manyplug-${slug} ${teamUrl}`);

    // The address is its own OAuth protected resource, so AI apps sign in to the team, not to /mcp.
    const meta = await fetch(`${hub.baseUrl}/.well-known/oauth-protected-resource/mcp/team/${slug}`);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({ resource: teamUrl, authorization_servers: [hub.baseUrl] });
    const anonymous = await rpc(teamUrl, undefined, listTools);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain(
      `resource_metadata="${hub.baseUrl}/.well-known/oauth-protected-resource/mcp/team/${slug}"`,
    );
    // Not a team address at all; an unknown team looks like any other (no hint whether it exists).
    expect((await rpc(`${hub.mcpUrl}/team/x`, undefined, listTools)).status).toBe(404);
    expect((await rpc(`${hub.mcpUrl}/team/no-such-team`, undefined, listTools)).status).toBe(401);
  });

  it('lets only the invited address join, once', async () => {
    const invited = await post(people.ann, `${teamPage}/invite`, {
      email: 'Bob@Example.com',
      role: 'member',
    });
    expect(invited.status).toBe(200);
    const link = (await invited.text()).match(/https?:\/\/[^"<\s]+\/invite\/ac_inv_[A-Za-z0-9_-]+/)?.[0];
    expect(link).toBeDefined();
    const path = new URL(link!).pathname;

    // Someone else who got the link cannot use it.
    const carolSees = await people.carol.browser.request(path);
    expect(await carolSees.text()).toContain('Приглашение адресовано bob@example.com');
    const carolTries = await post(people.carol, path);
    expect(carolTries.status).toBe(403);

    // Bob signs in from the link and joins.
    const bob = people.bob;
    const signedOut = await bob.browser.request(path);
    expect(await signedOut.text()).toContain('Войти, чтобы принять');
    expect((await bob.browser.login(bob.email, bob.password, path)).status).toBe(303);
    const joined = await post(bob, path);
    expect(joined.status).toBe(303);
    expect(joined.headers.get('location')).toBe(teamPage);
    expect((await bob.browser.request(teamPage)).status).toBe(200);

    // The link is used up; people outside the team do not see its page.
    const again = await bob.browser.request(path);
    expect(again.status).toBe(404);
    expect(await again.text()).toContain('Эта ссылка-приглашение не работает');
    expect((await people.carol.browser.request(teamPage)).status).toBe(404);

    const members = await hub.services.teams.members(teamId);
    expect(members.map((m) => [m.handle, m.role])).toEqual([
      ['ann', 'owner'],
      ['bob', 'member'],
    ]);
  });

  it('keeps each member’s accounts their own and team accounts for everyone', async () => {
    const { accounts } = hub.services;
    const annNotes = await accounts.create(
      teamId,
      { connectorId: 'notes', label: 'Notes' },
      { userId: people.ann.id },
    );
    const bobNotes = await accounts.create(
      teamId,
      { connectorId: 'notes', label: 'Notes' },
      { userId: people.bob.id },
    );
    const shared = await accounts.create(
      teamId,
      { connectorId: 'notes', label: 'Sales notes' },
      { userId: null },
    );
    // Named after their owner, so "Ann's notes" is easy to say.
    expect([annNotes.name, bobNotes.name, shared.name]).toEqual(['ann', 'bob', 'sales_notes']);
    await expect(accounts.create(teamId, { connectorId: 'notes', label: 'Whose?' })).rejects.toThrow(
      /whose account/i,
    );

    const bob = as(people.bob);
    expect(await accountChoices(bob, 'notes_read')).toEqual(['bob', 'sales_notes', 'all', 'mine']);
    const catalog = await catalogOf(bob);
    expect(catalog.instructions).toContain('you act for Bob Stone');
    expect(catalog.instructions).toContain('"bob" — Notes (yours)');
    expect(catalog.instructions).toContain('"sales_notes" — Sales notes (team account)');
    expect(catalog.instructions).not.toContain('"ann"');

    expect(json(await call(bob, 'notes_read', { account: 'mine' }))).toMatchObject({ notebook: 'bob' });
    expect(json(await call(bob, 'notes_add', { account: 'sales_notes', text: 'Q4 plan' }))).toMatchObject({
      notebook: 'sales_notes',
    });
    const peek = await call(bob, 'notes_read', { account: 'ann' });
    expect(peek.isError).toBe(true);

    // Running the team is not reading its members' notes: the owner does not see Bob's account.
    expect(await accountChoices(as(people.ann), 'notes_read')).toEqual(['ann', 'sales_notes', 'all', 'mine']);
    const overview = json(await call(as(people.ann), 'manyplug_team'));
    expect(overview.accounts.map((a: { account: string }) => a.account)).toEqual([
      'notes:ann',
      'notes:sales_notes',
    ]);
  });

  it('shares an account only once its owner confirms, and stops sharing at once', async () => {
    // A new principal per step, like one MCP request each.
    const ann = () => as(people.ann);
    const bob = () => as(people.bob);
    const held = await call(bob(), 'manyplug_share_account', {
      account: 'notes:bob',
      with: 'ann',
      access: 'read',
    });
    expect(text(held)).toContain('/confirm/');
    expect(await accountChoices(ann(), 'notes_read')).not.toContain('bob');
    // Bob decides about his own account; Ann has nothing to confirm.
    expect(await hub.services.pendingCalls.listOpenFor(people.ann.id)).toEqual([]);
    await approveOpen(people.bob, 'share_account');

    expect(await accountChoices(ann(), 'notes_read')).toContain('bob');
    expect((await catalogOf(ann())).instructions).toContain('Bob Stone’s, shared with you: read only');
    expect(json(await call(ann(), 'notes_read', { account: 'bob' }))).toMatchObject({ notebook: 'bob' });
    // Read only: writing to it is not offered and not allowed.
    expect(await accountChoices(ann(), 'notes_add')).not.toContain('bob');
    expect((await call(ann(), 'notes_add', { account: 'bob', text: 'hi' })).isError).toBe(true);
    // Only the owner shares an account, even with the owner of the team.
    const reshare = await call(ann(), 'manyplug_share_account', {
      account: 'notes:bob',
      with: 'team',
      access: 'full',
    });
    expect(reshare.isError).toBe(true);

    // Narrowing needs no confirmation.
    const stopped = await call(bob(), 'manyplug_share_account', {
      account: 'notes:bob',
      with: 'ann',
      access: null,
    });
    expect(json(stopped)).toMatchObject({ stopped_sharing: 'notes:bob' });
    expect(await accountChoices(ann(), 'notes_read')).not.toContain('bob');
  });

  it('gives the shared connection only what the whole team may use, and no say in the setup', async () => {
    const bobNotes = (await accountByName(teamId, 'bob'))!;
    await hub.services.teams.share(people.bob.id, teamId, bobNotes.id, null, 'read');

    const created = await post(people.ann, `${teamPage}/keys`, { name: 'Office bot' });
    expect(created.status).toBe(200);
    const key = (await created.text()).match(/ac_pat_[A-Za-z0-9_-]+/)?.[0];
    expect(key).toBeDefined();
    // Members cannot make one.
    expect((await post(people.bob, `${teamPage}/keys`, { name: 'Mine' })).headers.get('location')).toBe(
      teamPage,
    );
    expect((await hub.services.apiTokens.list(teamId)).filter((k) => k.shared)).toHaveLength(1);

    const client = await connectWithToken(teamUrl, key!);
    expect(client.getInstructions()).toContain('shared connection of the team "Acme Sales"');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['notes_read', 'manyplug_team']));
    for (const hidden of ['manyplug_connect_account', 'manyplug_share_account', 'manyplug_invite_member']) {
      expect(names).not.toContain(hidden);
    }
    const read = await client.callTool({ name: 'notes_read', arguments: { account: 'all' } });
    const notebooks = JSON.stringify(read.structuredContent ?? read.content);
    expect(notebooks).toContain('sales_notes');
    expect(notebooks).toContain('bob'); // shared with the whole team
    expect(notebooks).not.toContain('"ann"');
    await client.close();

    // The key works on the team's address only, and a personal key does not open the team.
    expect((await rpc(hub.mcpUrl, key, listTools)).status).toBe(401);
    const personal = await hub.services.apiTokens.create({
      workspaceId: people.ann.personal,
      userId: people.ann.id,
      name: 'personal',
    });
    expect((await rpc(teamUrl, personal.token, listTools)).status).toBe(401);
    expect((await rpc(hub.mcpUrl, personal.token, listTools)).status).toBe(200);
    await hub.services.teams.share(people.bob.id, teamId, bobNotes.id, null, null);
  });

  it('signs a member in to the team address over OAuth and turns others away', async () => {
    const start = async () => {
      const app = new AppClient();
      const transport = new StreamableHTTPClientTransport(new URL(teamUrl), { authProvider: app });
      await expect(new Client({ name: 'probe', version: '1' }).connect(transport)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
      expect(app.authorizationUrl?.searchParams.get('resource')).toBe(teamUrl);
      return { app, transport };
    };

    // Carol is not in the team: no consent page, a way in instead.
    const outsider = await start();
    const refused = await people.carol.browser.request(outsider.app.authorizationUrl!.toString());
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('Это адрес коннектора команды, в которой вы не состоите');

    const { app, transport } = await start();
    const consent = await people.bob.browser.request(app.authorizationUrl!.toString());
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain('Acme Sales');
    expect(html).toContain('Коллеги не видят ваши аккаунты, пока вы ими не поделитесь.');
    const decided = await people.bob.browser.request('/oauth/authorize', {
      form: { ...TestBrowser.hiddenInputs(html), decision: 'approve' },
    });
    expect(decided.status).toBe(303);
    await transport.finishAuth(new URL(decided.headers.get('location')!).searchParams);

    const client = new Client({ name: 'bob-app', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(teamUrl), { authProvider: app }));
    expect(client.getInstructions()).toContain('you act for Bob Stone');
    // What makes a team work is listed, not left to search; what only admins may do is not offered.
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).toEqual(
      expect.arrayContaining(['manyplug_team', 'manyplug_share_account', 'manyplug_connect_account']),
    );
    for (const hidden of ['manyplug_invite_member', 'manyplug_access_profiles', 'manyplug_rename_app'])
      expect(listed).not.toContain(hidden);
    const mine = await client.callTool({ name: 'notes_read', arguments: { account: 'mine' } });
    expect(mine.structuredContent ?? JSON.parse((mine.content as { text: string }[])[0]!.text)).toMatchObject(
      {
        notebook: 'bob',
      },
    );
    await client.close();

    const [grant] = await hub.services.db
      .select()
      .from(oauthGrants)
      .where(and(eq(oauthGrants.userId, people.bob.id), eq(oauthGrants.workspaceId, teamId)));
    expect(grant).toBeDefined();
    // Bob's team token is not a key to his personal space.
    expect((await rpc(hub.mcpUrl, app.saved!.access_token, listTools)).status).toBe(401);
    bobToken = app.saved!.access_token;
  });

  it('links from the chat connect accounts into the team, as the member’s or (admins) the team’s', async () => {
    const bob = as(people.bob);
    const link = json(await call(bob, 'manyplug_connect_account', { service: 'demo', label: 'Bob demo' }));
    const url = new URL(link.url);
    expect(url.searchParams.get('team')).toBe(slug);
    expect(url.searchParams.get('returnTo')).toBe(teamPage);
    expect(url.searchParams.get('owner')).toBeNull();
    expect((await call(bob, 'manyplug_connect_account', { service: 'demo', for_team: true })).isError).toBe(
      true,
    );
    const teamLink = json(
      await call(as(people.ann), 'manyplug_connect_account', { service: 'demo', for_team: true }),
    );
    expect(new URL(teamLink.url).searchParams.get('owner')).toBe('team');

    // Bob follows his link and the account lands in the team as his.
    const form = await people.bob.browser.request(url.pathname + url.search);
    expect(form.status).toBe(200);
    const done = await people.bob.browser.request(url.pathname, {
      form: {
        ...TestBrowser.hiddenInputs(await form.text()),
        label: 'Bob demo',
        'config.greeting': 'Hi',
        'credentials.secret': 's3cret',
      },
    });
    expect(done.status).toBe(200);
    const created = (await hub.services.accounts.list(teamId)).find((a) => a.label === 'Bob demo');
    expect(created).toMatchObject({ connectorId: 'demo', ownerUserId: people.bob.id, name: 'bob' });
    // Bob cannot make a team account by editing the link.
    const forged = await people.bob.browser.request(`/connect/demo?team=${slug}&owner=team`);
    expect(forged.status).toBe(403);
  });

  it('tells only whoever manages an account that its sign-in expired', async () => {
    const { accounts, db, connectors, admin, logger } = hub.services;
    const bob = as(people.bob);
    const notebook = async (name: string) => (await accountByName(teamId, name))!;
    // In the chat: Bob gets the link for his own notebook, and is told who signs in the team's.
    const own = text(await call(bob, 'notes_sync', { account: 'bob' }));
    expect(own).toContain('the user has to sign in again, here: ');
    const link = new URL(own.match(/here: (\S+)\. Tell/)![1]!);
    expect(link.pathname).toBe('/connect/notes');
    expect([link.searchParams.get('team'), link.searchParams.get('account')]).toEqual([
      slug,
      (await notebook('bob')).id,
    ]);
    const shared = text(await call(bob, 'notes_sync', { account: 'sales_notes' }));
    expect(shared).toContain('whoever manages the account has to sign in again');
    expect(shared).not.toContain('/connect/');
    for (const name of ['bob', 'sales_notes'])
      await accounts.markStatus((await notebook(name)).id, 'active', null);

    // Outside the chat: each person hears about what they can fix, and only that.
    const bobDemo = (await accounts.list(teamId)).find((a) => a.label === 'Bob demo')!;
    const officeDemo = await accounts.create(
      teamId,
      { connectorId: 'demo', label: 'Office demo', config: { greeting: 'Hi' }, credentials: { secret: 'x' } },
      { userId: null },
    );
    const sent: Record<string, { account: string; url: string }[]> = {};
    const alerts = new AccountAlerts({
      db,
      connectors,
      logger,
      notifier: {
        notify: async (userId, notice) => {
          sent[userId] = notice.accounts.map(({ account, url }) => ({ account, url }));
          return 'sent';
        },
      },
      reconnectUrl: (workspaceId, _service, accountId) => admin.reconnectUrl(workspaceId, accountId),
    });
    for (const account of [bobDemo, officeDemo])
      await accounts.markStatus(account.id, 'needs_reauth', 'Token expired');
    expect(await alerts.notifyReauth()).toEqual({ notified: 2, waiting: 0 });
    expect(Object.keys(sent).sort()).toEqual([people.ann.id, people.bob.id].sort());
    expect(sent[people.bob.id]!.map((a) => a.account)).toEqual(['Bob demo']);
    expect(sent[people.ann.id]!.map((a) => a.account)).toEqual(['Office demo']);
    const fix = new URL(sent[people.bob.id]![0]!.url);
    expect(fix.pathname).toBe('/connect/demo');
    expect([fix.searchParams.get('team'), fix.searchParams.get('account')]).toEqual([slug, bobDemo.id]);
    await accounts.markStatus(bobDemo.id, 'active', null);
    await accounts.delete(teamId, officeDemo.id);
  });

  it('counts seats: three during the trial, then the seats the team pays for', async () => {
    const { teams, entitlements, billing } = hub.services;
    expect((await entitlements.entitlements(teamId)).limits.seats).toBe(3);
    const carolInvite = await teams.invite(people.ann.id, teamId, { email: people.carol.email });
    await expect(teams.invite(people.ann.id, teamId, { email: 'dave@example.com' })).rejects.toMatchObject({
      code: 'plan_limit',
    });
    await teams.revokeInvitation(people.ann.id, teamId, carolInvite.invitation.id);
    await teams.invite(people.ann.id, teamId, { email: 'dave@example.com' });

    // After the trial the free plan has one seat: the owner's. Bob is told why instead of removed.
    await hub.services.db
      .update(workspaces)
      .set({ createdAt: new Date(Date.now() - 90 * 86_400_000) })
      .where(eq(workspaces.id, teamId));
    const blocked = await call(as(people.bob), 'notes_read', { account: 'mine' });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain('seat');
    expect((await call(as(people.ann), 'notes_read', { account: 'mine' })).isError).toBeFalsy();
    expect((await call(as(people.bob), 'manyplug_team')).isError).toBeFalsy();
    // The shared connection takes no seat.
    expect(
      (await call(as(people.ann, { shared: true }), 'notes_read', { account: 'sales_notes' })).isError,
    ).toBeFalsy();

    // The owner buys five seats on the team page.
    const start = await post(people.ann, `${teamPage}/plan`, { seats: '5', interval: 'month' });
    expect(start.status).toBe(303);
    const checkout = new URL(start.headers.get('location')!);
    expect(checkout.pathname).toBe('/billing/test/checkout');
    const pay = await people.ann.browser.request(checkout.pathname + checkout.search);
    const paid = await people.ann.browser.request('/billing/test/checkout', {
      form: TestBrowser.hiddenInputs(await pay.text()),
    });
    expect(paid.headers.get('location')).toContain(`${teamPage}?paid=1`);
    const ent = await entitlements.entitlements(teamId);
    expect(ent.plan.id).toBe('team');
    expect(ent.subscription?.quantity).toBe(5);
    expect(ent.limits).toMatchObject({ seats: 5, actions: 125_000, messengers: 10 });
    expect((await call(as(people.bob), 'notes_read', { account: 'mine' })).isError).toBeFalsy();

    // Personal plans are not for teams, the Team plan not for a person, and never fewer than 2 seats.
    const base = {
      userId: people.ann.id,
      email: people.ann.email,
      interval: 'month' as const,
      successUrl: hub.baseUrl,
      cancelUrl: hub.baseUrl,
    };
    await expect(billing.checkout({ ...base, workspaceId: teamId, planId: 'pro' })).rejects.toMatchObject({
      code: 'plan_mismatch',
    });
    await expect(
      billing.checkout({ ...base, workspaceId: people.bob.personal, planId: 'team' }),
    ).rejects.toMatchObject({ code: 'plan_mismatch' });
    await expect(
      billing.checkout({ ...base, workspaceId: teamId, planId: 'team', seats: 1 }),
    ).rejects.toMatchObject({ code: 'bad_seats' });
    // The AI sees prices per person and the team's seats.
    const plan = json(await call(as(people.ann), 'manyplug_plan'));
    expect(plan.usage.seats).toBe(5);
    expect(plan.subscription.seats).toBe(5);
    expect(plan.plans.map((p: { id: string }) => p.id)).toEqual(['free', 'team']);
    expect(plan.plans[1]).toMatchObject({ usd_per_month: 10, priced: 'per person', people: '2-200' });
  });

  it('runs the team by role: admins invite, only the owner promotes, members leave on their own', async () => {
    const { teams } = hub.services;
    // Bob is a member: the AI is not offered what only admins may do, and the service refuses it too.
    const bobTools = (await catalogOf(as(people.bob))).tools.map((t) => t.name);
    expect(bobTools).toContain('manyplug_share_account');
    for (const name of ['manyplug_invite_member', 'manyplug_remove_member', 'manyplug_cancel_plan']) {
      expect(bobTools).not.toContain(name);
    }
    await expect(teams.invite(people.bob.id, teamId, { email: 'erin@example.com' })).rejects.toMatchObject({
      code: 'team_admin_only',
    });
    expect((await catalogOf(as(people.ann))).tools.map((t) => t.name)).toContain('manyplug_invite_member');

    // Carol joins as an admin and connects her own notes; the owner stays whatever she tries.
    const { url } = await teams.invite(people.ann.id, teamId, { email: people.carol.email, role: 'admin' });
    const token = new URL(url).pathname.split('/').at(-1)!;
    await teams.accept(token, { id: people.carol.id, email: people.carol.email, name: 'Carol Diaz' });
    await expect(teams.setRole(people.carol.id, teamId, people.bob.id, 'admin')).rejects.toMatchObject({
      code: 'team_owner_only',
    });
    await expect(teams.removeMember(people.carol.id, teamId, people.ann.id)).rejects.toMatchObject({
      code: 'team_owner_stays',
    });
    await expect(teams.leave(people.ann.id, teamId)).rejects.toMatchObject({ code: 'team_owner_stays' });
    await hub.services.accounts.create(
      teamId,
      { connectorId: 'notes', label: 'Notes' },
      { userId: people.carol.id },
    );
    // A new member works at once, even right after others filled the seat list cache.
    expect(json(await call(as(people.carol), 'notes_read', { account: 'mine' }))).toMatchObject({
      notebook: 'carol',
    });

    // She leaves from the team page and takes her notes home.
    const left = await post(people.carol, `${teamPage}/leave`);
    expect(left.headers.get('location')).toBe('/app/teams');
    const home = await hub.services.accounts.list(people.carol.personal);
    expect(home.map((a) => [a.name, a.ownerUserId])).toEqual([['carol', people.carol.id]]);
    expect((await teams.members(teamId)).map((m) => m.handle)).toEqual(['ann', 'bob']);
  });

  it('takes a member’s accounts home when they are removed and cuts their apps off', async () => {
    const before = (await hub.services.accounts.ownedBy(teamId, people.bob.id)).map((a) => a.label);
    expect(before.sort()).toEqual(['Bob demo', 'Notes']);
    const bobNotes = (await accountByName(teamId, 'bob'))!;
    await hub.services.teams.share(people.bob.id, teamId, bobNotes.id, people.ann.id, 'write');

    const removed = await post(people.ann, `${teamPage}/members/${people.bob.id}/remove`);
    expect(removed.status).toBe(303);
    expect(await hub.services.teams.members(teamId)).toHaveLength(1);
    expect(await hub.services.accounts.ownedBy(teamId, people.bob.id)).toEqual([]);
    const home = await hub.services.accounts.list(people.bob.personal);
    expect(home.map((a) => [a.label, a.ownerUserId])).toEqual(
      expect.arrayContaining([
        ['Notes', people.bob.id],
        ['Bob demo', people.bob.id],
      ]),
    );
    expect(
      await hub.services.db.select().from(accountShares).where(eq(accountShares.accountId, bobNotes.id)),
    ).toEqual([]);
    // His app's sign-in to the team stops working; the team page is gone for him.
    expect((await rpc(teamUrl, bobToken, listTools)).status).toBe(401);
    expect((await people.bob.browser.request(teamPage)).status).toBe(404);
    // The moved accounts work in Bob's own space.
    const own: Principal = {
      kind: 'api_token',
      userId: people.bob.id,
      workspaceId: people.bob.personal,
      scopes: ['mcp'],
    };
    expect(json(await call(own, 'notes_read', { account: 'bob' }))).toMatchObject({ notebook: 'bob' });
  });

  it('keeps the management API and persona names out of the way of teams', async () => {
    const { token } = await hub.services.apiTokens.create({
      workspaceId: teamId,
      userId: people.ann.id,
      name: 'api',
      scopes: ['mcp', 'api'],
    });
    const response = await fetch(`${hub.baseUrl}/api/v1/accounts`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'team_api_unsupported' } });
    await expect(
      hub.services.personas.create(people.ann.personal, { slug: 'team', name: 'Team' }),
    ).rejects.toThrow();
  });

  it('deletes a team: team accounts go, the owner keeps their own', async () => {
    const deleted = await post(people.ann, `${teamPage}/delete`);
    expect(deleted.status).toBe(303);
    expect(await hub.services.teams.bySlug(slug)).toBeUndefined();
    const annHome = await hub.services.accounts.list(people.ann.personal);
    expect(annHome.map((a) => a.label)).toContain('Notes');
    expect(annHome.map((a) => a.label)).not.toContain('Sales notes');
  });
});
