/**
 * Color palette of the web panel ("Графит и сигнал": bright orange accent, white light theme,
 * matte graphite dark theme). Every color the CSS uses is a token here; `test/theme.test.ts`
 * checks WCAG contrast for each text/background pair, so new tokens should be added there too.
 */
export const THEME_TOKENS = [
  'bg',
  'card',
  'text',
  'muted',
  'border',
  'accent',
  'accent-text',
  'accent-ink',
  'danger',
  'ok',
  'warn-bg',
  'warn-border',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type Palette = Record<ThemeToken, string>;

export const THEMES = {
  light: {
    bg: '#f5f5f4',
    card: '#ffffff',
    text: '#1c1c1e',
    muted: '#5f5f66',
    border: '#e2e2df',
    /** Bright fill for primary buttons and highlights; text on it uses `accent-text`. */
    accent: '#ff6b1a',
    'accent-text': '#1c1c1e',
    /** Accent used as text (links) on `bg`/`card`, darker so it stays readable. */
    'accent-ink': '#c2410c',
    danger: '#c62828',
    ok: '#1f7a4a',
    'warn-bg': '#fff4dc',
    'warn-border': '#e9b949',
  },
  dark: {
    bg: '#232326',
    card: '#2c2c30',
    text: '#ededee',
    muted: '#a6a6ae',
    border: '#3c3c42',
    accent: '#ff7a2e',
    'accent-text': '#1c1c1e',
    'accent-ink': '#ff9a5c',
    danger: '#ff7070',
    ok: '#5cc98a',
    'warn-bg': '#3a3122',
    'warn-border': '#8a6a2a',
  },
} satisfies Record<'light' | 'dark', Palette>;

/** Pairs that carry text: [foreground, background]. Each must reach WCAG AA (4.5:1). */
export const TEXT_PAIRS: ReadonlyArray<readonly [ThemeToken, ThemeToken]> = [
  ['text', 'bg'],
  ['text', 'card'],
  ['text', 'warn-bg'],
  ['muted', 'bg'],
  ['muted', 'card'],
  ['accent-text', 'accent'],
  ['accent-ink', 'bg'],
  ['accent-ink', 'card'],
  ['danger', 'card'],
  ['ok', 'card'],
];

const vars = (p: Palette): string => THEME_TOKENS.map((t) => `--${t}:${p[t]}`).join(';');

/**
 * Theme CSS: light by default, dark from the OS setting, and `data-theme` on <html> overrides
 * both ways (ready for a manual switch).
 */
export function themeCss(): string {
  const dark = `${vars(THEMES.dark)};color-scheme:dark`;
  return [
    `:root{${vars(THEMES.light)};color-scheme:light;--radius:12px}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${dark}}}`,
    `:root[data-theme=dark]{${dark}}`,
  ].join('\n');
}

/** WCAG 2.x contrast ratio between two #rrggbb colors. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
