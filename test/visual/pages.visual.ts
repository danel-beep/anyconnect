import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeOidc } from '../fake-oidc.js';
import { enableTotp, resetDatabase, startTestHub, TestBrowser, type TestHub } from '../helpers.js';
import { SoftwareAuthenticator } from '../webauthn-authenticator.js';
import { BOXES, checkLayout, type LayoutProblem } from './layout-checks.js';

/**
 * Visual check of every page: a real Chromium opens each page of the site, the dashboard and the
 * admin panel in light and dark theme, on a desktop and a phone, in English and Russian, and checks
 * the layout rules in `layout-checks.ts`. Pages are found by following links, so a new page is
 * covered without touching this file.
 *
 * `npm run test:visual`. A page that breaks a rule is saved as a screenshot in `visual-failures/`
 * (or `VISUAL_FAILURES`); with `VISUAL_SCREENSHOTS=<dir>` every page and variant is saved there, to
 * look at by eye.
 */

const SHOTS = process.env.VISUAL_SCREENSHOTS;
/** Pages that break a rule are always saved here (CI uploads the folder). */
const FAILED_SHOTS = process.env.VISUAL_FAILURES ?? 'visual-failures';
const VIEWPORTS = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } } as const;
const THEMES = ['light', 'dark'] as const;
const LANGS = ['en', 'ru'] as const;

/** Links that are not pages to look at. */
const SKIP =
  /^\/(assets|auth|logout|prefs|oauth|billing|mcp|api|\.well-known)\b|\.(xml|txt|json|png|svg|ico)$|^\/connect\/callback/;

/**
 * One page per shape of URL is enough: `/blog/a` and `/blog/b` share a template. Segments that look
 * like ids or slugs collapse into `*`, so `/app/accounts/acc_1` and `/services/gmail` each count once.
 */
function shape(url: string): string {
  const [path = '', query = ''] = url.split('?');
  const parts = path.split('/').filter(Boolean);
  // Fixed second-level pages of the app and the admin keep their names.
  const fixed = /^(app|admin)$/.test(parts[0] ?? '') ? 2 : 1;
  // A tab is another page; filters and periods are the same page with other numbers.
  const tab = new URLSearchParams(query).get('tab');
  return `/${parts.map((p, i) => (i < fixed ? p : '*')).join('/')}${tab ? `?tab=${tab}` : ''}`;
}

interface Persona {
  name: string;
  cookies: [string, string][];
  /** Where crawling starts; links found there are followed (same origin only). */
  start: string[];
  /** Crawl only below these prefixes, so a persona does not re-check the public site. */
  within: RegExp;
}

let hub: TestHub;
const google = new FakeOidc();
let browser: Browser;
const personas: Persona[] = [];

async function seed(): Promise<void> {
  // The owner: admin with a second factor, two passkeys and a team.
  const owner = new TestBrowser(hub.baseUrl);
  await owner.login();
  await enableTotp(owner);
  const { csrf } = TestBrowser.hiddenInputs(await (await owner.request('/security')).text());
  const authenticator = new SoftwareAuthenticator(hub.baseUrl);
  for (const aaguid of ['fbfc3007-154e-4ecc-8c0b-6e020557d7bd', undefined]) {
    const options = await (await owner.request('/security/passkeys/options', { json: { csrf } })).json();
    await owner.request('/security/passkeys', {
      json: { csrf, response: authenticator.create(options as never, aaguid ? { aaguid } : {}) },
    });
  }
  // The admin panel's error list with an error group and its stack trace, not only the empty state.
  hub.services.ops.errors.capture(new Error('Upstream service timed out after 30 seconds'), {
    source: 'job',
    context: { job: 'status.sample' },
  });
  await hub.services.ops.errorStore.flush();
  const teams = TestBrowser.hiddenInputs(await (await owner.request('/app/teams')).text());
  await owner.request('/app/teams', { form: { ...teams, name: 'Acme sales' } });
  personas.push({
    name: 'owner',
    cookies: owner.cookieEntries(),
    start: ['/app', '/admin', '/admin/analytics?days=365', '/security', '/confirm'],
    within: /^\/(app|admin|security|confirm|connect)\b/,
  });

  // A brand-new user: every empty state.
  const fresh = new TestBrowser(hub.baseUrl);
  const signedIn = await google.signIn(fresh, {
    sub: 'visual-fresh',
    email: 'new.user@example.com',
    name: 'New User',
  });
  expect(signedIn.status, 'new user sign-in').toBeLessThan(400);
  personas.push({
    name: 'new user',
    cookies: fresh.cookieEntries(),
    start: ['/app', '/security', '/confirm'],
    within: /^\/(app|security|confirm)\b/,
  });

  // A visitor: the public site and the sign-in pages.
  personas.push({
    name: 'visitor',
    cookies: [],
    start: ['/', '/login', '/signup', '/status', '/support'],
    within: /^\/(?!app|admin|security|confirm)/,
  });
}

async function contextFor(persona: Persona, lang: string, theme: string, viewport: keyof typeof VIEWPORTS) {
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport],
    colorScheme: theme as 'light' | 'dark',
    reducedMotion: 'reduce',
  });
  const url = new URL(hub.baseUrl);
  await context.addCookies(
    [...persona.cookies.filter(([name]) => name !== 'ac_lang'), ['ac_lang', lang] as [string, string]].map(
      ([name, value]) => ({ name, value, domain: url.hostname, path: '/' }),
    ),
  );
  return context;
}

/** Follows links from the persona's start pages, one page per URL shape. */
async function crawl(context: BrowserContext, persona: Persona): Promise<string[]> {
  const page = await context.newPage();
  const seen = new Set<string>();
  const queue = [...persona.start];
  const pages: string[] = [];
  while (queue.length > 0 && pages.length < 120) {
    const path = queue.shift()!;
    const key = shape(path);
    // Start pages are always looked at (e.g. a year of analytics next to the default month).
    if (seen.has(key) && !persona.start.includes(path)) continue;
    seen.add(key);
    const response = await page.goto(hub.baseUrl + path);
    if (!response || response.status() >= 400 || !response.headers()['content-type']?.includes('text/html'))
      continue;
    const landed = new URL(page.url()).pathname;
    if (landed !== path.split('?')[0]) {
      // Redirected (e.g. to sign in): look at where it went only if it is ours to check.
      if (!persona.within.test(landed) || seen.has(shape(landed))) continue;
      seen.add(shape(landed));
    }
    pages.push(path);
    const links = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href') ?? ''));
    for (const href of links) {
      if (!href.startsWith('/') || href.startsWith('//')) continue;
      const clean = href.split('#')[0]!;
      if (!clean || SKIP.test(clean) || !persona.within.test(clean)) continue;
      if (!seen.has(shape(clean))) queue.push(clean);
    }
  }
  await page.close();
  return pages;
}

describe('every page keeps its layout', () => {
  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ loginProviders: [google.provider] });
    browser = await chromium.launch(
      process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
    );
    await seed();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await hub?.close();
  });

  it('in light and dark theme, on a desktop and a phone, in English and Russian', async () => {
    /** One entry per problem, with every variant it shows up in. */
    const failures = new Map<string, { detail: string; variants: string[] }>();
    for (const persona of personas) {
      const crawlContext = await contextFor(persona, 'en', 'light', 'desktop');
      const pages = await crawl(crawlContext, persona);
      await crawlContext.close();
      expect(pages.length, `${persona.name}: no pages found`).toBeGreaterThan(0);
      for (const lang of LANGS) {
        for (const theme of THEMES) {
          for (const viewport of Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[]) {
            const context = await contextFor(persona, lang, theme, viewport);
            const page = await context.newPage();
            for (const path of pages) {
              await page.goto(hub.baseUrl + path, { waitUntil: 'load' });
              await page.evaluate('document.fonts.ready');
              const problems = (await page.evaluate(
                `(${checkLayout.toString()})(${JSON.stringify(BOXES)})`,
              )) as LayoutProblem[];
              for (const p of problems) {
                const key = `${persona.name} ${path} ${p.rule}: ${p.where}`;
                const entry = failures.get(key) ?? { detail: p.detail, variants: [] };
                entry.variants.push(`${lang} ${theme} ${viewport}`);
                failures.set(key, entry);
              }
              const folder = SHOTS ?? (problems.length > 0 ? FAILED_SHOTS : undefined);
              if (folder) {
                const dir = join(folder, persona.name.replace(/\W+/g, '-'));
                mkdirSync(dir, { recursive: true });
                const file = `${path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'}.${lang}.${theme}.${viewport}.png`;
                await page.screenshot({ path: join(dir, file), fullPage: true });
              }
            }
            await context.close();
          }
        }
      }
    }
    const report = [...failures].map(([key, f]) => `${key} — ${f.detail} [${f.variants.join(', ')}]`);
    if (SHOTS) writeFileSync(join(SHOTS, 'problems.txt'), `${report.join('\n')}\n`);
    expect(report, report.join('\n')).toEqual([]);
  }, 900_000);
});
