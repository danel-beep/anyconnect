import { alternates, localizedPath, SITE_LOCALES } from './urls.js';

/**
 * robots.txt and sitemap.xml. The public site is open to search engines and to AI crawlers (search,
 * answer and training bots alike: being known to AI assistants is the point of an MCP hub), while
 * the dashboard, sign-in flows, the API and the MCP endpoint stay out of every index.
 */

/** Paths no crawler needs: signed-in pages, one-time flows, machine endpoints. */
export const PRIVATE_PATHS = [
  '/app',
  '/admin',
  '/oauth/',
  '/auth/',
  '/connect/',
  '/confirm',
  '/security',
  '/billing',
  '/prefs/',
  '/api/',
  '/mcp',
  '/login',
  '/signup',
];

/**
 * AI crawlers named explicitly, so a reader of the file (and a bot that only reads its own group)
 * sees they are welcome. Groups by operator: OpenAI, Anthropic, Perplexity, Google, Apple,
 * Microsoft, Meta, Amazon, Mistral, DuckDuckGo, Common Crawl.
 */
export const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot',
  'Applebot-Extended',
  'bingbot',
  'meta-externalagent',
  'Amazonbot',
  'MistralAI-User',
  'DuckAssistBot',
  'CCBot',
];

export function robotsTxt(publicUrl: string): string {
  const rules = ['Allow: /', ...PRIVATE_PATHS.map((p) => `Disallow: ${p}`)];
  return [
    `# ${publicUrl}: the public pages are open to search engines and AI assistants.`,
    `# A summary for language models: ${publicUrl}/llms.txt`,
    '',
    'User-agent: *',
    ...rules,
    '',
    ...AI_CRAWLERS.map((bot) => `User-agent: ${bot}`),
    ...rules,
    '',
    `Sitemap: ${publicUrl}/sitemap.xml`,
    '',
  ].join('\n');
}

export interface SitemapEntry {
  /** Path without the language parameter; every language version is listed. */
  path: string;
  priority?: number;
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Every page in every language, each with its `hreflang` alternates (Google's sitemap format). */
export function sitemapXml(publicUrl: string, entries: SitemapEntry[]): string {
  const urls = entries.flatMap((entry) => {
    const links = alternates(publicUrl, entry.path)
      .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${escapeXml(a.href)}"/>`)
      .join('\n');
    return SITE_LOCALES.map((lang) =>
      [
        '  <url>',
        `    <loc>${escapeXml(`${publicUrl}${localizedPath(entry.path, lang)}`)}</loc>`,
        links,
        entry.priority !== undefined ? `    <priority>${entry.priority.toFixed(1)}</priority>` : '',
        '  </url>',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}
