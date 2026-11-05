import { describe, expect, it } from 'vitest';
import { payingUser } from '../src/billing/payers.js';
import { coversPlan, getPlan, PLANS, type Plan } from '../src/billing/plans.js';
import demo from '../src/connectors/builtin/demo.js';
import type { AccountRow } from '../src/core/accounts.js';
import { buildCatalog, ownerText } from '../src/hub/catalog.js';
import { SETUP_CONNECTOR, teamCatalogFilter } from '../src/hub/setup-tools.js';
import { memberAccess, memberHandle } from '../src/security/members.js';
import { accountPolicy, evaluatePolicy } from '../src/security/policy.js';

const ann = { kind: 'member' as const, userId: 'usr_ann', role: 'owner' as const };
const bob = { kind: 'member' as const, userId: 'usr_bob', role: 'member' as const };
const names = new Map([
  ['usr_ann', 'Ann'],
  ['usr_bob', 'Bob'],
  ['usr_cy', 'Cy'],
]);
const accounts = [
  { id: 'acc_ann', ownerUserId: 'usr_ann' },
  { id: 'acc_bob', ownerUserId: 'usr_bob' },
  { id: 'acc_cy', ownerUserId: 'usr_cy' },
  { id: 'acc_team', ownerUserId: null },
];

describe('who may use which account in a team', () => {
  it('gives a member their own accounts and the team’s, nothing private of others', () => {
    const access = memberAccess({ accounts, shares: [], viewer: bob, names });
    expect(access.access).toEqual({ acc_bob: 'full', acc_team: 'full' });
    expect(access.owners).toEqual({ acc_bob: { kind: 'self' }, acc_team: { kind: 'team' } });
    // A member manages their own accounts, not the team's.
    expect([...access.manages]).toEqual(['acc_bob']);
  });

  it('does not let the owner or admins see members’ private accounts', () => {
    const access = memberAccess({ accounts, shares: [], viewer: ann, names });
    expect(Object.keys(access.access).sort()).toEqual(['acc_ann', 'acc_team']);
    expect([...access.manages].sort()).toEqual(['acc_ann', 'acc_team']);
  });

  it('opens a shared account at the higher of the member’s and the whole team’s level', () => {
    const shares = [
      { accountId: 'acc_ann', userId: 'usr_bob', access: 'write' as const },
      { accountId: 'acc_cy', userId: null, access: 'read' as const },
      { accountId: 'acc_cy', userId: 'usr_bob', access: 'full' as const },
      { accountId: 'acc_team', userId: null, access: 'read' as const },
    ];
    const access = memberAccess({ accounts, shares, viewer: bob, names });
    expect(access.access).toEqual({ acc_ann: 'write', acc_bob: 'full', acc_cy: 'full', acc_team: 'read' });
    expect(access.owners.acc_ann).toEqual({
      kind: 'member',
      userId: 'usr_ann',
      name: 'Ann',
      access: 'write',
    });
    expect(access.manages.has('acc_ann')).toBe(false);
  });

  it('gives the shared connection the team’s accounts and whole-team shares only', () => {
    const shares = [
      { accountId: 'acc_ann', userId: null, access: 'read' as const },
      { accountId: 'acc_bob', userId: 'usr_cy', access: 'full' as const },
    ];
    const access = memberAccess({ accounts, shares, viewer: { kind: 'shared' }, names });
    expect(access.access).toEqual({ acc_ann: 'read', acc_team: 'full' });
    expect(access.manages.size).toBe(0);
  });

  it('gives members short unique handles, never one that selects accounts', () => {
    expect(memberHandle({ name: 'Ann Lee', email: 'a@x.io' }, new Set())).toBe('ann');
    expect(memberHandle({ name: 'Ann Smith', email: 'b@x.io' }, new Set(['ann']))).toBe('ann2');
    expect(memberHandle({ name: null, email: 'bob.stone@x.io' }, new Set())).toBe('bobstone');
    expect(memberHandle({ name: 'Аня', email: 'c@x.io' }, new Set())).toBe('anya');
    expect(memberHandle({ name: 'All', email: 'd@x.io' }, new Set())).toBe('all2');
    expect(memberHandle({ name: '★', email: '★@x.io' }, new Set())).toBe('member');
  });
});

describe('the team cap in the access policy', () => {
  const work = { connectorId: 'gmail', accountId: 'acc_ann' };
  const member = { access: { acc_ann: 'read' as const, acc_team: 'full' as const } };

  it('hides accounts the member may not use, as if they did not exist', () => {
    expect(
      evaluatePolicy([], { member }, { connectorId: 'gmail', accountId: 'acc_cy' }, 'read'),
    ).toMatchObject({
      allowed: false,
      reason: 'member',
    });
  });

  it('caps what rules allow and never lets a rule raise it', () => {
    const raise = [
      {
        id: 'rul_1',
        aiClientId: null,
        personaId: null,
        connectorId: null,
        accountId: 'acc_ann',
        access: 'full' as const,
        confirm: null,
        undoWindowSeconds: null,
      },
    ];
    expect(accountPolicy(raise, { member }, work).access).toBe('read');
    expect(evaluatePolicy(raise, { member }, work, 'write').allowed).toBe(false);
    expect(
      evaluatePolicy([], { member }, { connectorId: 'gmail', accountId: 'acc_team' }, 'dangerous').allowed,
    ).toBe(true);
  });

  it('leaves the hub’s setup tools to their own checks', () => {
    expect(
      evaluatePolicy([], { member }, { connectorId: 'manyplug', accountId: null }, 'write').allowed,
    ).toBe(true);
  });
});

describe('who pays for a team', () => {
  const members = new Map([
    ['usr_ann', 'owner' as const],
    ['usr_bob', 'member' as const],
  ]);
  const team = { mode: 'payer' as const, payerUserId: 'usr_ann', members };

  it('charges everyone’s use to the payer, and in “each” mode each member’s to themselves', () => {
    expect(payingUser(team, 'usr_bob')).toBe('usr_ann');
    expect(payingUser(team, null)).toBe('usr_ann');
    const each = { ...team, mode: 'each' as const };
    expect(payingUser(each, 'usr_bob')).toBe('usr_bob');
    // The team's own accounts and its shared key stay with the payer, as does anyone who left.
    expect(payingUser(each, null)).toBe('usr_ann');
    expect(payingUser(each, 'usr_gone')).toBe('usr_ann');
  });

  it('lets someone take over paying only with a plan that gives the team at least as much', () => {
    const [free, personal, pro, business, unlimited] = [
      'free',
      'personal',
      'pro',
      'business',
      'unlimited',
    ].map((id) => getPlan(id)) as [Plan, Plan, Plan, Plan, Plan];
    expect(coversPlan(pro, personal)).toBe(true);
    expect(coversPlan(personal, pro)).toBe(false);
    expect(coversPlan(personal, free)).toBe(true);
    expect(coversPlan(pro, pro)).toBe(true);
    // Unlimited accounts beat any number; a plan with fewer actions never covers one with more.
    expect(coversPlan(unlimited, business)).toBe(true);
    expect(coversPlan(pro, business)).toBe(false);
    expect(coversPlan(business, unlimited)).toBe(false);
  });

  it('sells no plan per seat or to teams: every public plan is a person’s', () => {
    expect(PLANS.map((p) => p.id)).not.toContain('team');
    expect(PLANS.filter((p) => p.public).map((p) => p.id)).toEqual(['free', 'personal', 'pro']);
    expect(getPlan('business').public).toBe(false);
  });
});

function account(partial: Partial<AccountRow> & { name: string }): AccountRow {
  const now = new Date();
  return {
    id: `acc_${partial.name}`,
    workspaceId: 'wsp_team',
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
    ownerUserId: null,
    checkedAt: null,
    reauthNotifiedAt: null,
    ...partial,
  };
}

describe('the catalog of a team member', () => {
  const rows = [
    account({ name: 'bob', ownerUserId: 'usr_bob' }),
    account({ name: 'sales' }),
    account({ name: 'ann' }),
  ];
  const team = {
    name: 'Acme',
    member: 'Bob',
    owners: {
      acc_bob: { kind: 'self' as const },
      acc_sales: { kind: 'team' as const },
      acc_ann: { kind: 'member' as const, name: 'Ann', access: 'read' as const },
    },
  };

  it('says whose each account is and offers "mine" for the user’s own', () => {
    const catalog = buildCatalog({ connectors: [demo], accounts: rows, team });
    const echo = catalog.tools.find((t) => t.name === 'demo_echo')!;
    const property = (echo.inputSchema.properties as Record<string, { enum?: string[]; description: string }>)
      .account!;
    expect(property.enum).toEqual(['bob', 'sales', 'ann', 'all', 'mine']);
    expect(property.description).toContain('"ann" (ANN, Ann’s, shared with you: read only)');
    expect(catalog.instructions).toContain('you act for Bob');
    expect(catalog.instructions).toContain('"sales" — SALES (team account)');
    expect(ownerText({ kind: 'self' })).toBe('yours');
  });

  it('does not offer "mine" when every account is the user’s own', () => {
    const catalog = buildCatalog({
      connectors: [demo],
      accounts: [rows[0]!],
      team: { ...team, owners: { acc_bob: { kind: 'self' } } },
    });
    const echo = catalog.tools.find((t) => t.name === 'demo_echo')!;
    expect((echo.inputSchema.properties as Record<string, { enum?: string[] }>).account!.enum).toEqual([
      'bob',
    ]);
  });

  it('shows team tools to members only, and the shared connection no tool that changes the setup', async () => {
    const setup = SETUP_CONNECTOR;
    const action = (name: string) => setup.actions.find((a) => a.name === name)!;
    const personal = await teamCatalogFilter(undefined, async () => undefined)({} as never);
    const member = await teamCatalogFilter(undefined, async () => ({ member: 'Bob' }))({} as never);
    const shared = await teamCatalogFilter(undefined, async () => ({}))({} as never);
    expect(personal(setup, action('share_account'), undefined)).toBe(false);
    expect(personal(setup, action('team'), undefined)).toBe(true);
    expect(member(setup, action('share_account'), undefined)).toBe(true);
    expect(shared(setup, action('team'), undefined)).toBe(true);
    for (const name of ['connect_account', 'share_account', 'remove_account', 'set_rule']) {
      expect(shared(setup, action(name), undefined)).toBe(false);
    }
    // Service tools are left to the base filter.
    expect(shared(demo, demo.actions[0]!, rows[1])).toBe(true);
  });
});
