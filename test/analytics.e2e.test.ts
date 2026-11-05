import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeOidc } from './fake-oidc.js';
import { enableTotp, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/**
 * Analytics end to end: page views through the real middleware, the buffered write, daily visitor
 * rows, crawler counters, sign-up attribution through "Sign in with Google", and the admin page.
 */

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
const EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const GPTBOT =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';

function visitor(hub: TestHub, userAgent: string, extra: Record<string, string> = {}): TestBrowser {
  const browser = new TestBrowser(hub.baseUrl);
  Object.assign(browser.headers, { 'user-agent': userAgent, accept: 'text/html', ...extra });
  return browser;
}

describe('analytics: traffic, attribution and the admin page', () => {
  let hub: TestHub;
  let oidc: FakeOidc;
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await hub.services.database.pool.query(text, params)).rows as T[];

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await hub?.close();
    oidc = new FakeOidc();
    hub = await startTestHub({ loginProviders: [oidc.provider] });
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('counts one visit per visitor and day with its source, country, language and device', async () => {
    const ad = visitor(hub, CHROME, { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8', 'cf-ipcountry': 'DE' });
    expect((await ad.request('/?utm_source=telegram&utm_medium=ads&utm_campaign=tg_ai_1')).status).toBe(200);
    expect((await ad.request('/pricing')).status).toBe(200);
    const ai = visitor(hub, IPHONE, { 'accept-language': 'en-US', referer: 'https://chatgpt.com/' });
    await ai.request('/');
    // Crawlers: counted by family, never as visitors; robots.txt and llms.txt count too.
    const bot = visitor(hub, GPTBOT);
    await bot.request('/');
    await bot.request('/llms.txt');
    // Not pages: 404s, JSON and the admin panel.
    await ad.request('/no-such-page');
    await ad.request('/healthz');
    await hub.services.analytics.flush();

    const visits = await q(
      `select source, medium, campaign, country, language, device, browser, os, pageviews, landing_path, known
       from analytics_visits order by pageviews desc`,
    );
    expect(visits).toEqual([
      {
        source: 'telegram',
        medium: 'ads',
        campaign: 'tg_ai_1',
        country: 'DE',
        language: 'de',
        device: 'desktop',
        browser: 'chrome',
        os: 'macos',
        pageviews: 2,
        landing_path: '/',
        known: false,
      },
      {
        source: 'chatgpt',
        medium: 'ai',
        campaign: null,
        country: null,
        language: 'en',
        device: 'mobile',
        browser: 'safari',
        os: 'ios',
        pageviews: 1,
        landing_path: '/',
        known: false,
      },
    ]);
    // No address or browser string is stored anywhere: only the daily hash.
    const [row] = await q<{ visitor: string }>('select visitor from analytics_visits limit 1');
    expect(row!.visitor).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await q('select path, views from analytics_pages order by path')).toEqual([
      { path: '/', views: 2 },
      { path: '/pricing', views: 1 },
    ]);
    expect(await hub.services.analytics.eventTotals(['crawler'])).toEqual([
      { name: 'crawler', key: 'openai', count: 2 },
    ]);
  });

  it('gives a direct visit the source of a later page view that has one, across writes', async () => {
    const browser = visitor(hub, EDGE);
    await browser.request('/');
    await hub.services.analytics.flush();
    await browser.request('/pricing?utm_source=newsletter&utm_medium=email&utm_campaign=nov');
    await browser.request('/?utm_source=other');
    await hub.services.analytics.flush();
    expect(await q('select source, medium, campaign, pageviews, landing_path from analytics_visits')).toEqual(
      [{ source: 'newsletter', medium: 'email', campaign: 'nov', pageviews: 3, landing_path: '/' }],
    );
  });

  it('links a sign-up to the same browser’s visit, and says unknown when there was none', async () => {
    const ad = visitor(hub, CHROME, { 'accept-language': 'de', 'cf-ipcountry': 'DE' });
    await ad.request('/?utm_source=telegram&utm_medium=ads&utm_campaign=tg_ai_1');
    await ad.request('/login');
    const done = await oidc.signIn(ad, { sub: 'g-ad', email: 'ad@example.com', name: 'Ad' });
    expect(done.headers.get('location')).toBe('/app?welcome=1');

    const fresh = visitor(hub, FIREFOX, { 'accept-language': 'fr-FR', 'cf-ipcountry': 'FR' });
    await oidc.signIn(fresh, { sub: 'g-fresh', email: 'fresh@example.com' });

    const rows = await q(
      `select u.email, a.source, a.medium, a.campaign, a.country, a.language, a.device, a.browser, a.matched
       from user_attribution a join users u on u.id = a.user_id order by u.email`,
    );
    expect(rows).toEqual([
      {
        email: 'ad@example.com',
        source: 'telegram',
        medium: 'ads',
        campaign: 'tg_ai_1',
        country: 'DE',
        language: 'de',
        device: 'desktop',
        browser: 'chrome',
        matched: true,
      },
      {
        email: 'fresh@example.com',
        source: 'unknown',
        medium: 'unknown',
        campaign: null,
        country: 'FR',
        language: 'fr',
        device: 'desktop',
        browser: 'firefox',
        matched: false,
      },
    ]);
    // Signing in again changes nothing.
    await oidc.signIn(ad, { sub: 'g-ad', email: 'ad@example.com' });
    expect(await q('select count(*)::int as n from user_attribution')).toEqual([{ n: 2 }]);
    await hub.services.analytics.flush();
    expect(await hub.services.analytics.eventTotals(['signup'])).toEqual([
      { name: 'signup', key: 'google', count: 2 },
    ]);
    // Dashboard pages count as usage, not as visits; a signed-in visitor is kept out of traffic.
    await ad.request('/app');
    await ad.request('/pricing');
    await hub.services.analytics.flush();
    expect(await q(`select views from analytics_pages where path = '/app'`)).toEqual([{ views: 1 }]);
    expect(await q('select known from analytics_visits where source = $1', ['telegram'])).toEqual([
      { known: true },
    ]);
  });

  it('shows traffic, funnel, product, plans and retention to admins only', async () => {
    const ad = visitor(hub, CHROME, { 'accept-language': 'de', 'cf-ipcountry': 'DE' });
    await ad.request('/?utm_source=telegram&utm_medium=ads&utm_campaign=tg_ai_1');
    await oidc.signIn(ad, { sub: 'g-ad', email: 'ad@example.com' });
    await ad.request('/connect/demo');

    // Telegram bot starts with the same tag join the campaign's funnel.
    hub.services.analytics.track('bot.start', 'tg_ai_1');
    hub.services.analytics.track('bot.start', 'tg_ai_1');

    const user = visitor(hub, FIREFOX);
    await oidc.signIn(user, { sub: 'g-u', email: 'u@example.com' });
    expect((await user.request('/admin/analytics')).status).toBe(404);

    const admin = visitor(hub, EDGE);
    await admin.login();
    await enableTotp(admin);
    await hub.services.analytics.flush();

    const traffic = await admin.request('/admin/analytics');
    expect(traffic.status).toBe(200);
    const html = await traffic.text();
    expect(html).toContain('tg_ai_1');
    expect(html).toContain('href="/admin/analytics?f.source=telegram"');
    expect(html).toContain('Германия');

    const filtered = await (await admin.request('/admin/analytics?f.source=telegram&days=7')).text();
    expect(filtered).toContain('tg_ai_1');
    expect(filtered).toContain('href="/admin/analytics?days=7"');

    const funnel = await (await admin.request('/admin/analytics?tab=funnel&by=campaign')).text();
    // Campaign, bot starts, visits, sign-ups.
    expect(funnel).toMatch(
      /tg_ai_1<\/a><\/td><td class="right num">2<\/td><td class="right num">1<\/td><td class="right num">1<\/td>/,
    );
    expect(funnel).toContain('Запуски бота');
    const bySource = await (await admin.request('/admin/analytics?tab=funnel&by=source')).text();
    expect(bySource).not.toContain('Запуски бота');

    const product = await admin.request('/admin/analytics?tab=product');
    expect(product.status).toBe(200);
    expect(await product.text()).toContain('connect.start');
    const plans = await (await admin.request('/admin/analytics?tab=plans')).text();
    expect(plans).toContain('href="/admin/revenue"');
    expect(plans).toContain('Пробный период');
    expect((await admin.request('/admin/analytics?tab=retention')).status).toBe(200);
    // The admin's own browsing is not counted.
    await hub.services.analytics.flush();
    expect(await q(`select count(*)::int as n from analytics_pages where path like '/admin%'`)).toEqual([
      { n: 0 },
    ]);
  });

  it('forgets old salts and data past the retention period', async () => {
    await visitor(hub, CHROME).request('/');
    await hub.services.analytics.flush();
    const later = new Date(Date.now() + 3 * 86_400_000);
    await hub.services.analytics.prune(later);
    expect(await q('select count(*)::int as n from analytics_salts')).toEqual([{ n: 0 }]);
    expect(await q('select count(*)::int as n from analytics_visits')).toEqual([{ n: 1 }]);
    await hub.services.analytics.prune(new Date(Date.now() + 500 * 86_400_000));
    expect(await q('select count(*)::int as n from analytics_visits')).toEqual([{ n: 0 }]);
  });
});
