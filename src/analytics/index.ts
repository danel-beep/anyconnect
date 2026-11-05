import type { Db } from '../db/client.js';
import { rateLimitIp } from '../lib/rate-limit.js';
import { cleanTag, crawlerOf, isSitePath, normalizePath, touchFrom } from './classify.js';
import { AnalyticsCollector, visitorTraits } from './collector.js';
import { ChainGeo, type GeoResolver, HeaderGeo, MmdbGeo } from './geo.js';
import { AnalyticsReports } from './reports.js';
import { AnalyticsStore, DailySalts, utcDay, visitorId } from './store.js';

export interface AnalyticsConfig {
  enabled: boolean;
  /** Days visits and daily counters are kept. */
  retentionDays: number;
  /** Request headers with the visitor's country, set by a CDN in front of the hub. */
  countryHeaders: string[];
  /** IP-to-country database: a path, `undefined` for the bundled one, `false` for none. */
  geoipDb: string | false | undefined;
  flushMs: number;
}

/** A request as the HTTP layer hands it over: plain values, no framework types. */
export interface AnalyticsRequest {
  path: string;
  query: (name: string) => string | undefined;
  header: (name: string) => string | undefined;
  ip: string;
  /** A sign-in session cookie came with the request. */
  known: boolean;
  at?: Date;
}

const DAY = 86_400_000;
const EVENT_NAME = /^[a-z][a-z0-9._-]{0,39}$/;

/**
 * First-party product analytics: where visitors come from, what they do on the site, how sign-ups
 * turn into connected AI apps, services and payments. Cookieless and privacy-friendly (see
 * `docs/ANALYTICS.md`): visitors are counted with a daily rotating hash, addresses are never
 * stored, and everything is aggregated per day before it is written.
 *
 * The HTTP layer calls `pageView` for pages it served, features call `track` for product events,
 * and the admin panel reads `reports`. A disabled instance accepts every call and does nothing.
 */
export class Analytics {
  readonly reports: AnalyticsReports;
  private readonly collector: AnalyticsCollector;
  private readonly store: AnalyticsStore;
  private readonly salts: DailySalts;
  private readonly headerGeo: GeoResolver;
  private readonly geo: GeoResolver;

  constructor(
    private readonly deps: {
      db: Db;
      config: AnalyticsConfig;
      /** The public host, so links inside the site do not count as referrals. */
      publicHost: string;
      onError: (error: unknown) => void;
    },
  ) {
    const { db, config } = deps;
    this.store = new AnalyticsStore(db);
    this.salts = new DailySalts(db);
    this.headerGeo = new HeaderGeo(config.countryHeaders);
    const ipGeo: GeoResolver =
      config.geoipDb === false ? { country: () => null } : new MmdbGeo(config.geoipDb, deps.onError);
    this.geo = new ChainGeo([this.headerGeo, ipGeo]);
    this.collector = new AnalyticsCollector({
      store: this.store,
      salts: this.salts,
      geo: ipGeo,
      onError: deps.onError,
      flushMs: config.flushMs,
    });
    this.reports = new AnalyticsReports(db);
  }

  get enabled(): boolean {
    return this.deps.config.enabled;
  }

  start(): void {
    if (this.enabled) this.collector.start();
  }

  /** Writes what is buffered and stops the timer (shutdown). */
  close(): Promise<void> {
    return this.collector.stop();
  }

  flush(): Promise<void> {
    return this.collector.flush();
  }

  /**
   * A page this hub served (HTML, 200). Crawlers are counted per family instead of as visitors.
   * Synchronous and cheap: the work happens when the buffer is written.
   */
  pageView(req: AnalyticsRequest): void {
    if (!this.enabled) return;
    const userAgent = req.header('user-agent') ?? '';
    const at = req.at ?? new Date();
    const crawler = crawlerOf(userAgent);
    if (crawler) {
      this.collector.event('crawler', crawler, 1, at);
      return;
    }
    const path = normalizePath(req.path);
    const site = isSitePath(path);
    this.collector.page({
      at,
      path,
      site,
      touch: site
        ? touchFrom({ query: req.query, referer: req.header('referer'), path, ownHost: this.deps.publicHost })
        : null,
      ip: req.ip,
      userAgent,
      acceptLanguage: req.header('accept-language') ?? null,
      country: this.headerGeo.country({ ip: req.ip, header: req.header }),
      known: req.known,
    });
  }

  /** A crawler fetched something other than a page (robots.txt, llms.txt, a feed). */
  crawlerHit(userAgent: string | undefined): boolean {
    if (!this.enabled) return false;
    const crawler = crawlerOf(userAgent);
    if (crawler) this.collector.event('crawler', crawler);
    return Boolean(crawler);
  }

  /**
   * Counts a product event: `name` is what happened (`connect.start`), `key` what it happened to
   * (`gmail`). Any new name shows up in the admin panel's event list without further code.
   */
  track(name: string, key?: string | null, count = 1): void {
    if (!this.enabled || !EVENT_NAME.test(name)) return;
    this.collector.event(name, cleanTag(key, 100) ?? '', count);
  }

  /**
   * Remembers where a new user came from: the visit of the same visitor today or yesterday (the
   * hash only matches within the salt's two days), else `unknown`. Never throws.
   */
  async attributeSignup(
    userId: string,
    req: Omit<AnalyticsRequest, 'path' | 'query' | 'known'>,
  ): Promise<void> {
    if (!this.enabled) return;
    try {
      const at = req.at ?? new Date();
      await this.collector.flush();
      const userAgent = req.header('user-agent') ?? '';
      const address = rateLimitIp(req.ip);
      const keys: { day: string; visitor: string }[] = [];
      for (const day of [utcDay(at), utcDay(at.getTime() - DAY)]) {
        const salt = await this.salts.forDay(day, false);
        if (salt) keys.push({ day, visitor: visitorId(salt, address, userAgent) });
      }
      const [visit] = await this.store.findVisits(keys);
      const traits = visitorTraits(userAgent, req.header('accept-language') ?? null);
      await this.store.attribute(
        visit
          ? {
              userId,
              source: visit.source,
              medium: visit.medium,
              campaign: visit.campaign,
              term: visit.term,
              content: visit.content,
              referrerHost: visit.referrerHost,
              landingPath: visit.landingPath,
              country: visit.country,
              language: visit.language,
              device: visit.device,
              browser: visit.browser,
              os: visit.os,
              matched: true,
              firstSeenAt: visit.firstAt,
            }
          : {
              userId,
              source: 'unknown',
              medium: 'unknown',
              country: this.geo.country({ ip: req.ip, header: req.header }),
              ...traits,
              matched: false,
            },
      );
    } catch (error) {
      this.deps.onError(error);
    }
  }

  /** Daily clean-up: old salts (unlinkable from then on) and data past the retention period. */
  async prune(now = new Date()): Promise<void> {
    await this.salts.prune(now);
    await this.store.prune(this.deps.config.retentionDays, now);
  }

  /** Event totals by name and key over all days (tests, CLI). */
  eventTotals(names: string[]) {
    return this.store.eventTotals(names);
  }
}

export type { AnalyticsReports } from './reports.js';
