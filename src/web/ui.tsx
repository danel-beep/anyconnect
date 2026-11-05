import type { Child, FC } from 'hono/jsx';
import { BRAND } from '../brand.js';
import { BRAND_ICONS } from './brand-icons.js';
import type { Translate } from './i18n.js';

/**
 * Small building blocks shared by the website, the dashboard and the admin panel. Everything is
 * server-rendered; `/assets/site.js` only enhances (copy buttons, tabs, menus, theme switch).
 */

// --- Interface icons (24×24, stroke = currentColor) ---------------------------

const ICONS = {
  check: 'M20 6 9 17l-5-5',
  minus: 'M5 12h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  sun: 'M12 4V2M12 22v-2M4.9 4.9 3.5 3.5M20.5 20.5l-1.4-1.4M4 12H2M22 12h-2M4.9 19.1l-1.4 1.4M20.5 3.5l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  x: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  chevron: 'm6 9 6 6 6-6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Z',
  lock: 'M6 11h12v10H6zM8 11V8a4 4 0 0 1 8 0v3',
  key: 'M14.5 9.5a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM13.2 12.7 20 19.5M17 16.5l2-2',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2ZM10 21h4',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  users:
    'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 20v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  logout: 'M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4M16 17l5-5-5-5M21 12H9',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  layers: 'M12 3 2 8l10 5 10-5-10-5ZM2 13l10 5 10-5M2 18l10 5 10-5',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  braces:
    'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8Z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4v16l13-8L7 4Z',
  book: 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2ZM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7Z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  pen: 'M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4',
} as const;

export type IconName = keyof typeof ICONS;

export const Icon: FC<{ name: IconName; class?: string; label?: string }> = ({ name, class: cls, label }) => (
  <svg
    class={cls ? `i ${cls}` : 'i'}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden={label ? undefined : 'true'}
    role={label ? 'img' : undefined}
    aria-label={label}
  >
    <path d={ICONS[name]} />
  </svg>
);

/** The Manyplug mark: an open ring (a connection) around a node, on the orange signal square. */
export const BrandMark: FC<{ class?: string }> = ({ class: cls }) => (
  <svg class={`brand-mark ${cls ?? ''}`} viewBox="0 0 32 32" aria-hidden="true">
    <rect class="bm-bg" width="32" height="32" rx="8" />
    <path class="bm-fg" d="M16 7a9 9 0 1 1-9 9" fill="none" stroke-width="2.8" stroke-linecap="round" />
    <circle class="bm-dot" cx="16" cy="16" r="3.4" />
    <circle class="bm-dot" cx="7" cy="9.6" r="2" />
  </svg>
);

export const Brand: FC<{ href?: string }> = ({ href = '/' }) => (
  <a class="brand" href={href} aria-label={BRAND.name}>
    <BrandMark />
    <span>{BRAND.name}</span>
  </a>
);

/** The official multi-colour Google "G" (required next to "Sign in with Google"). */
export const GoogleG: FC = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true">
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
  </svg>
);

/** A brand mark from `brand-icons.ts` in the current text colour. */
export const BrandIcon: FC<{ slug: string }> = ({ slug }) => {
  const icon = BRAND_ICONS[slug];
  if (!icon) return null;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={icon.path} />
    </svg>
  );
};

/** A service's logo tile: its brand mark, an interface icon, or the first letter. */
export const ServiceLogo: FC<{
  icon?: string | undefined;
  glyph?: IconName | undefined;
  name: string;
  size?: 'sm' | 'lg';
}> = ({ icon, glyph, name, size }) => (
  <span
    class={`logo-tile${size ? ` ${size}` : ''}${icon && BRAND_ICONS[icon] ? ` branded bi-${icon}` : ''}`}
    aria-hidden="true"
  >
    {icon && BRAND_ICONS[icon] ? (
      <BrandIcon slug={icon} />
    ) : glyph ? (
      <Icon name={glyph} />
    ) : (
      <span class="mono-letter">{name.slice(0, 1).toUpperCase()}</span>
    )}
  </span>
);

/** A read-only value with a copy button (the button needs JS; the text stays selectable without it). */
export const CopyField: FC<{ t: Translate; id: string; value: string; label: string }> = ({
  t,
  id,
  value,
  label,
}) => (
  <div class="copy">
    <input id={id} type="text" readonly value={value} aria-label={label} data-select-on-focus />
    <button type="button" class="primary" data-copy={`#${id}`}>
      <Icon name="copy" />
      <span class="copy-label">{t('ui.copy')}</span>
      <span class="copy-done">{t('ui.copied')}</span>
    </button>
  </div>
);

/** A code block with a copy button. */
export const CodeBlock: FC<{ t: Translate; id: string; code: string }> = ({ t, id, code }) => (
  <div class="stack">
    <pre class="block" id={id}>
      <code>{code}</code>
    </pre>
    <div class="row">
      <button type="button" class="sm" data-copy={`#${id}`}>
        <Icon name="copy" />
        <span class="copy-label">{t('ui.copy')}</span>
        <span class="copy-done">{t('ui.copied')}</span>
      </button>
    </div>
  </div>
);

/** Width class for a 0–100 % value in 5 % steps (no inline styles under the CSP). */
export const pctClass = (prefix: 'w' | 'h', used: number, limit: number | null): string => {
  if (limit === null || limit <= 0) return `${prefix}-0`;
  const pct = Math.min(100, Math.max(0, (used / limit) * 100));
  const step = used > 0 ? Math.max(5, Math.round(pct / 5) * 5) : 0;
  return `${prefix}-${step}`;
};

export const Meter: FC<{ used: number; limit: number | null; label: string }> = ({ used, limit, label }) => {
  // Nothing to fill without a limit: an always-empty bar reads as "nothing used".
  if (limit === null) return null;
  const ratio = limit === null ? 0 : used / Math.max(1, limit);
  const tone = ratio >= 1 ? 'bad' : ratio >= 0.8 ? '' : 'ok';
  return (
    // biome-ignore lint/a11y/useSemanticElements: a styled bar (no inline styles under the CSP); <meter> cannot be themed reliably
    <div
      class={`meter ${tone}`}
      role="meter"
      aria-label={label}
      aria-valuenow={used}
      aria-valuemin={0}
      aria-valuemax={limit ?? undefined}
    >
      <span class={pctClass('w', used, limit)} />
    </div>
  );
};

/** Light/dark switch (JS) and RU/EN links; both remember the choice. */
export const Prefs: FC<{ t: Translate; lang: string; path?: string }> = ({ t, lang, path }) => {
  const other = lang === 'ru' ? 'en' : 'ru';
  return (
    <div class="prefs">
      <button
        type="button"
        class="icon-btn"
        data-theme-toggle
        aria-label={t('ui.theme')}
        title={t('ui.theme')}
        hidden
      >
        <Icon name="moon" class="theme-light-icon" />
        <Icon name="sun" class="theme-dark-icon" />
      </button>
      <a
        class="lang-link"
        href={`/prefs/lang?to=${other}${path ? `&next=${encodeURIComponent(path)}` : ''}`}
        hreflang={other}
        lang={other}
        title={other === 'en' ? 'English' : 'Русский'}
      >
        {other.toUpperCase()}
      </a>
    </div>
  );
};

/**
 * Tabs: buttons switch panels with JS; without JS every panel is shown under its own heading.
 * `remember` keeps the chosen tab across pages (e.g. the AI client).
 */
export const Tabs: FC<{
  id: string;
  remember?: string;
  tabs: { id: string; label: Child; panel: Child }[];
}> = ({ id, remember, tabs }) => (
  <div data-tabs={id} data-remember={remember}>
    <div class="tabs" role="tablist">
      {tabs.map((tab, i) => (
        <button
          type="button"
          class="tab"
          role="tab"
          id={`${id}-tab-${tab.id}`}
          aria-controls={`${id}-panel-${tab.id}`}
          aria-selected={i === 0 ? 'true' : 'false'}
          data-tab={tab.id}
        >
          {tab.label}
        </button>
      ))}
    </div>
    {tabs.map((tab, i) => (
      <div
        class="tab-panel"
        role="tabpanel"
        id={`${id}-panel-${tab.id}`}
        aria-labelledby={`${id}-tab-${tab.id}`}
        data-inactive={i === 0 ? undefined : ''}
      >
        <h3 class="tabs-nojs-title">{tab.label}</h3>
        {tab.panel}
      </div>
    ))}
  </div>
);

export const Hidden: FC<{ values: Record<string, string> }> = ({ values }) => (
  <>
    {Object.entries(values).map(([name, value]) => (
      <input type="hidden" name={name} value={value} />
    ))}
  </>
);

export const fmtNumber = (lang: string, n: number) =>
  new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-US').format(n);

export const fmtDate = (lang: string, date: Date, withTime = false) =>
  new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: 'UTC',
  })
    .format(date)
    // Keep "1 дек. 2026 г." on one line.
    .replace(/ /g, '\u00a0');

/** A short day for chart axes: "6 окт." / "6 Oct". `day` is YYYY-MM-DD. */
export const fmtDay = (lang: string, day: string) =>
  new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
    .format(new Date(`${day}T00:00:00Z`))
    .replace(/ /g, '\u00a0');

/** "5 minutes ago" style time for activity lists. */
export function fmtAgo(lang: string, date: Date, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(lang === 'ru' ? 'ru' : 'en', { numeric: 'auto' });
  const s = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 30 * 86_400) return rtf.format(Math.round(s / 86_400), 'day');
  return fmtDate(lang, date);
}

export const initials = (nameOrEmail: string) => {
  const parts = nameOrEmail.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
};
