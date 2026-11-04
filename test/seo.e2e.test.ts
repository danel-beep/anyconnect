import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/**
 * The docs and search pages on a real hub: every generated page renders in both languages with
 * matching canonical, hreflang and schema.org data, and what crawlers read (robots.txt, the
 * sitemap, llms.txt) lists exactly the pages that work on this server.
 */

let hub: TestHub;

beforeAll(async () => {
  await resetDatabase();
  // Google's sign-in app is set (Gmail connects), Microsoft's is not (Outlook's pages say "not yet").
  hub = await startTestHub({
    env: {
      OAUTH_APP_GOOGLE_CLIENT_ID: 'id',
      OAUTH_APP_GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_SITE_VERIFICATION: 'gsv-token',
    },
  });
});
afterAll(() => hub.close());

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${hub.baseUrl}${path}`, { headers: { Accept: 'text/html', ...headers }, redirect: 'manual' });

async function page(path: string) {
  const res = await get(path);
  expect(res.status, path).toBe(200);
  return res.text();
}

const attr = (html: string, re: RegExp) => html.match(re)?.[1];

/** The page's JSON-LD, parsed (one object or a list). */
function jsonLd(html: string): Record<string, unknown>[] {
  const raw = attr(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!raw) return [];
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [data];
}

const types = (html: string) => jsonLd(html).map((x) => x['@type']);

describe('docs and search pages', () => {
  it('renders a guide per AI client with steps, FAQ and how-to data', async () => {
    for (const slug of [
      'claude',
      'chatgpt',
      'claude-code',
      'cursor',
      'vscode',
      'codex',
      'gemini-cli',
      'windsurf',
      'mcp-clients',
    ]) {
      const html = await page(`/docs/${slug}`);
      expect(html).toContain(`<link rel="canonical" href="${hub.baseUrl}/docs/${slug}"/>`);
      expect(html).toContain(`hreflang="ru" href="${hub.baseUrl}/docs/${slug}?lang=ru"`);
      expect(html).toContain(hub.mcpUrl);
      expect(types(html)).toEqual(['BreadcrumbList', 'HowTo', 'FAQPage']);
    }
    const claude = await page('/docs/claude');
    expect(claude).toContain('Customize → Connectors');
    expect(claude).toContain('<meta name="google-site-verification" content="gsv-token"/>');
    expect(claude).toContain('property="og:image"');
  });

  it('opens a page in Russian with ?lang=ru, without touching the saved language', async () => {
    const res = await get('/docs/claude?lang=ru');
    expect(res.headers.get('set-cookie') ?? '').not.toContain('ac_lang');
    const html = await res.text();
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain(`<link rel="canonical" href="${hub.baseUrl}/docs/claude?lang=ru"/>`);
    expect(html).toContain('Подключите Claude к своим сервисам');
    expect(html).toContain('content="ru_RU"');
    // The language switch drops ?lang= so the choice sticks.
    const sw = await get(`/prefs/lang?to=en&next=${encodeURIComponent('/docs/claude?lang=ru')}`);
    expect(sw.headers.get('location')).toBe('/docs/claude');
  });

  it('renders "connect a service to a client" pages from the catalogue', async () => {
    const html = await page('/services/gmail/chatgpt');
    expect(html).toContain('Connect Gmail to ChatGPT');
    expect(html).toContain('/signup?next=%2Fconnect%2Fgmail');
    expect(html).not.toContain('noindex');
    expect(types(html)).toEqual(['BreadcrumbList', 'HowTo', 'FAQPage']);
    const faq = jsonLd(html).find((x) => x['@type'] === 'FAQPage')!;
    // Answers come from the service's real actions: sending mail asks first.
    expect(JSON.stringify(faq)).toMatch(/approval before they run: .*Send/);

    // A service whose sign-in app is missing here stays out of search results.
    const outlook = await page('/services/outlook/claude');
    expect(outlook).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(outlook).not.toContain('rel="alternate"');

    expect((await get('/services/gmail/unknown')).status).toBe(404);
    expect((await get('/services/demo/claude')).status).toBe(404);
    expect((await get('/services/gmail/mcp-clients')).status).toBe(404);
  });

  it('links a service page to its pages per AI client', async () => {
    const html = await page('/services/gmail');
    expect(html).toContain('href="/services/gmail/claude"');
    expect(html).toContain('href="/services/gmail/cursor"');
    expect(types(html)).toContain('BreadcrumbList');
  });

  it('renders the FAQ, comparisons and explainers', async () => {
    const faq = await page('/faq');
    expect(types(faq)).toEqual(['BreadcrumbList', 'FAQPage']);
    expect(faq).toContain('Gmail');

    expect(await page('/compare')).toContain('/compare/zapier-mcp');
    const zapier = await page('/compare/zapier-mcp');
    expect(zapier).toContain('https://zapier.com/mcp');
    expect(zapier).not.toMatch(/\{(count|from)\}/);
    expect(types(zapier)).toEqual(['BreadcrumbList', 'TechArticle']);

    const mcp = await page('/guides/what-is-mcp?lang=ru');
    expect(mcp).toContain('Что такое MCP');
    expect(mcp).not.toMatch(/\{(count|freeAccounts)\}/);
    expect(types(mcp)).toEqual(['BreadcrumbList', 'TechArticle', 'FAQPage']);

    for (const path of ['/compare/nope', '/guides/nope', '/docs/nope'])
      expect((await get(path)).status).toBe(404);
  });

  it('describes the product on the landing and pricing pages', async () => {
    const landing = await page('/');
    expect(types(landing)).toEqual(['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage']);
    expect(landing).toContain('hreflang="x-default"');
    expect(types(await page('/pricing'))).toEqual(['BreadcrumbList', 'SoftwareApplication', 'FAQPage']);
  });
});

describe('what crawlers read', () => {
  it('lists every working page in the sitemap, in both languages', async () => {
    const res = await get('/sitemap.xml');
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();
    for (const path of [
      '/',
      '/docs/claude',
      '/services/gmail/chatgpt',
      '/faq',
      '/compare/composio',
      '/guides/multiple-accounts',
    ])
      expect(xml).toContain(`<loc>${hub.baseUrl}${path}</loc>`);
    expect(xml).toContain(`<loc>${hub.baseUrl}/services/gmail/chatgpt?lang=ru</loc>`);
    // Not connectable here: the combinations are left out.
    expect(xml).not.toContain('/services/outlook/');
    expect(xml).not.toContain('/services/demo');
  });

  it('serves robots.txt, llms.txt, llms-full.txt and the preview image', async () => {
    const robots = await (await get('/robots.txt')).text();
    expect(robots).toContain('User-agent: GPTBot');
    expect(robots).toContain(`Sitemap: ${hub.baseUrl}/sitemap.xml`);

    const llms = await get('/llms.txt');
    expect(llms.headers.get('content-type')).toContain('text/plain');
    const short = await llms.text();
    expect(short).toMatch(/^# Manyplug\n\n> /);
    expect(short).toContain(hub.mcpUrl);
    expect(short).toContain(`(${hub.baseUrl}/docs/chatgpt)`);
    expect(short).toContain(`${hub.baseUrl}/llms-full.txt`);
    expect(short).not.toContain('Outlook](');

    const full = await (await get('/llms-full.txt')).text();
    expect(full).toContain('### Gmail');
    expect(full).toContain('claude mcp add --transport http');
    expect(full).toContain('risky, asks first by default');
    expect(full).not.toMatch(/\{(count|freeAccounts|from)\}/);

    const og = await get('/assets/og.png');
    expect(og.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await og.arrayBuffer());
    expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join('')).toBe('PNG');
  });
});
