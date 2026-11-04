import { BRAND_ICONS } from '../brand-icons.js';
import { contrastRatio, THEMES } from '../theme.js';

/**
 * Brand colours for service logo tiles (`.logo-tile.branded.bi-<slug>`): the mark in the brand's
 * colour on a light tint of it. A colour too close to the card in a theme (black marks on the dark
 * card, very light ones on white) falls back to the text colour there, so every mark stays visible.
 * Classes, not inline styles: the CSP allows only our own stylesheet.
 */
const MIN_CONTRAST = 3;

const DARK = (rules: string) =>
  `@media (prefers-color-scheme:dark){:root:not([data-theme=light]) ${rules}}\n:root[data-theme=dark] ${rules}`;

function brandRules(): string {
  const light: string[] = [];
  const dark: string[] = [];
  for (const [slug, { hex }] of Object.entries(BRAND_ICONS)) {
    const color = hex.toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color)) continue;
    const fg = (card: string) => (contrastRatio(color, card) >= MIN_CONTRAST ? color : 'var(--text)');
    light.push(`.bi-${slug}{--bh:${color};--bf:${fg(THEMES.light.card)}}`);
    const onDark = fg(THEMES.dark.card);
    if (onDark !== fg(THEMES.light.card)) dark.push(`.bi-${slug}{--bf:${onDark}}`);
  }
  return [...light, ...dark.map(DARK)].join('\n');
}

export const BRAND_CSS = `
.logo-tile.branded{color:var(--bf,var(--text));background:color-mix(in srgb,var(--bh) 8%,var(--card));border-color:color-mix(in srgb,var(--bh) 22%,var(--border))}
${DARK('.logo-tile.branded{background:color-mix(in srgb,var(--bh) 14%,var(--card));border-color:color-mix(in srgb,var(--bh) 30%,var(--border))}')}
${brandRules()}
`;
