import { describe, expect, it } from 'vitest';
import { getPlan } from '../src/billing/plans.js';
import { legalDoc } from '../src/web/legal.js';
import { trustDoc } from '../src/web/trust.js';

const text = (doc: unknown) => JSON.stringify(doc);

describe('trust page and legal texts', () => {
  it('names the operator in the terms only when it is configured', () => {
    for (const lang of ['en', 'ru'] as const) {
      const without = legalDoc('terms', lang, { publicUrl: 'https://hub.example' });
      expect(without.intro).not.toMatch(/undefined|\[/);
      const named = legalDoc('terms', lang, { publicUrl: 'https://hub.example', operator: ' Jane Doe ' });
      expect(named.intro).toContain('Jane Doe,');
    }
  });

  it('keeps both languages in step and reads retention from the plans', () => {
    const [en, ru] = [trustDoc('en', {}), trustDoc('ru', {})];
    expect(ru.encrypted.rows.map((r) => r.protection)).toEqual(en.encrypted.rows.map((r) => r.protection));
    expect(ru.who.parties).toHaveLength(en.who.parties.length);
    expect(ru.remove.steps).toHaveLength(en.remove.steps.length);
    expect(ru.more.links.map((l) => l.href)).toEqual(en.more.links.map((l) => l.href));
    for (const doc of [en, ru]) expect(text(doc)).toContain(`${getPlan('pro').limits.historyDays}`);
  });

  it('never claims more protection than the vault gives today', () => {
    for (const lang of ['en', 'ru'] as const) {
      const doc = trustDoc(lang, {});
      // Team accounts and messengers still open with the server key: the page says so.
      expect(doc.encrypted.rows.filter((r) => r.protection === 'server').length).toBeGreaterThan(0);
      expect(text(doc.limits)).toMatch(lang === 'en' ? /not end-to-end encrypted/ : /не использует сквозное/);
      expect(text(legalDoc('privacy', lang, { publicUrl: 'https://hub.example' }))).toContain('/trust');
    }
  });

  it('names the payment provider that resells the plans, and stays generic without one', () => {
    const merchant = {
      name: 'Creem',
      legalName: 'Creem (Armitage Labs OÜ)',
      buyerTerms: 'creem.io/buyer-terms',
    };
    for (const lang of ['en', 'ru'] as const) {
      for (const kind of ['privacy', 'terms', 'refunds'] as const) {
        const named = text(legalDoc(kind, lang, { publicUrl: 'https://hub.example', merchant }));
        expect(named).toContain('Creem');
        expect(named).not.toContain('Paddle');
        const plain = text(legalDoc(kind, lang, { publicUrl: 'https://hub.example' }));
        expect(plain).not.toMatch(/Paddle|Creem|undefined/);
      }
      expect(text(legalDoc('terms', lang, { publicUrl: 'https://hub.example', merchant }))).toContain(
        'creem.io/buyer-terms',
      );
      expect(text(trustDoc(lang, { merchant }))).toContain('Creem');
      expect(text(trustDoc(lang, {}))).not.toMatch(/Paddle|Creem|undefined/);
    }
  });

  it('uses the support address for data requests when it is set', () => {
    expect(text(trustDoc('en', { supportEmail: 'help@hub.example' }))).toContain('help@hub.example');
  });
});
