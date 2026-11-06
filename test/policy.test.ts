import { describe, expect, it } from 'vitest';
import {
  applyRuleChange,
  evaluatePolicy,
  loosenings,
  type PolicyRule,
  type PolicyState,
} from '../src/security/policy.js';

let seq = 0;
function rule(partial: Partial<PolicyRule>): PolicyRule {
  seq++;
  return {
    id: `rul_${seq}`,
    aiClientId: null,
    personaId: null,
    connectorId: null,
    accountId: null,
    access: null,
    confirm: null,
    undoWindowSeconds: null,
    ...partial,
  };
}

const gmailWork = { connectorId: 'gmail', accountId: 'acc_work' };
const gmailHome = { connectorId: 'gmail', accountId: 'acc_home' };
const telegram = { connectorId: 'telegram', accountId: 'acc_tg' };
const chatgpt = { aiClientId: 'app_chatgpt' };
const claude = { aiClientId: 'app_claude' };

describe('access policy', () => {
  it('defaults to full access with confirmation of dangerous actions only', () => {
    expect(evaluatePolicy([], chatgpt, gmailWork, 'read')).toMatchObject({ allowed: true, confirm: false });
    expect(evaluatePolicy([], chatgpt, gmailWork, 'write')).toMatchObject({ allowed: true, confirm: false });
    expect(evaluatePolicy([], chatgpt, gmailWork, 'dangerous')).toMatchObject({
      allowed: true,
      confirm: true,
    });
  });

  it('honours workspace defaults', () => {
    const settings = { defaultAccess: 'read' as const, defaultConfirm: 'never' as const };
    expect(evaluatePolicy([], chatgpt, gmailWork, 'read', settings).allowed).toBe(true);
    expect(evaluatePolicy([], chatgpt, gmailWork, 'write', settings)).toMatchObject({
      allowed: false,
      reason: 'access',
    });
  });

  it('"ChatGPT only reads work mail" leaves other clients and accounts alone', () => {
    const rules = [rule({ aiClientId: 'app_chatgpt', accountId: 'acc_work', access: 'read' })];
    expect(evaluatePolicy(rules, chatgpt, gmailWork, 'read').allowed).toBe(true);
    expect(evaluatePolicy(rules, chatgpt, gmailWork, 'write').allowed).toBe(false);
    expect(evaluatePolicy(rules, chatgpt, gmailHome, 'write').allowed).toBe(true);
    expect(evaluatePolicy(rules, claude, gmailWork, 'write').allowed).toBe(true);
  });

  it('prefers the more specific scope over the more specific subject', () => {
    const rules = [
      rule({ aiClientId: 'app_chatgpt', access: 'none' }),
      rule({ accountId: 'acc_tg', access: 'read' }),
    ];
    // The account rule (scope) beats the client-wide rule.
    expect(evaluatePolicy(rules, chatgpt, telegram, 'read').allowed).toBe(true);
    expect(evaluatePolicy(rules, chatgpt, gmailWork, 'read').allowed).toBe(false);
    expect(evaluatePolicy(rules, claude, gmailWork, 'dangerous').allowed).toBe(true);
  });

  it('resolves each field independently and breaks ties restrictively', () => {
    const rules = [
      rule({ connectorId: 'gmail', confirm: 'write' }),
      rule({ connectorId: 'gmail', confirm: 'never' }),
      rule({ aiClientId: 'app_chatgpt', connectorId: 'gmail', access: 'write' }),
    ];
    const decision = evaluatePolicy(rules, chatgpt, gmailWork, 'write');
    expect(decision).toMatchObject({ allowed: true, confirm: true });
    expect(decision.ruleIds).toHaveLength(2);
    expect(evaluatePolicy(rules, chatgpt, gmailWork, 'dangerous').allowed).toBe(false);
  });

  it('"always" asks even before reading', () => {
    const rules = [rule({ accountId: 'acc_home', confirm: 'always' })];
    expect(evaluatePolicy(rules, claude, gmailHome, 'read').confirm).toBe(true);
    expect(evaluatePolicy(rules, claude, gmailWork, 'read').confirm).toBe(false);
  });

  it('applies the undo window to changing actions only', () => {
    const rules = [rule({ connectorId: 'gmail', undoWindowSeconds: 30 })];
    expect(evaluatePolicy(rules, claude, gmailWork, 'write').undoWindowSeconds).toBe(30);
    expect(evaluatePolicy(rules, claude, gmailWork, 'read').undoWindowSeconds).toBe(0);
    expect(
      evaluatePolicy(rules, claude, telegram, 'write', { undoWindowSeconds: 10 }).undoWindowSeconds,
    ).toBe(10);
  });

  it('limits a persona to its accounts and its access cap', () => {
    const persona = { id: 'prs_work', accountIds: ['acc_work', 'acc_tg'], maxAccess: 'write' as const };
    const rules = [rule({ personaId: 'prs_work', accountId: 'acc_tg', access: 'read' })];
    expect(evaluatePolicy(rules, { ...claude, persona }, gmailHome, 'read')).toMatchObject({
      allowed: false,
      reason: 'persona',
    });
    expect(evaluatePolicy(rules, { ...claude, persona }, gmailWork, 'write').allowed).toBe(true);
    expect(evaluatePolicy(rules, { ...claude, persona }, gmailWork, 'dangerous').allowed).toBe(false);
    expect(evaluatePolicy(rules, { ...claude, persona }, telegram, 'write').allowed).toBe(false);
    // The same rule does not apply outside the persona.
    expect(evaluatePolicy(rules, claude, telegram, 'write').allowed).toBe(true);
  });

  it('never needs confirmation for something that is not allowed', () => {
    const rules = [rule({ access: 'read', confirm: 'always' })];
    expect(evaluatePolicy(rules, claude, gmailWork, 'write')).toMatchObject({
      allowed: false,
      confirm: false,
    });
  });
});

describe('rule changes and what they loosen', () => {
  const universe = {
    aiClientIds: ['app_chatgpt', 'app_claude'],
    personas: [],
    targets: [gmailWork, gmailHome, { connectorId: 'manyplug', accountId: null }],
  };
  const empty: PolicyState = { rules: [], settings: {} };

  it('edits only the rule at the place of the change and drops it once nothing is set', () => {
    const set = applyRuleChange(empty, {
      kind: 'rule',
      aiClientId: null,
      accountId: 'acc_work',
      confirm: 'write',
    });
    expect(set.rules).toEqual([
      expect.objectContaining({ accountId: 'acc_work', confirm: 'write', access: null }),
    ]);
    // undefined keeps a value, null clears it
    const both = applyRuleChange(set, {
      kind: 'rule',
      aiClientId: null,
      accountId: 'acc_work',
      access: 'read',
    });
    expect(both.rules).toEqual([expect.objectContaining({ access: 'read', confirm: 'write' })]);
    const cleared = applyRuleChange(both, {
      kind: 'rule',
      aiClientId: null,
      accountId: 'acc_work',
      access: null,
      confirm: null,
    });
    expect(cleared.rules).toEqual([]);
    const defaults = applyRuleChange(empty, { kind: 'defaults', confirm: 'never', undoWindowSeconds: 30 });
    expect(defaults.settings).toEqual({ defaultConfirm: 'never', undoWindowSeconds: 30 });
  });

  it('finds nothing to confirm when a change only tightens', () => {
    const asks = applyRuleChange(empty, {
      kind: 'rule',
      aiClientId: null,
      accountId: 'acc_work',
      confirm: 'write',
    });
    expect(loosenings(empty, asks, universe)).toEqual([]);
    const readOnly = applyRuleChange(empty, { kind: 'defaults', access: 'read', undoWindowSeconds: 10 });
    expect(loosenings(empty, readOnly, universe)).toEqual([]);
  });

  it('reports fewer confirmations, more access and a shorter undo window', () => {
    const never = applyRuleChange(empty, {
      kind: 'rule',
      aiClientId: 'app_claude',
      accountId: 'acc_work',
      confirm: 'never',
    });
    const found = loosenings(empty, never, universe);
    expect(found).toEqual([
      expect.objectContaining({
        aiClientId: 'app_claude',
        target: gmailWork,
        risk: 'dangerous',
        change: 'confirm',
      }),
    ]);

    const readOnly: PolicyState = { rules: [], settings: { defaultAccess: 'read', undoWindowSeconds: 30 } };
    const full = applyRuleChange(readOnly, { kind: 'defaults', access: 'full', undoWindowSeconds: 0 });
    const kinds = new Set(loosenings(readOnly, full, universe).map((l) => l.change));
    expect(kinds).toEqual(new Set(['access']));
    const delayed: PolicyState = { rules: [], settings: { undoWindowSeconds: 30 } };
    const shorter = applyRuleChange(delayed, { kind: 'defaults', undoWindowSeconds: 5 });
    expect(new Set(loosenings(delayed, shorter, universe).map((l) => l.change))).toEqual(new Set(['undo']));
  });

  it('counts confirming in the chat instead of on a page as a loosening, and back as tightening', () => {
    const inChat = applyRuleChange(empty, { kind: 'defaults', confirmIn: 'chat' });
    expect(evaluatePolicy(inChat.rules, claude, gmailWork, 'dangerous', inChat.settings)).toMatchObject({
      confirm: true,
      confirmIn: 'chat',
    });
    const kinds = new Set(loosenings(empty, inChat, universe).map((l) => l.change));
    expect(kinds).toEqual(new Set(['confirm_in']));
    expect(
      loosenings(inChat, applyRuleChange(inChat, { kind: 'defaults', confirmIn: 'link' }), universe),
    ).toEqual([]);
    // Nothing asks first: where it would ask does not matter.
    const never: PolicyState = { rules: [], settings: { defaultConfirm: 'never' } };
    expect(
      loosenings(never, applyRuleChange(never, { kind: 'defaults', confirmIn: 'chat' }), universe),
    ).toEqual([]);
  });

  it('sees a loosening that only shows for a persona once a stricter rule goes away', () => {
    // Default asks before everything; a persona rule says never; an account rule says always.
    const persona = { id: 'per_work', accountIds: ['acc_work'], maxAccess: 'full' as const };
    const before: PolicyState = {
      rules: [
        rule({ personaId: 'per_work', confirm: 'never' }),
        rule({ accountId: 'acc_work', confirm: 'always' }),
      ],
      settings: { defaultConfirm: 'always' },
    };
    const after = applyRuleChange(before, {
      kind: 'rule',
      aiClientId: null,
      accountId: 'acc_work',
      confirm: null,
    });
    expect(loosenings(before, after, { ...universe, personas: [] })).toEqual([]);
    expect(loosenings(before, after, { ...universe, personas: [persona] })).toContainEqual(
      expect.objectContaining({ personaId: 'per_work', target: gmailWork, change: 'confirm' }),
    );
  });
});
