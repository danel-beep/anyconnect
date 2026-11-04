import { describe, expect, it } from 'vitest';
import { PLANS } from '../src/billing/plans.js';
import { CLIENT_GUIDES } from '../src/web/clients.js';
import { translator } from '../src/web/i18n.js';
import { ARTICLES } from '../src/web/seo/articles.js';
import { CLIENT_PAGES, clientIdBySlug } from '../src/web/seo/client-pages.js';
import { COMPARE_PAGES } from '../src/web/seo/compare-pages.js';
import { AI_CRAWLERS, PRIVATE_PATHS, robotsTxt, sitemapXml } from '../src/web/seo/crawlers.js';
import { fill, planFacts } from '../src/web/seo/facts.js';
import { faqPage, serializeJsonLd, softwareApplication } from '../src/web/seo/structured-data.js';
import type { Localized } from '../src/web/seo/types.js';
import { alternates, localizedPath, parseLocale, withoutLang } from '../src/web/seo/urls.js';

/** Placeholders that the pages fill in; any other `{…}` in content would show up literally. */
const KNOWN_PLACEHOLDERS = new Set(['count', 'from', 'freeAccounts', 'url']);

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

/** Every string inside a content object. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** The same shape in both languages: same keys, same list lengths. */
function shape(value: unknown): unknown {
  if (typeof value === 'string') return 's';
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
  return value;
}

const sameShape = <T>(content: Localized<T>) => expect(shape(content.ru)).toEqual(shape(content.en));

describe('language addresses', () => {
  it('keeps English at the plain path and adds ?lang= for Russian', () => {
    expect(localizedPath('/docs', 'en')).toBe('/docs');
    expect(localizedPath('/docs', 'ru')).toBe('/docs?lang=ru');
    expect(localizedPath('/docs?lang=ru', 'en')).toBe('/docs');
    expect(localizedPath('/services?q=mail#x', 'ru')).toBe('/services?q=mail&lang=ru#x');
    expect(withoutLang('/faq?lang=ru&a=1')).toBe('/faq?a=1');
    expect(parseLocale('ru')).toBe('ru');
    expect(parseLocale('de')).toBeUndefined();
    expect(parseLocale(undefined)).toBeUndefined();
  });

  it('lists every language and an English x-default', () => {
    expect(alternates('https://manyplug.com', '/faq')).toEqual([
      { hreflang: 'en', href: 'https://manyplug.com/faq' },
      { hreflang: 'ru', href: 'https://manyplug.com/faq?lang=ru' },
      { hreflang: 'x-default', href: 'https://manyplug.com/faq' },
    ]);
  });
});

describe('crawlers', () => {
  it('welcomes search and AI crawlers to the public pages and keeps private paths out', () => {
    const robots = robotsTxt('https://manyplug.com');
    for (const bot of [
      'GPTBot',
      'OAI-SearchBot',
      'ClaudeBot',
      'Claude-SearchBot',
      'PerplexityBot',
      'Google-Extended',
    ])
      expect(robots).toContain(`User-agent: ${bot}`);
    expect(AI_CRAWLERS.length).toBeGreaterThan(10);
    // A bot that matches a named group ignores the `*` group, so the named group repeats the rules.
    const groups = robots.split('\n\n').filter((g) => g.includes('User-agent:'));
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group).toContain('Allow: /');
      for (const path of PRIVATE_PATHS) expect(group).toContain(`Disallow: ${path}`);
    }
    expect(robots).toContain('Sitemap: https://manyplug.com/sitemap.xml');
    expect(robots).not.toMatch(/Disallow: \/\s*$/m);
  });

  it('writes a sitemap with every language version and its alternates', () => {
    const xml = sitemapXml('https://manyplug.com', [{ path: '/', priority: 1 }, { path: '/docs/claude' }]);
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml.match(/<url>/g)).toHaveLength(4);
    expect(xml).toContain('<loc>https://manyplug.com/docs/claude?lang=ru</loc>');
    expect(xml).toContain('hreflang="x-default" href="https://manyplug.com/docs/claude"');
    expect(xml).toContain('<priority>1.0</priority>');
  });

  it('escapes URLs in the sitemap', () => {
    const xml = sitemapXml('https://manyplug.com', [{ path: '/services?a=1&b=2' }]);
    expect(xml).toContain('a=1&amp;b=2');
    expect(xml).not.toMatch(/&b=/);
  });
});

describe('structured data', () => {
  it('cannot be closed from inside the script element', () => {
    const json = serializeJsonLd(faqPage([{ q: '</script><script>alert(1)</script>', a: 'a & b' }]));
    expect(json).not.toContain('<');
    expect(json).not.toContain('>');
    expect(JSON.parse(json).mainEntity[0].name).toBe('</script><script>alert(1)</script>');
  });

  it('lists the public plans as offers in USD', () => {
    const app = softwareApplication('https://manyplug.com', {
      description: 'd',
      plans: PLANS,
      planName: (p) => p.id,
    });
    const offers = app.offers as { name: string; price: string; priceCurrency: string }[];
    expect(offers.map((o) => o.name)).toEqual(PLANS.filter((p) => p.public).map((p) => p.id));
    expect(offers.every((o) => o.priceCurrency === 'USD')).toBe(true);
    expect(offers[0]!.price).toBe('0');
  });
});

describe('docs content', () => {
  it('has a guide page for every AI client, with unique slugs', () => {
    for (const guide of CLIENT_GUIDES) expect(CLIENT_PAGES[guide.id], guide.id).toBeDefined();
    const slugs = Object.values(CLIENT_PAGES).map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const [id, page] of Object.entries(CLIENT_PAGES)) {
      expect(clientIdBySlug(page.slug)).toBe(id);
      expect(page.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('says the same in both languages', () => {
    for (const page of Object.values(CLIENT_PAGES)) {
      sameShape(page.intro);
      sameShape(page.requirements);
      sameShape(page.troubleshooting);
      sameShape(page.faq);
    }
    for (const page of COMPARE_PAGES) sameShape(page.body);
    for (const article of ARTICLES) sameShape(article.body);
    for (const guide of CLIENT_GUIDES) sameShape(guide.steps);
  });

  it('uses only placeholders the pages fill in', () => {
    const all = [
      ...strings(Object.values(CLIENT_PAGES)),
      ...strings(COMPARE_PAGES.map((p) => p.body)),
      ...strings(ARTICLES.map((a) => a.body)),
    ];
    for (const text of all)
      for (const name of placeholders(text)) expect(KNOWN_PLACEHOLDERS, text).toContain(name);
  });

  it('dates every comparison and lists its sources', () => {
    for (const page of COMPARE_PAGES) {
      expect(page.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(page.sources.length).toBeGreaterThan(0);
      for (const s of page.sources) expect(s.url).toMatch(/^https:\/\//);
      // Every page says when the other product is the better pick.
      expect(page.body.en.chooseOther.length).toBeGreaterThan(0);
    }
  });

  it('quotes the plan catalogue, not made-up numbers', () => {
    const facts = planFacts();
    const free = PLANS.find((p) => p.id === 'free')!;
    expect(facts.actions).toBe(free.limits.actions);
    expect(facts.accounts).toBe(free.limits.accounts);
    expect(facts.from).toBe(
      `$${Math.min(...PLANS.filter((p) => p.public && p.priceMonthly > 0).map((p) => p.priceMonthly))}`,
    );
    expect(fill('{count} services from {from}', { count: 5, from: '$5' })).toBe('5 services from $5');
    expect(fill('{unknown}', {})).toBe('{unknown}');
  });

  it('writes Russian plural forms of the free plan right', () => {
    const t = translator('ru');
    const text = t('seo.faq.free.a', {
      client: 'Claude',
      actions: 150,
      intro: 500,
      days: 30,
      accounts: 3,
      from: '$5',
    });
    expect(text).toContain('150 действий');
    expect(text).toContain('30 дней');
    expect(text).toContain('3 подключённых аккаунтов');
    expect(text).not.toMatch(/\{/);
  });
});
