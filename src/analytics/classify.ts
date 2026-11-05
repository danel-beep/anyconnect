/**
 * Pure helpers that turn a request into analytics dimensions: where the visit came from (UTM tags,
 * referrer, click ids), the browser (device, browser, OS, crawler) and the language. No I/O, so
 * every rule is covered by unit tests (`test/analytics-classify.test.ts`).
 */

/** Where a visit came from. */
export interface Touch {
  source: string;
  medium: string;
  campaign: string | null;
  term: string | null;
  content: string | null;
  referrerHost: string | null;
}

export interface Browser {
  device: 'desktop' | 'mobile' | 'tablet';
  browser: string;
  os: string;
}

export const DIRECT: Touch = {
  source: 'direct',
  medium: 'none',
  campaign: null,
  term: null,
  content: null,
  referrerHost: null,
};

/**
 * A tag value as stored: lower case, `[a-z0-9._-]` (anything else becomes `_`), at most `max`
 * characters. Telegram `/start` payloads (`tg_ai_1`) pass through unchanged.
 */
export function cleanTag(value: string | null | undefined, max = 64): string | null {
  if (!value) return null;
  const tag = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max);
  return tag || null;
}

/** Referring sites grouped into channels; matched on the host and its parent domains. */
const KNOWN_REFERRERS: { hosts: string[]; source: string; medium: string }[] = [
  // AI assistants: people who asked an AI about connecting their tools.
  { hosts: ['chatgpt.com', 'chat.openai.com', 'openai.com'], source: 'chatgpt', medium: 'ai' },
  { hosts: ['claude.ai', 'anthropic.com'], source: 'claude', medium: 'ai' },
  { hosts: ['perplexity.ai'], source: 'perplexity', medium: 'ai' },
  { hosts: ['gemini.google.com', 'bard.google.com'], source: 'gemini', medium: 'ai' },
  { hosts: ['copilot.microsoft.com'], source: 'copilot', medium: 'ai' },
  { hosts: ['chat.deepseek.com'], source: 'deepseek', medium: 'ai' },
  { hosts: ['grok.com'], source: 'grok', medium: 'ai' },
  { hosts: ['you.com', 'phind.com', 'kagi.com'], source: 'ai_search', medium: 'ai' },
  // Search engines.
  { hosts: ['google.com', 'google.co.uk', 'google.de', 'google.ae'], source: 'google', medium: 'organic' },
  { hosts: ['bing.com'], source: 'bing', medium: 'organic' },
  { hosts: ['duckduckgo.com'], source: 'duckduckgo', medium: 'organic' },
  { hosts: ['search.brave.com'], source: 'brave', medium: 'organic' },
  { hosts: ['yandex.ru', 'yandex.com', 'ya.ru'], source: 'yandex', medium: 'organic' },
  { hosts: ['baidu.com'], source: 'baidu', medium: 'organic' },
  { hosts: ['ecosia.org'], source: 'ecosia', medium: 'organic' },
  { hosts: ['search.yahoo.com', 'yahoo.com'], source: 'yahoo', medium: 'organic' },
  // Social networks and communities.
  { hosts: ['t.me', 'telegram.org', 'telegram.me'], source: 'telegram', medium: 'social' },
  { hosts: ['x.com', 'twitter.com', 't.co'], source: 'x', medium: 'social' },
  {
    hosts: ['facebook.com', 'fb.com', 'm.facebook.com', 'l.facebook.com'],
    source: 'facebook',
    medium: 'social',
  },
  { hosts: ['instagram.com', 'l.instagram.com'], source: 'instagram', medium: 'social' },
  { hosts: ['linkedin.com', 'lnkd.in'], source: 'linkedin', medium: 'social' },
  { hosts: ['reddit.com', 'old.reddit.com'], source: 'reddit', medium: 'social' },
  { hosts: ['youtube.com', 'youtu.be'], source: 'youtube', medium: 'social' },
  { hosts: ['news.ycombinator.com'], source: 'hackernews', medium: 'social' },
  { hosts: ['producthunt.com'], source: 'producthunt', medium: 'social' },
  { hosts: ['threads.net'], source: 'threads', medium: 'social' },
  { hosts: ['bsky.app'], source: 'bluesky', medium: 'social' },
  { hosts: ['vk.com'], source: 'vk', medium: 'social' },
  { hosts: ['discord.com', 'discord.gg'], source: 'discord', medium: 'social' },
  { hosts: ['web.whatsapp.com', 'wa.me'], source: 'whatsapp', medium: 'social' },
  // Mail clients.
  {
    hosts: ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'mail.yahoo.com'],
    source: 'email',
    medium: 'email',
  },
];

/** Search engines on country domains (`google.fr`, `google.com.br`). */
const SEARCH_PATTERN = /(?:^|\.)(google|bing|yandex)\.[a-z.]{2,8}$/;

/** Ad click ids that mark a paid visit even without UTM tags. */
const CLICK_IDS: [param: string, source: string][] = [
  ['gclid', 'google'],
  ['gbraid', 'google'],
  ['wbraid', 'google'],
  ['msclkid', 'bing'],
  ['fbclid', 'facebook'],
  ['ttclid', 'tiktok'],
  ['twclid', 'x'],
  ['li_fat_id', 'linkedin'],
  ['yclid', 'yandex'],
];

const stripWww = (host: string) => host.replace(/^www\./, '');

/** The referring site's host, or null for none, an unreadable value or this site itself. */
export function referrerHost(referer: string | null | undefined, ownHost: string): string | null {
  if (!referer) return null;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = stripWww(url.hostname.toLowerCase());
  if (!host || host === stripWww(ownHost.toLowerCase())) return null;
  return host.slice(0, 100);
}

function knownReferrer(host: string): { source: string; medium: string } | undefined {
  for (const entry of KNOWN_REFERRERS) {
    if (entry.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return entry;
  }
  const search = SEARCH_PATTERN.exec(host);
  if (search) return { source: search[1]!, medium: 'organic' };
  return undefined;
}

/**
 * Where a page view came from, in order: UTM tags, ad click ids, a user's invite link (`?ref=<code>`,
 * the referral program; the code itself is not kept), the referring site, a team invitation link,
 * and otherwise `direct`.
 */
export function touchFrom(input: {
  query: (name: string) => string | undefined;
  referer?: string | null | undefined;
  path: string;
  ownHost: string;
}): Touch {
  const q = input.query;
  const host = referrerHost(input.referer, input.ownHost);
  const known = host ? knownReferrer(host) : undefined;
  const utmSource = cleanTag(q('utm_source'));
  const campaign = cleanTag(q('utm_campaign'), 100);
  if (utmSource || campaign) {
    const medium = cleanTag(q('utm_medium')) ?? known?.medium ?? 'referral';
    return {
      source: utmSource ?? known?.source ?? 'unknown',
      medium,
      campaign,
      term: cleanTag(q('utm_term'), 100),
      content: cleanTag(q('utm_content'), 100),
      referrerHost: host,
    };
  }
  for (const [param, source] of CLICK_IDS) {
    if (q(param)) return { ...DIRECT, source, medium: 'paid', referrerHost: host };
  }
  if (q('ref')) return { ...DIRECT, source: 'user_invite', medium: 'invite', referrerHost: host };
  if (host) {
    return {
      ...DIRECT,
      source: known?.source ?? host,
      medium: known?.medium ?? 'referral',
      referrerHost: host,
    };
  }
  if (input.path.startsWith('/invite/')) return { ...DIRECT, source: 'team_invite', medium: 'invite' };
  return DIRECT;
}

export const isDirect = (touch: Pick<Touch, 'source'>) => touch.source === 'direct';

/** Crawlers and tools by the name they put in the User-Agent; the first match names the family. */
const CRAWLERS: [pattern: RegExp, family: string][] = [
  [/GPTBot|OAI-SearchBot|ChatGPT-User/i, 'openai'],
  [/ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai/i, 'anthropic'],
  [/PerplexityBot|Perplexity-User/i, 'perplexity'],
  [/Google-Extended|GoogleOther|Googlebot|AdsBot-Google|Google-InspectionTool|Storebot-Google/i, 'google'],
  [/bingbot|BingPreview|msnbot/i, 'bing'],
  [/YandexBot|YandexMobileBot|Yandex(?:Images|Metrika)/i, 'yandex'],
  [/DuckDuckBot|DuckAssistBot/i, 'duckduckgo'],
  [/Applebot/i, 'apple'],
  [/Amazonbot/i, 'amazon'],
  [/meta-externalagent|facebookexternalhit|FacebookBot|meta-externalfetcher/i, 'meta'],
  [/Bytespider|TikTokSpider/i, 'bytedance'],
  [/CCBot/i, 'commoncrawl'],
  [/TelegramBot/i, 'telegram'],
  [/Twitterbot/i, 'x'],
  [/LinkedInBot/i, 'linkedin'],
  [/Slackbot|Discordbot|WhatsApp|redditbot|Embedly|Iframely/i, 'link_preview'],
  [/AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|SeznamBot|DataForSeoBot|BLEXBot/i, 'seo'],
  [/UptimeRobot|Pingdom|StatusCake|BetterStack|Better Uptime|Site24x7|Uptime-Kuma|checkly/i, 'monitor'],
  [/HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|Lighthouse|PageSpeed/i, 'headless'],
  [
    /curl\/|Wget|python-requests|python-httpx|aiohttp|Go-http-client|okhttp|axios|node-fetch|undici|Java\/|libwww|Scrapy|httpie/i,
    'script',
  ],
  [/bot\b|crawl|spider|slurp|fetcher|scanner|archiver/i, 'other'],
];

/** The crawler family of a User-Agent, or undefined for a person's browser. No UA counts as a script. */
export function crawlerOf(userAgent: string | null | undefined): string | undefined {
  if (!userAgent || userAgent.length < 10) return 'script';
  for (const [pattern, family] of CRAWLERS) if (pattern.test(userAgent)) return family;
  return undefined;
}

/** Device, browser and OS from a User-Agent (families only; versions are not kept). */
export function parseBrowser(userAgent: string): Browser {
  const ua = userAgent;
  const tablet = /iPad|Tablet|PlayBook|Silk|Kindle|(Android(?!.*Mobile))/i.test(ua);
  const mobile = !tablet && /Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|Opera Mini/i.test(ua);
  const os = /Windows NT|Windows Phone/i.test(ua)
    ? 'windows'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'ios'
      : /Android/i.test(ua)
        ? 'android'
        : /CrOS/i.test(ua)
          ? 'chromeos'
          : /Mac OS X|Macintosh/i.test(ua)
            ? // iPadOS asks for the desktop site and says "Macintosh"; no way to tell from the UA alone.
              'macos'
            : /Linux|X11/i.test(ua)
              ? 'linux'
              : 'other';
  const browser = /\bTelegram\b/i.test(ua)
    ? 'telegram'
    : /; wv\)|FBAN|FBAV|Instagram|Line\//i.test(ua)
      ? 'in_app'
      : /Edg(?:e|A|iOS)?\//.test(ua)
        ? 'edge'
        : /OPR\/|Opera/.test(ua)
          ? 'opera'
          : /YaBrowser/.test(ua)
            ? 'yandex'
            : /SamsungBrowser/.test(ua)
              ? 'samsung'
              : /Vivaldi/.test(ua)
                ? 'vivaldi'
                : /Firefox|FxiOS/.test(ua)
                  ? 'firefox'
                  : /Chrome|CriOS|Chromium/.test(ua)
                    ? 'chrome'
                    : /Safari/.test(ua)
                      ? 'safari'
                      : 'other';
  return { device: tablet ? 'tablet' : mobile ? 'mobile' : 'desktop', browser, os };
}

/** The visitor's preferred language from Accept-Language: the primary subtag (`en`, `ru`, `pt`). */
export function primaryLanguage(acceptLanguage: string | null | undefined): string | null {
  if (!acceptLanguage) return null;
  let best: { tag: string; q: number } | undefined;
  for (const part of acceptLanguage.split(',').slice(0, 20)) {
    const [range, ...params] = part.trim().split(';');
    const tag = range?.trim().toLowerCase().split('-')[0];
    if (!tag || !/^[a-z]{2,3}$/.test(tag)) continue;
    const qParam = params.find((p) => p.trim().startsWith('q='));
    const q = qParam ? Number(qParam.trim().slice(2)) : 1;
    if (!Number.isFinite(q) || q <= 0) continue;
    if (!best || q > best.q) best = { tag, q };
  }
  return best?.tag ?? null;
}

/**
 * A page path as counted: no query, ids and tokens replaced by `:id`, at most 6 segments and 200
 * characters. `/admin/users/usr_01h…` → `/admin/users/:id`, `/invite/Xk2…` → `/invite/:id`.
 */
export function normalizePath(path: string): string {
  const parts = path.split('?')[0]!.split('/').slice(0, 7);
  const out = parts.map((part) => {
    if (!part) return part;
    if (/^[a-z]{2,5}_[0-9a-z]{10,}$/i.test(part)) return ':id';
    if (/^[0-9a-f-]{16,}$/i.test(part) || /^\d+$/.test(part)) return ':id';
    // Random tokens: long, and mixing case or digits in a way slugs do not.
    if (
      part.length >= 20 &&
      /[0-9]/.test(part) &&
      /[A-Za-z]/.test(part) &&
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(part)
    )
      return ':id';
    return part.slice(0, 60);
  });
  const joined = out.join('/').slice(0, 200);
  return joined.length > 1 ? joined.replace(/\/+$/, '') : '/';
}

/** Pages of the signed-in dashboard and the hub's own flows (counted as usage, not as traffic). */
const APP_PREFIXES = [
  '/app',
  '/connect',
  '/security',
  '/confirm',
  '/authorize',
  '/oauth',
  '/login/verify',
  '/billing',
];

/** Whether a path is part of the public site, whose visits count as traffic. */
export function isSitePath(path: string): boolean {
  return !APP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) && !path.startsWith('/admin');
}

/** A two-letter country code, or null for unknown, anonymised and reserved values. */
export function cleanCountry(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX' || c === 'T1' || c === 'ZZ') return null;
  return c;
}
