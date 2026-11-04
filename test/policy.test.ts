import { describe, expect, it } from 'vitest';
import { evaluatePolicy, type PolicyRule } from '../src/security/policy.js';

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
