import { describe, expect, it } from 'vitest';
import { APP_CSS } from '../src/web/styles.js';
import { contrastRatio, TEXT_PAIRS, THEME_TOKENS, THEMES } from '../src/web/theme.js';

describe('web panel theme', () => {
  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });

  for (const [name, palette] of Object.entries(THEMES)) {
    it(`${name}: every text pair reaches WCAG AA`, () => {
      for (const [fg, bg] of TEXT_PAIRS) {
        const ratio = contrastRatio(palette[fg], palette[bg]);
        expect(ratio, `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('defines every token in both themes and in the CSS', () => {
    for (const token of THEME_TOKENS) {
      expect(APP_CSS).toContain(`--${token}:${THEMES.light[token]}`);
      expect(APP_CSS).toContain(`--${token}:${THEMES.dark[token]}`);
    }
  });

  it('uses only tokens the theme defines', () => {
    const used = new Set([...APP_CSS.matchAll(/var\(--([\w-]+)[,)]/g)].map((m) => m[1]));
    // Besides the theme, a component may set its own properties (e.g. a brand colour per logo tile).
    const local = new Set([...APP_CSS.matchAll(/[{;]--([\w-]+):/g)].map((m) => m[1]));
    for (const token of used) expect([...THEME_TOKENS, 'radius', ...local]).toContain(token);
  });
});
