import { rateLimitIp } from '../lib/rate-limit.js';
import { type Browser, isDirect, parseBrowser, primaryLanguage, type Touch } from './classify.js';
import type { GeoResolver } from './geo.js';
import {
  type AnalyticsStore,
  type DailySalts,
  type EventRow,
  utcDay,
  type VisitRow,
  visitorId,
} from './store.js';

/** One page view as the HTTP layer saw it. Kept in memory for a few seconds, never written as is. */
export interface PageHit {
  at: Date;
  /** Normalized path (`normalizePath`). */
  path: string;
  /** A page of the public site: its view also counts as (part of) a visit. */
  site: boolean;
  /** Where a site page view came from; null for dashboard pages. */
  touch: Touch | null;
  ip: string;
  userAgent: string;
  acceptLanguage: string | null;
  /** The country a CDN header already named, if any. */
  country: string | null;
  /** The browser has a sign-in session. */
  known: boolean;
}

export interface CollectorOptions {
  store: AnalyticsStore;
  salts: DailySalts;
  /** Country from the IP address when no header named it. */
  geo: GeoResolver;
  onError: (error: unknown) => void;
  flushMs: number;
  /** Page views held at most; beyond it new ones are dropped (and counted) until the next flush. */
  maxBuffered?: number;
}

const FLUSH_AT = 2000;

/**
 * Buffers page views and event counters in memory and writes them every few seconds as a handful
 * of upserts, so a page view costs the request nothing but an array push. Everything is reduced to
 * daily aggregates before it reaches the database: one row per visitor and day, one counter per
 * page and day, one per event. A failed write is reported and dropped: analytics never retries
 * into an outage or slows the site down.
 */
export class AnalyticsCollector {
  private hits: PageHit[] = [];
  private events = new Map<string, EventRow>();
  private dropped = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private readonly max: number;

  constructor(private readonly opts: CollectorOptions) {
    this.max = opts.maxBuffered ?? 20_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.opts.flushMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  page(hit: PageHit): void {
    if (this.hits.length >= this.max) {
      this.dropped += 1;
      return;
    }
    this.hits.push(hit);
    if (this.hits.length >= FLUSH_AT) void this.flush();
  }

  event(name: string, key: string, count = 1, at = new Date()): void {
    const day = utcDay(at);
    const id = `${day}\u0000${name}\u0000${key}`;
    const row = this.events.get(id);
    if (row) row.count += count;
    else this.events.set(id, { day, name, key, count });
  }

  /** Writes everything buffered so far; concurrent calls queue up behind each other. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.write()).catch((error) => this.opts.onError(error));
    return this.chain;
  }

  private async write(): Promise<void> {
    const hits = this.hits;
    const events = this.events;
    this.hits = [];
    this.events = new Map();
    if (this.dropped) {
      this.event('analytics.dropped', '', this.dropped);
      this.dropped = 0;
    }
    if (!hits.length && !events.size) return;

    const pages = new Map<string, { day: string; path: string; views: number }>();
    const visits = new Map<string, VisitRow>();
    for (const hit of hits) {
      const day = utcDay(hit.at);
      const pageKey = `${day}\u0000${hit.path}`;
      const page = pages.get(pageKey);
      if (page) page.views += 1;
      else pages.set(pageKey, { day, path: hit.path, views: 1 });
      if (!hit.site || !hit.touch) continue;
      const touch = hit.touch;

      const salt = await this.opts.salts.forDay(day);
      if (!salt) continue;
      const visitor = visitorId(salt, rateLimitIp(hit.ip), hit.userAgent);
      const id = `${day}\u0000${visitor}`;
      const visit = visits.get(id);
      if (!visit) {
        visits.set(id, newVisit(day, visitor, hit, touch, this.country(hit)));
        continue;
      }
      visit.pageviews = (visit.pageviews ?? 0) + 1;
      if (hit.at > visit.lastAt) visit.lastAt = hit.at;
      if (hit.at < visit.firstAt) visit.firstAt = hit.at;
      visit.known = Boolean(visit.known) || hit.known;
      if (visit.source === 'direct' && !isDirect(touch)) Object.assign(visit, touchColumns(touch));
    }
    // Every write is attempted: a failing page counter does not cost the visits.
    const results = await Promise.allSettled([
      this.opts.store.writeVisits([...visits.values()]),
      this.opts.store.writePages([...pages.values()]),
      this.opts.store.writeEvents([...events.values()]),
    ]);
    for (const result of results) if (result.status === 'rejected') this.opts.onError(result.reason);
  }

  private country(hit: PageHit): string | null {
    return hit.country ?? this.opts.geo.country({ ip: hit.ip, header: () => undefined });
  }
}

const touchColumns = (touch: Touch) => ({
  source: touch.source,
  medium: touch.medium,
  campaign: touch.campaign,
  term: touch.term,
  content: touch.content,
  referrerHost: touch.referrerHost,
});

/** What a visitor looks like: the browser and language, for visits and sign-ups alike. */
export function visitorTraits(
  userAgent: string,
  acceptLanguage: string | null,
): Browser & { language: string | null } {
  return { ...parseBrowser(userAgent), language: primaryLanguage(acceptLanguage) };
}

function newVisit(
  day: string,
  visitor: string,
  hit: PageHit,
  touch: Touch,
  country: string | null,
): VisitRow {
  return {
    day,
    visitor,
    ...touchColumns(touch),
    landingPath: hit.path,
    country,
    ...visitorTraits(hit.userAgent, hit.acceptLanguage),
    known: hit.known,
    pageviews: 1,
    firstAt: hit.at,
    lastAt: hit.at,
  };
}
