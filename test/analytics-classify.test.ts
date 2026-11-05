import { describe, expect, it } from 'vitest';
import {
  cleanCountry,
  cleanTag,
  crawlerOf,
  isSitePath,
  normalizePath,
  parseBrowser,
  primaryLanguage,
  touchFrom,
} from '../src/analytics/classify.js';
import { monthlyRevenue } from '../src/analytics/reports.js';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EDGE_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
const ANDROID_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36';

const touch = (url: string, referer?: string) => {
  const u = new URL(url, 'https://manyplug.com');
  return touchFrom({
    query: (n) => u.searchParams.get(n) ?? undefined,
    referer,
    path: u.pathname,
    ownHost: 'manyplug.com',
  });
};

describe('analytics: where a visit came from', () => {
  it('reads UTM tags, as the Telegram bot sends them', () => {
    expect(touch('/?utm_source=telegram&utm_medium=ads&utm_campaign=tg_ai_1')).toEqual({
      source: 'telegram',
      medium: 'ads',
      campaign: 'tg_ai_1',
      term: null,
      content: null,
      referrerHost: null,
    });
    // Tags are cleaned: case, spaces and odd characters.
    expect(touch('/?utm_source=Product%20Hunt&utm_campaign=Launch!%20Day').source).toBe('product_hunt');
    expect(touch('/?utm_source=Product%20Hunt&utm_campaign=Launch!%20Day').campaign).toBe('launch_day');
  });

  it('counts invite links (?ref=<code>) as the referral program without keeping the code', () => {
    expect(touch('/?ref=abc123xyz')).toMatchObject({
      source: 'user_invite',
      medium: 'invite',
      campaign: null,
    });
    expect(touch('/?ref=abc123xyz', 'https://t.me/somechannel')).toMatchObject({
      source: 'user_invite',
      referrerHost: 't.me',
    });
    // Campaign tags without a source keep the referring site as their source when known.
    expect(touch('/?utm_campaign=launch', 'https://t.me/somechannel')).toMatchObject({
      source: 'telegram',
      medium: 'social',
      campaign: 'launch',
    });
  });

  it('groups referrers into channels: AI assistants, search, social, other sites', () => {
    expect(touch('/', 'https://chatgpt.com/')).toMatchObject({ source: 'chatgpt', medium: 'ai' });
    expect(touch('/', 'https://claude.ai/chat/123')).toMatchObject({ source: 'claude', medium: 'ai' });
    expect(touch('/', 'https://www.google.com/')).toMatchObject({ source: 'google', medium: 'organic' });
    expect(touch('/', 'https://www.google.com.br/')).toMatchObject({ source: 'google', medium: 'organic' });
    expect(touch('/', 'https://old.reddit.com/r/ClaudeAI')).toMatchObject({
      source: 'reddit',
      medium: 'social',
    });
    expect(touch('/', 'https://blog.example.org/post')).toMatchObject({
      source: 'blog.example.org',
      medium: 'referral',
      referrerHost: 'blog.example.org',
    });
  });

  it('marks ad clicks without tags as paid, and invitations as their own channel', () => {
    expect(touch('/?gclid=abc')).toMatchObject({ source: 'google', medium: 'paid' });
    expect(touch('/?fbclid=abc', 'https://l.facebook.com/')).toMatchObject({
      source: 'facebook',
      medium: 'paid',
    });
    expect(touch('/invite/abc')).toMatchObject({ source: 'team_invite', medium: 'invite' });
  });

  it('counts its own pages and unreadable referrers as direct', () => {
    expect(touch('/pricing', 'https://manyplug.com/')).toMatchObject({ source: 'direct', medium: 'none' });
    expect(touch('/pricing', 'https://www.manyplug.com/')).toMatchObject({ source: 'direct' });
    expect(touch('/', 'android-app://org.telegram.messenger')).toMatchObject({ source: 'direct' });
    expect(touch('/', 'not a url')).toMatchObject({ source: 'direct' });
  });

  it('cleans tags and countries', () => {
    expect(cleanTag('  TG_AI_1 ')).toBe('tg_ai_1');
    expect(cleanTag('___')).toBeNull();
    expect(cleanTag('a'.repeat(80))).toHaveLength(64);
    expect(cleanCountry('de')).toBe('DE');
    expect(cleanCountry('XX')).toBeNull();
    expect(cleanCountry('T1')).toBeNull();
    expect(cleanCountry('USA')).toBeNull();
  });
});

describe('analytics: browsers, crawlers, languages, paths', () => {
  it('tells devices, browsers and systems apart', () => {
    expect(parseBrowser(CHROME_MAC)).toEqual({ device: 'desktop', browser: 'chrome', os: 'macos' });
    expect(parseBrowser(SAFARI_IPHONE)).toEqual({ device: 'mobile', browser: 'safari', os: 'ios' });
    expect(parseBrowser(ANDROID_TABLET)).toEqual({ device: 'tablet', browser: 'chrome', os: 'android' });
    expect(parseBrowser(EDGE_WIN)).toEqual({ device: 'desktop', browser: 'edge', os: 'windows' });
    expect(parseBrowser(FIREFOX_LINUX)).toEqual({ device: 'desktop', browser: 'firefox', os: 'linux' });
    expect(parseBrowser(ANDROID_WEBVIEW)).toMatchObject({ device: 'mobile', browser: 'in_app' });
  });

  it('recognises crawlers by family and leaves browsers alone', () => {
    expect(
      crawlerOf(
        'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      ),
    ).toBe('openai');
    expect(crawlerOf('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)')).toBe('anthropic');
    expect(crawlerOf('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(
      'google',
    );
    expect(crawlerOf('TelegramBot (like TwitterBot)')).toBe('telegram');
    expect(crawlerOf('curl/8.5.0')).toBe('script');
    expect(crawlerOf('')).toBe('script');
    expect(crawlerOf(undefined)).toBe('script');
    expect(crawlerOf('Mozilla/5.0 (compatible; SomeNewBot/1.0)')).toBe('other');
    expect(crawlerOf(CHROME_MAC)).toBeUndefined();
    expect(crawlerOf(SAFARI_IPHONE)).toBeUndefined();
  });

  it('picks the preferred language', () => {
    expect(primaryLanguage('de-DE,de;q=0.9,en-US;q=0.8')).toBe('de');
    expect(primaryLanguage('en-US;q=0.5, ru;q=0.9')).toBe('ru');
    expect(primaryLanguage('*')).toBeNull();
    expect(primaryLanguage(undefined)).toBeNull();
  });

  it('normalizes paths so ids and tokens do not split pages', () => {
    expect(normalizePath('/pricing?plan=pro')).toBe('/pricing');
    expect(normalizePath('/app/apps/acl_01jabcdefghij')).toBe('/app/apps/:id');
    expect(normalizePath('/invite/Xk2pQ9vLmN3rT8sW4yZ1aB')).toBe('/invite/:id');
    expect(normalizePath('/docs/connect-claude-desktop-to-gmail-and-calendar')).toBe(
      '/docs/connect-claude-desktop-to-gmail-and-calendar',
    );
    expect(normalizePath('/blog/')).toBe('/blog');
    expect(normalizePath('/')).toBe('/');
  });

  it('separates the public site from the dashboard', () => {
    expect(isSitePath('/')).toBe(true);
    expect(isSitePath('/pricing')).toBe(true);
    expect(isSitePath('/login')).toBe(true);
    expect(isSitePath('/app')).toBe(false);
    expect(isSitePath('/app/services')).toBe(false);
    expect(isSitePath('/connect/gmail')).toBe(false);
    expect(isSitePath('/apps')).toBe(true);
  });

  it('turns plans into monthly revenue', () => {
    expect(monthlyRevenue('personal', 'month', 1)).toBe(5);
    expect(monthlyRevenue('pro', 'year', 1)).toBe(10);
    // A provider quantity above one multiplies the price (no plan is sold that way today).
    expect(monthlyRevenue('pro', 'month', 2)).toBe(24);
    expect(monthlyRevenue('pro', 'month', null)).toBe(12);
    // A plan that no longer exists (e.g. the per-seat Team plan) brings nothing.
    expect(monthlyRevenue('team', 'month', 5)).toBe(0);
    expect(monthlyRevenue('nope', 'month', 1)).toBe(0);
  });
});
