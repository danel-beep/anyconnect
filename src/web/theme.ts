/**
 * Color palette of the web panel ("Графит и сигнал": bright orange accent, white light theme,
 * matte graphite dark theme). Every color the CSS uses is a token here; `test/theme.test.ts`
 * checks WCAG contrast for each text/background pair, so new tokens should be added there too.
 */
export const THEME_TOKENS = [
  'bg',
  'bg-subtle',
  'card',
  'code-bg',
  'text',
  'muted',
  'border',
  'border-strong',
  'accent',
  'accent-soft',
  'accent-text',
  'accent-ink',
  'danger',
  'danger-soft',
  'ok',
  'ok-soft',
  'warn-bg',
  'warn-border',
  'ink-surface',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type Palette = Record<ThemeToken, string>;

export const THEMES = {
  light: {
    bg: '#f6f6f4',
    /** Sidebars, table headers, quiet panels. */
    'bg-subtle': '#f1f1ee',
    card: '#ffffff',
    'code-bg': '#f2f2ef',
    text: '#1c1c1e',
    muted: '#5f5f66',
    border: '#e4e4e0',
    'border-strong': '#cdcdc8',
    /** Bright fill for primary buttons and highlights; text on it uses `accent-text`. */
    accent: '#ff6b1a',
    'accent-text': '#1c1c1e',
    /** Accent used as text (links) on `bg`/`card`, darker so it stays readable. */
    'accent-ink': '#c2410c',
    /** Orange tint behind accent-ink text (badges, highlights). */
    'accent-soft': '#fff0e5',
    danger: '#c62828',
    'danger-soft': '#fdeeee',
    ok: '#1f7a4a',
    'ok-soft': '#e7f4ec',
    'warn-bg': '#fff4dc',
    'warn-border': '#e9b949',
    /** Matte graphite panels with light text (hub diagram, call-to-action band). */
    'ink-surface': '#2f2f33',
  },
  dark: {
    bg: '#232326',
    'bg-subtle': '#1e1e21',
    card: '#2c2c30',
    'code-bg': '#1c1c1f',
    text: '#ededee',
    muted: '#a6a6ae',
    border: '#3c3c42',
    'border-strong': '#52525a',
    accent: '#ff7a2e',
    'accent-text': '#1c1c1e',
    'accent-ink': '#ff9a5c',
    'accent-soft': '#3b2a20',
    danger: '#ff7070',
    'danger-soft': '#3d2627',
    ok: '#5cc98a',
    'ok-soft': '#213429',
    'warn-bg': '#3a3122',
    'warn-border': '#8a6a2a',
    'ink-surface': '#3a3a40',
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
  ['text', 'bg-subtle'],
  ['muted', 'bg-subtle'],
  ['text', 'code-bg'],
  ['accent-ink', 'accent-soft'],
  ['danger', 'danger-soft'],
  ['ok', 'ok-soft'],
  ['accent-ink', 'bg-subtle'],
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
