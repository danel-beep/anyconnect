import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { defineConnector } from '../src/connectors/sdk.js';
import { createUser } from '../src/core/identity.js';
import type { Principal } from '../src/core/principal.js';
import { MAX_TEAM_MEMBERS } from '../src/core/teams.js';
import { workspaceInvitations, workspaces } from '../src/db/schema.js';
import type { ToolCallResult } from '../src/hub/result.js';
import { hashToken } from '../src/lib/crypto.js';
import { newId } from '../src/lib/ids.js';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/** A notebook per account: one read action, enough to see whose plan a call is charged to. */
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
  ],
});

interface Person {
  id: string;
  name: string;
  email: string;
  password: string;
  personal: string;
  browser: TestBrowser;
}

const DAY = 86_400_000;

/**
 * How teams pay (`docs/TEAMS.md`, «Оплата»): there is no team plan. A team runs on the plan of its
 * payer (the owner, unless a member took over), whose limits cover their own space and the team
 * together; in "each" mode every member's use counts against their own plan. One trial per person.
 */
describe('team billing: a team runs on the plan of whoever pays for it', () => {
  let hub: TestHub;
  let teamId = '';
  let slug = '';
  let teamPage = '';
  const people: Record<'ann' | 'bob' | 'cy' | 'dana', Person> = {} as never;

  const as = (who: Person, extra: Partial<Principal> = {}): Principal => ({
    kind: 'api_token',
    userId: who.id,
    workspaceId: teamId,
    scopes: ['mcp'],
    ...extra,
  });
  const call = async (principal: Principal, tool: string, args: Record<string, unknown> = {}) =>
    hub.services.hub.callTool(principal, await hub.services.hub.getCatalog(principal), tool, args);
  const json = (result: ToolCallResult): any =>
    result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text);
  const page = async (who: Person, path: string) => (await who.browser.request(path)).text();
  const post = async (who: Person, path: string, form: Record<string, string> = {}) => {
    const csrf = TestBrowser.hiddenInputs(await page(who, '/app/teams')).csrf!;
    return who.browser.request(path, { form: { csrf, ...form } });
  };
  /** Actions charged to a person's plan for this team so far. */
  const chargedInTeam = async (payer: Person) =>
    (await hub.services.usage.billedByWorkspace(payer.personal, '2000-01-01')).find(
      (r) => r.workspaceId === teamId,
    )?.calls ?? 0;
  /** The change in what each person's plan was charged for the team while `run` ran. */
  const charges = async (run: () => Promise<unknown>) => {
    const keys = ['ann', 'bob', 'cy'] as const;
    const before = await Promise.all(keys.map((k) => chargedInTeam(people[k])));
    await run();
    const after = await Promise.all(keys.map((k) => chargedInTeam(people[k])));
    return Object.fromEntries(keys.map((k, i) => [k, after[i]! - before[i]!]));
  };
  const readMine = async (who: Person) => {
    const result = await call(as(who), 'notes_read', { account: 'mine' });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  };
  const join = async (who: Person) => {
    const { url } = await hub.services.teams.invite(people.ann.id, teamId, { email: who.email });
    const token = new URL(url).pathname.split('/').at(-1)!;
    await hub.services.teams.accept(token, { id: who.id, email: who.email, name: who.name });
  };
  const approveOpen = async (who: Person, action: string) => {
    const row = (await hub.services.pendingCalls.listOpenFor(who.id)).find((r) => r.action === action);
    expect(row, `a held ${action} call`).toBeDefined();
    await hub.services.pendingCalls.decide(row!.id, true, 'web');
    await hub.services.pendingRunner.tick();
    expect((await hub.services.pendingCalls.get(row!.id))?.status).toBe('succeeded');
  };

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      connectors: new ConnectorRegistry().register(notes),
      seed: false,
      env: { BILLING_PROVIDER: 'test', CONFIRMATION_WAIT_SECONDS: '0' },
    });
    const db = hub.services.db;
    for (const [key, name] of [
      ['ann', 'Ann Lee'],
      ['bob', 'Bob Stone'],
      ['cy', 'Cy Park'],
      ['dana', 'Dana Ruiz'],
    ] as const) {
      const email = `${key}@example.com`;
      const password = `${key}-correct-horse-battery`;
      const { user, workspace } = await createUser(db, { email, password, name });
      people[key] = {
        id: user.id,
        name,
        email,
        password,
        personal: workspace.id,
        browser: new TestBrowser(hub.baseUrl),
      };
      // Everyone but Dana signed up long ago: their trial and the steps after it are over.
      if (key !== 'dana') {
        await db
          .update(workspaces)
          .set({ createdAt: new Date(Date.now() - 90 * DAY) })
          .where(eq(workspaces.id, workspace.id));
      }
      expect((await people[key].browser.login(email, password)).status).toBe(303);
    }
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('runs a new team on its creator’s plan, from Free, with no trial of its own', async () => {
    const created = await post(people.ann, '/app/teams', { name: 'Acme' });
    expect(created.status).toBe(303);
    const [team] = await hub.services.teams.teamsOf(people.ann.id);
    teamId = team!.team.id;
    slug = team!.team.slug!;
    teamPage = `/app/team/${slug}`;
    // Created today, yet on Ann's free plan as it is after her trial: a team starts no trial.
    const ent = await hub.services.entitlements.entitlements(teamId);
    expect(ent).toMatchObject({ plan: { id: 'free' }, payerId: people.ann.personal, phase: undefined });
    expect(ent.limits).toMatchObject({ actions: 150, accounts: 3 });
    expect(await hub.services.entitlements.subscription(teamId)).toBeUndefined();

    // Dana is still in her trial: her team shares it (the same days and limits), it gets no new one.
    const danaTeam = await hub.services.teams.create(people.dana, 'Dana team');
    const [own, shared] = await Promise.all([
      hub.services.entitlements.entitlements(people.dana.personal),
      hub.services.entitlements.entitlements(danaTeam.id),
    ]);
    expect(own.phase?.kind).toBe('trial');
    expect(shared.phase).toEqual(own.phase);
    expect(shared.limits.actions).toBe(own.limits.actions);
    expect(shared.payerId).toBe(people.dana.personal);
  });

  it('charges everyone’s use of the team to the payer’s plan', async () => {
    await join(people.bob);
    await join(people.cy);
    await hub.services.accounts.create(
      teamId,
      { connectorId: 'notes', label: 'Bob' },
      { userId: people.bob.id },
    );
    expect(await charges(() => readMine(people.bob))).toEqual({ ann: 1, bob: 0, cy: 0 });
    // Bob's own plan was never touched.
    expect(await hub.services.usage.billedTotal(people.bob.personal, '2000-01-01')).toBe(0);
    // The team page and the chat say who pays, to every member.
    expect(await page(people.bob, teamPage)).toContain('Команду оплачивает Ann Lee, тариф «Бесплатный».');
    const plan = json(await call(as(people.bob), 'manyplug_plan'));
    expect(plan.team_billing).toMatchObject({
      mode: 'payer',
      paid_by: 'Ann Lee',
      plan: 'free',
      usage: { actions_this_month: 1, actions_limit: 150 },
      actions_in_this_team_this_month: 1,
    });
    expect(plan.your_plan).toMatchObject({ plan: 'free', pays_for_your_use_here: false });
  });

  it('pools the plan’s accounts across the payer’s own space and the team', async () => {
    const { accounts } = hub.services;
    await accounts.create(
      people.ann.personal,
      { connectorId: 'notes', label: 'Ann' },
      { userId: people.ann.id },
    );
    await accounts.create(teamId, { connectorId: 'notes', label: 'Office' }, { userId: null });
    // Ann's free plan allows 3: her own notes, Bob's and the office's in the team use them up.
    expect(await hub.services.entitlements.accountsUsed(people.ann.personal)).toBe(3);
    await expect(
      accounts.create(teamId, { connectorId: 'notes', label: 'Cy' }, { userId: people.cy.id }),
    ).rejects.toMatchObject({ code: 'plan_limit', message: expect.stringContaining('Ann Lee') });
  });

  it('lets a member pay for the team with a plan that gives it at least as much', async () => {
    const { entitlements } = hub.services;
    await entitlements.setPlan(people.ann.personal, 'pro');
    await entitlements.setPlan(people.cy.personal, 'personal');
    // Cy's Personal plan gives less than Ann's Pro: the page refuses and says what to do.
    await post(people.cy, `${teamPage}/billing`, { pay: '1' });
    const refused = await page(people.cy, teamPage);
    expect(refused).toContain('Ваш тариф даёт команде меньше');
    expect(refused).toContain(`href="/app/billing?team=${slug}"`);
    await expect(entitlements.changeTeamBilling(people.cy.id, teamId, { pay: true })).rejects.toMatchObject({
      code: 'plan_too_small',
    });

    // Bob buys Pro and pays for the team from its page.
    await entitlements.setPlan(people.bob.personal, 'pro');
    const paid = await post(people.bob, `${teamPage}/billing`, { pay: '1' });
    expect(paid.headers.get('location')).toBe(`${teamPage}#plan`);
    expect(await entitlements.entitlements(teamId)).toMatchObject({
      payerId: people.bob.personal,
      team: { payer: { userId: people.bob.id, name: 'Bob Stone' } },
    });
    expect(await charges(() => readMine(people.bob))).toEqual({ ann: 0, bob: 1, cy: 0 });
    const bobsPage = await page(people.bob, teamPage);
    expect(bobsPage).toContain('Вы оплачиваете команду своим тарифом «Про».');
    expect(bobsPage).toContain('Перестать оплачивать');
    // Bob's billing page lists the team on his plan; coming from the team, it shows the way back.
    const billing = await page(people.bob, `/app/billing?plan=pro&team=${slug}`);
    expect(billing).toContain('Ваш тариф оплачивает и команды');
    expect(billing).toContain(`href="/app/team/${slug}#plan"`);
    expect(billing).toContain('Ваш тариф оплачивает команду «Acme»');
    // Someone outside the team gets no hint it exists.
    expect(await page(people.dana, `/app/billing?team=${slug}`)).not.toContain('Acme');
    // The AI sees the same (asking is an action too, charged to Bob like any other in the team).
    const plan = json(await call(as(people.cy), 'manyplug_plan'));
    expect(plan.team_billing).toMatchObject({ paid_by: 'Bob Stone', plan: 'pro' });
    expect(plan.can_pay_for_team).toBe(false);
    const home = json(await call({ ...as(people.bob), workspaceId: people.bob.personal }, 'manyplug_plan'));
    expect(home).toMatchObject({
      plan: 'pro',
      teams_on_this_plan: [{ team: 'Acme', covers: 'everyone in the team' }],
    });
    expect(home.teams_on_this_plan[0].actions_this_month).toBe(await chargedInTeam(people.bob));
  });

  it('gives paying back: the owner takes it any time, whoever pays may stop', async () => {
    const { entitlements, db } = hub.services;
    await entitlements.changeTeamBilling(people.ann.id, teamId, { pay: true });
    expect((await entitlements.entitlements(teamId)).payerId).toBe(people.ann.personal);
    // The owner paying is the default, not a stored choice.
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, teamId));
    expect(row?.billingUserId).toBeNull();

    await entitlements.changeTeamBilling(people.bob.id, teamId, { pay: true });
    expect((await entitlements.entitlements(teamId)).payerId).toBe(people.bob.personal);
    // From the chat: Bob stops, and the owner pays again.
    const stopped = json(await call(as(people.bob), 'manyplug_team_billing', { pay: false }));
    expect(stopped.team_billing).toMatchObject({ paid_by: 'Ann Lee' });
    await expect(entitlements.changeTeamBilling(people.ann.id, teamId, { pay: false })).rejects.toMatchObject(
      {
        code: 'team_owner_pays',
      },
    );
    await expect(entitlements.changeTeamBilling(people.cy.id, teamId, { pay: false })).rejects.toMatchObject({
      code: 'not_team_payer',
    });
    expect((await call(as(people.bob), 'manyplug_team_billing', {})).isError).toBe(true);
  });

  it('switches to everyone using their own plan, by owners and admins only', async () => {
    const { entitlements, accounts } = hub.services;
    await expect(
      entitlements.changeTeamBilling(people.cy.id, teamId, { mode: 'each' }),
    ).rejects.toMatchObject({
      code: 'team_admin_only',
    });
    // It changes everyone's limits, so the owner confirms it.
    await call(as(people.ann), 'manyplug_team_billing', { mode: 'each' });
    expect((await entitlements.entitlements(teamId)).team?.mode).toBe('payer');
    await approveOpen(people.ann, 'team_billing');
    expect((await entitlements.entitlements(teamId)).team?.mode).toBe('each');

    // Each member's use now counts against their own plan; the shared key against the payer's.
    expect(await charges(() => readMine(people.bob))).toEqual({ ann: 0, bob: 1, cy: 0 });
    await accounts.create(teamId, { connectorId: 'notes', label: 'Cy' }, { userId: people.cy.id });
    expect(await charges(() => readMine(people.cy))).toEqual({ ann: 0, bob: 0, cy: 1 });
    const viaKey = await charges(async () => {
      const result = await call(as(people.ann, { shared: true }), 'notes_read', { account: 'office' });
      expect(result.isError).toBeFalsy();
    });
    expect(viaKey).toEqual({ ann: 1, bob: 0, cy: 0 });
    // Accounts follow the same rule: members' own count against their plans, the team's against Ann's.
    expect(await entitlements.accountsUsed(people.ann.personal)).toBe(2);
    expect(await entitlements.accountsUsed(people.bob.personal)).toBe(1);
    expect(await entitlements.accountsUsed(people.cy.personal)).toBe(1);
    // Cy sees her own plan on the team page.
    const cysPage = await page(people.cy, teamPage);
    expect(cysPage).toContain('Ваш собственный тариф «Личный»');
    expect(cysPage).toContain('Каждый пользуется своим тарифом.');
  });

  it('keeps a team to 100 people, open invitations included', async () => {
    const { teams, db } = hub.services;
    const taken = (await teams.members(teamId)).length + (await teams.invitations(teamId)).length;
    const rows = Array.from({ length: MAX_TEAM_MEMBERS - taken }, (_, i) => ({
      id: newId('inv'),
      workspaceId: teamId,
      email: `guest${i}@example.com`,
      role: 'member' as const,
      tokenHash: hashToken(`ac_inv_guest_${i}`),
      invitedBy: people.ann.id,
      expiresAt: new Date(Date.now() + 7 * DAY),
    }));
    await db.insert(workspaceInvitations).values(rows);
    await expect(
      teams.invite(people.ann.id, teamId, { email: 'one-more@example.com' }),
    ).rejects.toMatchObject({
      code: 'team_full',
    });
    // Inviting someone again replaces their link and takes no new place.
    await teams.invite(people.ann.id, teamId, { email: 'guest0@example.com' });
    await db
      .update(workspaceInvitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(workspaceInvitations.workspaceId, teamId), isNull(workspaceInvitations.revokedAt)));
  });

  it('hands paying back to the owner when the payer leaves', async () => {
    const { entitlements, teams } = hub.services;
    await entitlements.changeTeamBilling(people.bob.id, teamId, { pay: true });
    expect((await entitlements.entitlements(teamId)).payerId).toBe(people.bob.personal);
    await teams.leave(people.bob.id, teamId);
    expect((await entitlements.entitlements(teamId)).payerId).toBe(people.ann.personal);
    const [row] = await hub.services.db.select().from(workspaces).where(eq(workspaces.id, teamId));
    expect(row?.billingUserId).toBeNull();
  });

  it('sells no team plan on the pricing page', async () => {
    const html = await (await new TestBrowser(hub.baseUrl).request('/pricing')).text();
    expect(html).toContain('Как платят команды?');
    expect(html).toContain('Команды: делитесь тарифом с теми, кого пригласите');
    expect(html).not.toContain('/ чел. / мес');
    expect(html).not.toContain('Team $10');
  });
});
