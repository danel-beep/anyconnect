import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../src/core/identity.js';
import type { Principal } from '../src/core/principal.js';
import {
  accounts,
  aiClients,
  apiTokens,
  personas,
  triggers,
  users,
  webSessions,
  workspaceMembers,
  workspaces,
} from '../src/db/schema.js';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/**
 * One user must never see or change what belongs to another. Instead of a list of known pages, this
 * walks every route the app has: each path that takes an id is called by Mallory with every id of
 * Alice's things in it, signed in on the site and with an API token. Nothing of Alice's may show
 * up in an answer, and nothing of hers may change. A new route is covered the day it is added.
 */
describe('tenant isolation', () => {
  /** In the name of everything Alice owns, so a leak is easy to spot in any answer. */
  const MARK = 'ALICE-ONLY-7Q4Z';
  let hub: TestHub;
  let mallory: TestBrowser;
  let malloryToken: string;
  let alice: { userId: string; workspaceId: string };
  let aliceIds: string[];

  /** Everything of Alice's that a stranger could try to touch, as stored. */
  async function aliceState(): Promise<string> {
    const { db } = hub.services;
    const w = alice.workspaceId;
    const rows = await Promise.all([
      db.select().from(users).where(eq(users.id, alice.userId)),
      db.select().from(workspaces).where(eq(workspaces.id, w)),
      db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, w)),
      db.select().from(accounts).where(eq(accounts.workspaceId, w)).orderBy(accounts.id),
      db.select().from(apiTokens).where(eq(apiTokens.workspaceId, w)).orderBy(apiTokens.id),
      db.select().from(personas).where(eq(personas.workspaceId, w)).orderBy(personas.id),
      db.select().from(aiClients).where(eq(aiClients.workspaceId, w)).orderBy(aiClients.id),
      db.select().from(triggers).where(eq(triggers.workspaceId, w)).orderBy(triggers.id),
      db.select({ id: webSessions.tokenHash }).from(webSessions).where(eq(webSessions.userId, alice.userId)),
    ]);
    return JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? String(value) : value));
  }

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub();
    const s = hub.services;
    const owner = (await s.db.query.users.findFirst({ where: eq(users.email, ADMIN.email) }))!;
    // The hub's first user is an administrator; Alice and Mallory are ordinary users.
    await s.db.update(users).set({ role: 'user' }).where(eq(users.id, owner.id));
    const created = await createUser(s.db, {
      email: 'alice@example.com',
      password: 'alice-correct-horse-battery',
      name: `Alice ${MARK}`,
    });
    alice = { userId: created.user.id, workspaceId: created.workspace.id };
    const principal: Principal = {
      kind: 'session',
      userId: alice.userId,
      workspaceId: alice.workspaceId,
      scopes: ['mcp', 'api'],
    };
    const account = await s.accounts.create(alice.workspaceId, {
      connectorId: 'demo',
      name: 'private',
      label: `Private ${MARK}`,
      credentials: { secret: `secret-${MARK}` },
    });
    const persona = await s.personas.create(alice.workspaceId, {
      slug: 'alice-only',
      name: `Profile ${MARK}`,
    });
    const client = await s.aiClients.createUnique(alice.workspaceId, `App ${MARK}`, 'api_token');
    const token = await s.apiTokens.create({
      workspaceId: alice.workspaceId,
      userId: alice.userId,
      name: `Token ${MARK}`,
      scopes: ['mcp', 'api'],
      aiClientId: client.id,
    });
    const trigger = await s.triggers.service.create(principal, {
      name: `Rule ${MARK}`,
      when: 'message',
      do: 'notify',
    });
    const tokenRow = (await s.db.query.apiTokens.findFirst({
      where: eq(apiTokens.workspaceId, alice.workspaceId),
    }))!;
    expect(token.token).toBeTruthy();
    aliceIds = [
      alice.userId,
      alice.workspaceId,
      account.id,
      account.name,
      persona.id,
      persona.slug,
      client.id,
      tokenRow.id,
      trigger.id,
    ];

    // Mallory: the hub's own first user, signed in, with an API token of their own.
    mallory = new TestBrowser(hub.baseUrl);
    expect((await mallory.login()).status).toBe(303);
    const home = (await s.users.personalWorkspace(owner.id))!;
    ({ token: malloryToken } = await s.apiTokens.create({
      workspaceId: home.id,
      userId: owner.id,
      name: 'mallory',
      scopes: ['mcp', 'api'],
    }));
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('never shows or changes another user’s things, on any route that takes an id', async () => {
    const before = await aliceState();
    const csrf = TestBrowser.hiddenInputs(await (await mallory.request('/security')).text()).csrf!;
    // Signing Mallory out mid-walk would turn the rest of the walk into a test of the login page.
    const skip = new Set(['POST /logout']);
    const routes = new Map<string, { method: string; path: string }>();
    for (const route of hub.app.routes) {
      if (route.method === 'ALL' || route.path.includes('*') || !route.path.includes(':')) continue;
      if (skip.has(`${route.method} ${route.path}`)) continue;
      routes.set(`${route.method} ${route.path}`, { method: route.method, path: route.path });
    }
    // The walk means something only if it reaches the places where ids are used.
    expect(routes.size).toBeGreaterThan(60);
    for (const expected of [
      'GET /app/accounts/:id',
      'POST /app/tokens/:id/revoke',
      'DELETE /api/v1/accounts/:id',
    ]) {
      expect([...routes.keys()], expected).toContain(expected);
    }

    const leaks: string[] = [];
    const statuses = new Map<number, number>();
    let calls = 0;
    for (const { method, path } of routes.values()) {
      for (const id of aliceIds) {
        const url = path.replace(/:[A-Za-z]+(\{[^}]*\})?\??/g, encodeURIComponent(id));
        const attempts: Promise<Response>[] = [];
        if (method === 'GET') {
          attempts.push(mallory.request(url));
        } else {
          attempts.push(mallory.request(url, { method, form: { csrf } }));
        }
        if (url.startsWith('/api/')) {
          attempts.push(
            fetch(`${hub.baseUrl}${url}`, {
              method,
              headers: { authorization: `Bearer ${malloryToken}`, 'content-type': 'application/json' },
              ...(method === 'GET' ? {} : { body: '{}' }),
            }),
          );
        }
        for (const response of await Promise.all(attempts)) {
          calls++;
          statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
          const body = await response.text();
          if (body.includes(MARK)) leaks.push(`${method} ${url} → ${response.status}`);
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(calls).toBeGreaterThan(500);
    // Refusals, not errors: a 5xx would mean a route broke on a foreign id instead of checking it.
    expect([...statuses.keys()].filter((status) => status >= 500)).toEqual([]);
    expect(await aliceState()).toBe(before);
  }, 120_000);

  it('is not blind: the same pages do show these things to their owner', async () => {
    const own = new TestBrowser(hub.baseUrl);
    expect((await own.login('alice@example.com', 'alice-correct-horse-battery')).status).toBe(303);
    const [accountId] = aliceIds.filter((id) => id.startsWith('acc_'));
    expect(accountId).toBeDefined();
    expect(await (await own.request(`/app/accounts/${accountId}`)).text()).toContain(MARK);
    expect(await (await own.request('/app/apps')).text()).toContain(MARK);
  });

  it('does not list another user’s things on pages without an id either', async () => {
    const pages = [...new Set(hub.app.routes.filter((r) => r.method === 'GET').map((r) => r.path))].filter(
      (path) =>
        !path.includes(':') && !path.includes('*') && (path.startsWith('/app') || path.startsWith('/api/')),
    );
    expect(pages.length).toBeGreaterThan(15);
    for (const path of pages) {
      const viaSite = await (await mallory.request(path)).text();
      expect(viaSite.includes(MARK), `GET ${path}`).toBe(false);
      if (path.startsWith('/api/')) {
        const viaToken = await fetch(`${hub.baseUrl}${path}`, {
          headers: { authorization: `Bearer ${malloryToken}` },
        });
        expect((await viaToken.text()).includes(MARK), `GET ${path} with a token`).toBe(false);
      }
    }
  });
});
