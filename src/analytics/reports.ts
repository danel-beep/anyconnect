import { type SQL, sql } from 'drizzle-orm';
import { DEFAULT_PLAN_ID, findPlan } from '../billing/plans.js';
import { REFERRAL_PROVIDER } from '../billing/referrals.js';
import type { Db } from '../db/client.js';
import { isSitePath } from './classify.js';

/** What a visit or a sign-up can be broken down (and filtered) by. */
export const DIMENSIONS = [
  'source',
  'medium',
  'campaign',
  'referrer',
  'landing',
  'country',
  'language',
  'device',
  'browser',
  'os',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const isDimension = (value: string): value is Dimension =>
  (DIMENSIONS as readonly string[]).includes(value);

/** Column names, shared by `analytics_visits` and `user_attribution`. */
const COLUMN: Record<Dimension, string> = {
  source: 'source',
  medium: 'medium',
  campaign: 'campaign',
  referrer: 'referrer_host',
  landing: 'landing_path',
  country: 'country',
  language: 'language',
  device: 'device',
  browser: 'browser',
  os: 'os',
};

/** The value that stands for "not set" in reports and filters. */
export const NONE = '(none)';

/** Inclusive UTC days `from`…`to` (`YYYY-MM-DD`). */
export interface Range {
  from: string;
  to: string;
}

/** Dimension = value pairs every number of a report is limited to. */
export type Filter = Partial<Record<Dimension, string>>;

export interface Count {
  value: string;
  visits: number;
  signups: number;
}

export interface TrafficReport {
  totals: {
    visits: number;
    pageviews: number;
    /** Visits that saw one page only. */
    bounces: number;
    signups: number;
    /** Visits and views by people who were signed in (kept out of the numbers above). */
    knownVisits: number;
    knownPageviews: number;
  };
  days: { day: string; visits: number; pageviews: number; signups: number }[];
  breakdown: Record<Dimension, Count[]>;
  pages: { path: string; views: number }[];
  crawlers: { key: string; count: number }[];
}

export interface FunnelRow {
  value: string;
  /**
   * Telegram bot starts with this campaign tag (`bot.start`), only when the funnel is split by
   * campaign without other filters: starts carry no other dimension.
   */
  botStarts?: number;
  visits: number;
  signups: number;
  ai: number;
  services: number;
  active: number;
  paid: number;
  /** Monthly recurring revenue of the paying ones, USD. */
  mrr: number;
}

export interface ProductReport {
  connectors: { connectorId: string; calls: number; errors: number; workspaces: number }[];
  actions: { connectorId: string; action: string; calls: number; errors: number; workspaces: number }[];
  /** Workspaces with at least one call, per day. */
  activeDays: { day: string; workspaces: number }[];
  wau: number;
  mau: number;
  aiApps: { name: string; workspaces: number; connections: number }[];
  tokenWorkspaces: number;
  accounts: { connectorId: string; total: number; added: number; starts: number }[];
  dashboard: { path: string; views: number }[];
  events: { name: string; count: number }[];
}

/**
 * How a workspace holds its plan: paid through a payment provider, in the free plan's trial, on
 * the free plan, or given (by an admin or as an invite reward).
 */
export type PlanKind = 'paid' | 'trial' | 'free' | 'gift';

export interface PlanRow {
  planId: string;
  kind: PlanKind;
  /** Billing interval of a paid plan, otherwise null. */
  interval: string | null;
  workspaces: number;
  seats: number;
  /** Workspaces with at least one call through the hub in the period, and their calls. */
  active: number;
  calls: number;
  mrr: number;
}

/**
 * Which plans are in force and how much they are used. Money in depth (conversion, churn, invites)
 * is on the revenue page (`src/admin/revenue.ts`); this adds usage per plan and MRR per traffic source.
 */
export interface PlansReport {
  mrr: number;
  paying: number;
  workspaces: number;
  active: number;
  plans: PlanRow[];
  bySource: { source: string; paying: number; mrr: number }[];
}

export interface RetentionReport {
  cohorts: { week: string; size: number; active: number[] }[];
  weeks: number;
}

const DAY = 86_400_000;
/**
 * A subscription someone pays for, as the revenue page (`src/admin/revenue.ts`) counts it: from a
 * payment provider (not set by an admin, not an invite reward) and in good standing. Alias `s`.
 */
const PAID = sql.raw(
  `s.provider not in ('manual', '${REFERRAL_PROVIDER}') and s.external_id is not null and s.plan_id <> 'free' and s.status in ('active','trialing','past_due')`,
);
/** The free plan's trial length (see `PLANS[free].start`). */
const TRIAL_DAYS = findPlan(DEFAULT_PLAN_ID)?.start?.trial.days ?? 0;
const KIND_ORDER: Record<PlanKind, number> = { paid: 0, trial: 1, gift: 2, free: 3 };
const TOP = 15;

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (v === null || v === undefined ? NONE : String(v));
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString();
const startOf = (day: string) => `${day}T00:00:00.000Z`;

/** Monthly revenue of one subscription, USD (yearly prices spread over 12 months). */
export function monthlyRevenue(planId: string, interval: string | null, quantity: number | null): number {
  const plan = findPlan(planId);
  if (!plan) return 0;
  const units = plan.perSeat ? Math.max(plan.perSeat.min, quantity ?? 1) : 1;
  const price = interval === 'year' ? plan.priceYearly / 12 : plan.priceMonthly;
  return Math.round(price * units * 100) / 100;
}

/**
 * The admin panel's analytics reads. Every report is a few grouped queries over daily aggregates
 * (visits per visitor-day, counters per day) and the product tables, cached for a minute so
 * reloading the panel costs nothing. Add a report here, never in route code.
 */
export class AnalyticsReports {
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 60_000,
  ) {}

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value as Promise<T>;
    if (this.cache.size > 200) this.cache.clear();
    const value = load();
    this.cache.set(key, { at: now, value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  /** Drops cached reports (tests, or right after a change an admin wants to see). */
  clearCache(): void {
    this.cache.clear();
  }

  private async rows(query: SQL): Promise<Row[]> {
    const result = await this.db.execute(query);
    return result.rows as Row[];
  }

  /** `and col = value` for each filter on visits (`v`) or attribution (`a`, unknown when missing). */
  private where(filter: Filter, table: 'v' | 'a'): SQL {
    const parts: SQL[] = [];
    for (const [dim, value] of Object.entries(filter) as [Dimension, string][]) {
      const column = this.column(dim, table);
      parts.push(value === NONE ? sql` and ${column} is null` : sql` and ${column} = ${value}`);
    }
    return sql.join(parts, sql``);
  }

  private column(dim: Dimension, table: 'v' | 'a'): SQL {
    const name = sql.raw(`${table}."${COLUMN[dim]}"`);
    // Users who signed up before analytics, or without a matching visit, have no row: `unknown`.
    if (table === 'a' && (dim === 'source' || dim === 'medium')) return sql`coalesce(${name}, 'unknown')`;
    return name;
  }

  traffic(range: Range, filter: Filter = {}): Promise<TrafficReport> {
    return this.cached(`traffic:${JSON.stringify([range, filter])}`, () => this.loadTraffic(range, filter));
  }

  private async loadTraffic(range: Range, filter: Filter): Promise<TrafficReport> {
    const visitsWhere = sql`v.day between ${range.from} and ${range.to}${this.where(filter, 'v')}`;
    const signupsWhere = sql`u.created_at >= ${startOf(range.from)} and u.created_at < ${nextDay(range.to)}${this.where(filter, 'a')}`;
    const sets = sql.raw(DIMENSIONS.map((d) => `(v."${COLUMN[d]}")`).join(', '));
    const setsA = sql.raw(
      DIMENSIONS.map((d) =>
        d === 'source' || d === 'medium' ? `(coalesce(a."${COLUMN[d]}", 'unknown'))` : `(a."${COLUMN[d]}")`,
      ).join(', '),
    );
    const groupingCols = (t: 'v' | 'a') =>
      sql.raw(
        DIMENSIONS.map((d) => {
          const c =
            t === 'a' && (d === 'source' || d === 'medium')
              ? `coalesce(a."${COLUMN[d]}", 'unknown')`
              : `${t}."${COLUMN[d]}"`;
          return `grouping(${c}) as "g_${d}", ${c} as "${d}"`;
        }).join(', '),
      );
    const [daily, signupDays, visitSets, signupSets, pages, crawlers] = await Promise.all([
      this.rows(sql`
        select v.day::text as day,
          count(*) filter (where not v.known) as visits,
          coalesce(sum(v.pageviews) filter (where not v.known), 0) as pageviews,
          count(*) filter (where not v.known and v.pageviews = 1) as bounces,
          count(*) filter (where v.known) as known_visits,
          coalesce(sum(v.pageviews) filter (where v.known), 0) as known_pageviews
        from analytics_visits v where ${visitsWhere} group by v.day`),
      this.rows(sql`
        select to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*) as n
        from users u left join user_attribution a on a.user_id = u.id
        where ${signupsWhere} group by 1`),
      this.rows(sql`
        select ${groupingCols('v')}, count(*) as n
        from analytics_visits v where ${visitsWhere} and not v.known
        group by grouping sets (${sets})`),
      this.rows(sql`
        select ${groupingCols('a')}, count(*) as n
        from users u left join user_attribution a on a.user_id = u.id
        where ${signupsWhere}
        group by grouping sets (${setsA})`),
      this.rows(sql`
        select path, sum(views) as views from analytics_pages
        where day between ${range.from} and ${range.to} group by path order by 2 desc limit 200`),
      this.rows(sql`
        select key, sum(count) as count from analytics_events
        where name = 'crawler' and day between ${range.from} and ${range.to} group by key order by 2 desc`),
    ]);

    const byDay = new Map(daily.map((r) => [String(r.day), r]));
    const signupsByDay = new Map(signupDays.map((r) => [String(r.day), num(r.n)]));
    const days: TrafficReport['days'] = [];
    for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= Date.parse(`${range.to}T00:00:00Z`); t += DAY) {
      const day = new Date(t).toISOString().slice(0, 10);
      const r = byDay.get(day);
      days.push({
        day,
        visits: num(r?.visits),
        pageviews: num(r?.pageviews),
        signups: signupsByDay.get(day) ?? 0,
      });
    }
    const sum = (key: string) => daily.reduce((a, r) => a + num(r[key]), 0);

    const breakdown = Object.fromEntries(DIMENSIONS.map((d) => [d, [] as Count[]])) as Record<
      Dimension,
      Count[]
    >;
    const merge = new Map<string, Count>();
    const add = (rows: Row[], field: 'visits' | 'signups') => {
      for (const r of rows) {
        const dim = DIMENSIONS.find((d) => num(r[`g_${d}`]) === 0);
        if (!dim) continue;
        const value = str(r[dim]);
        const id = `${dim}\u0000${value}`;
        let entry = merge.get(id);
        if (!entry) {
          entry = { value, visits: 0, signups: 0 };
          merge.set(id, entry);
          breakdown[dim].push(entry);
        }
        entry[field] += num(r.n);
      }
    };
    add(visitSets, 'visits');
    add(signupSets, 'signups');
    for (const d of DIMENSIONS) {
      breakdown[d] = breakdown[d]
        .sort((a, b) => b.visits - a.visits || b.signups - a.signups || a.value.localeCompare(b.value))
        .slice(0, TOP);
    }

    return {
      totals: {
        visits: sum('visits'),
        pageviews: sum('pageviews'),
        bounces: sum('bounces'),
        signups: [...signupsByDay.values()].reduce((a, n) => a + n, 0),
        knownVisits: sum('known_visits'),
        knownPageviews: sum('known_pageviews'),
      },
      days,
      breakdown,
      pages: pages
        .map((r) => ({ path: String(r.path), views: num(r.views) }))
        .filter((p) => isSitePath(p.path))
        .slice(0, 20),
      crawlers: crawlers.map((r) => ({ key: String(r.key), count: num(r.count) })),
    };
  }

  /**
   * Sign-ups of the period by `by` and how far each group got: an AI app connected, a service
   * connected, at least one call through the hub, a paid plan (and its monthly revenue). Visits of
   * the same group in the same period are the top of the funnel.
   */
  funnel(range: Range, by: Dimension, filter: Filter = {}): Promise<FunnelRow[]> {
    return this.cached(`funnel:${JSON.stringify([range, by, filter])}`, () =>
      this.loadFunnel(range, by, filter),
    );
  }

  private async loadFunnel(range: Range, by: Dimension, filter: Filter): Promise<FunnelRow[]> {
    const signupsWhere = sql`u.created_at >= ${startOf(range.from)} and u.created_at < ${nextDay(range.to)}${this.where(filter, 'a')}`;
    const value = this.column(by, 'a');
    const visitValue = this.column(by, 'v');
    const withStarts = by === 'campaign' && Object.keys(filter).every((d) => d === 'campaign');
    const [visits, cohort, paid, starts] = await Promise.all([
      this.rows(sql`
        select ${visitValue} as value, count(*) as n from analytics_visits v
        where v.day between ${range.from} and ${range.to} and not v.known${this.where(filter, 'v')}
        group by 1`),
      this.rows(sql`
        with cohort as (
          select u.id, ${value} as value from users u left join user_attribution a on a.user_id = u.id
          where ${signupsWhere}
        ), owned as (
          select m.user_id, m.workspace_id from workspace_members m join cohort c on c.id = m.user_id
          where m.role = 'owner'
        )
        select c.value,
          count(*) as signups,
          count(*) filter (where exists (select 1 from oauth_grants g where g.user_id = c.id)
            or exists (select 1 from api_tokens t where t.user_id = c.id)) as ai,
          count(*) filter (where exists (select 1 from owned o join accounts ac on ac.workspace_id = o.workspace_id
            where o.user_id = c.id)) as services,
          count(*) filter (where exists (select 1 from owned o join usage_counters uc on uc.workspace_id = o.workspace_id
            where o.user_id = c.id and uc.calls > 0)) as active,
          count(*) filter (where exists (select 1 from owned o join subscriptions s on s.workspace_id = o.workspace_id
            where o.user_id = c.id and ${PAID})) as paid
        from cohort c group by c.value`),
      this.rows(sql`
        select ${value} as value, s.plan_id, s.interval, s.quantity
        from users u left join user_attribution a on a.user_id = u.id
        join workspace_members m on m.user_id = u.id and m.role = 'owner'
        join subscriptions s on s.workspace_id = m.workspace_id
        where ${signupsWhere} and ${PAID}`),
      withStarts
        ? this.rows(sql`
            select key as value, sum(count) as n from analytics_events
            where name = 'bot.start' and key <> 'none' and day between ${range.from} and ${range.to}
              ${filter.campaign === undefined ? sql`` : sql`and key = ${filter.campaign}`}
            group by 1`)
        : Promise.resolve([]),
    ]);
    const rows = new Map<string, FunnelRow>();
    const row = (v: unknown) => {
      const key = str(v);
      let r = rows.get(key);
      if (!r) {
        r = { value: key, visits: 0, signups: 0, ai: 0, services: 0, active: 0, paid: 0, mrr: 0 };
        if (withStarts) r.botStarts = 0;
        rows.set(key, r);
      }
      return r;
    };
    for (const r of starts) row(r.value).botStarts = num(r.n);
    for (const r of visits) row(r.value).visits = num(r.n);
    for (const r of cohort) {
      Object.assign(row(r.value), {
        signups: num(r.signups),
        ai: num(r.ai),
        services: num(r.services),
        active: num(r.active),
        paid: num(r.paid),
      });
    }
    for (const r of paid) {
      const target = row(r.value);
      target.mrr =
        Math.round(
          (target.mrr + monthlyRevenue(String(r.plan_id), r.interval as string | null, num(r.quantity))) *
            100,
        ) / 100;
    }
    return [...rows.values()].sort(
      (a, b) => b.signups - a.signups || b.visits - a.visits || a.value.localeCompare(b.value),
    );
  }

  product(range: Range): Promise<ProductReport> {
    return this.cached(`product:${JSON.stringify(range)}`, () => this.loadProduct(range));
  }

  private async loadProduct(range: Range): Promise<ProductReport> {
    const inRange = sql`day between ${range.from} and ${range.to}`;
    const weekFrom = new Date(Date.parse(`${range.to}T00:00:00Z`) - 6 * DAY).toISOString().slice(0, 10);
    const monthFrom = new Date(Date.parse(`${range.to}T00:00:00Z`) - 29 * DAY).toISOString().slice(0, 10);
    const [connectors, actions, activeDays, stickiness, aiApps, tokens, accounts, starts, dashboard, events] =
      await Promise.all([
        this.rows(sql`
          select connector_id, sum(calls) as calls, sum(errors) as errors, count(distinct workspace_id) as workspaces
          from usage_counters where ${inRange} group by 1 order by 2 desc limit 20`),
        this.rows(sql`
          select connector_id, action, sum(calls) as calls, sum(errors) as errors, count(distinct workspace_id) as workspaces
          from usage_counters where ${inRange} group by 1, 2 order by 3 desc limit 20`),
        this.rows(sql`
          select day::text as day, count(distinct workspace_id) as n from usage_counters
          where ${inRange} and calls > 0 group by 1`),
        this.rows(sql`
          select count(distinct workspace_id) filter (where day >= ${weekFrom}) as wau,
            count(distinct workspace_id) as mau
          from usage_counters where day between ${monthFrom} and ${range.to} and calls > 0`),
        this.rows(sql`
          select lower(coalesce(nullif(trim(client_name), ''), 'unknown')) as name,
            count(distinct workspace_id) as workspaces, count(*) as connections
          from oauth_grants where revoked_at is null group by 1 order by 2 desc limit ${TOP}`),
        this.rows(sql`select count(distinct workspace_id) as n from api_tokens where revoked_at is null`),
        this.rows(sql`
          select connector_id, count(*) as total,
            count(*) filter (where created_at >= ${startOf(range.from)} and created_at < ${nextDay(range.to)}) as added
          from accounts group by 1 order by 2 desc limit 30`),
        this.rows(sql`
          select key, sum(count) as n from analytics_events
          where name = 'connect.start' and ${inRange} group by 1`),
        this.rows(sql`
          select path, sum(views) as views from analytics_pages
          where ${inRange} and path not in ('/', '') group by 1 order by 2 desc limit 200`),
        this.rows(sql`
          select name, sum(count) as n from analytics_events where ${inRange} group by 1 order by 2 desc`),
      ]);
    const startsBy = new Map(starts.map((r) => [String(r.key), num(r.n)]));
    const accountRows = accounts.map((r) => ({
      connectorId: String(r.connector_id),
      total: num(r.total),
      added: num(r.added),
      starts: startsBy.get(String(r.connector_id)) ?? 0,
    }));
    // Services people tried to connect but nobody has yet.
    for (const [connectorId, n] of startsBy) {
      if (!accountRows.some((a) => a.connectorId === connectorId))
        accountRows.push({ connectorId, total: 0, added: 0, starts: n });
    }
    const byDay = new Map(activeDays.map((r) => [String(r.day), num(r.n)]));
    const days: ProductReport['activeDays'] = [];
    for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= Date.parse(`${range.to}T00:00:00Z`); t += DAY) {
      const day = new Date(t).toISOString().slice(0, 10);
      days.push({ day, workspaces: byDay.get(day) ?? 0 });
    }
    return {
      connectors: connectors.map((r) => ({
        connectorId: String(r.connector_id),
        calls: num(r.calls),
        errors: num(r.errors),
        workspaces: num(r.workspaces),
      })),
      actions: actions.map((r) => ({
        connectorId: String(r.connector_id),
        action: String(r.action),
        calls: num(r.calls),
        errors: num(r.errors),
        workspaces: num(r.workspaces),
      })),
      activeDays: days,
      wau: num(stickiness[0]?.wau),
      mau: num(stickiness[0]?.mau),
      aiApps: aiApps.map((r) => ({
        name: String(r.name),
        workspaces: num(r.workspaces),
        connections: num(r.connections),
      })),
      tokenWorkspaces: num(tokens[0]?.n),
      accounts: accountRows.sort((a, b) => b.total - a.total || b.starts - a.starts).slice(0, 30),
      dashboard: dashboard
        .map((r) => ({ path: String(r.path), views: num(r.views) }))
        .filter((p) => !isSitePath(p.path))
        .slice(0, 20),
      events: events.map((r) => ({ name: String(r.name), count: num(r.n) })),
    };
  }

  plans(range: Range, now = new Date()): Promise<PlansReport> {
    return this.cached(`plans:${JSON.stringify(range)}`, () => this.loadPlans(range, now));
  }

  private async loadPlans(range: Range, now: Date): Promise<PlansReport> {
    const at = now.toISOString();
    const trialSince = new Date(now.getTime() - TRIAL_DAYS * DAY).toISOString();
    const [groups, bySource] = await Promise.all([
      // The plan in force per workspace, as `Entitlements.planFor` decides it: a canceled, paused
      // or ended subscription falls back to the free plan.
      this.rows(sql`
        with ws as (
          select w.id, w.created_at, s.plan_id, s.interval, s.quantity, s.provider, s.external_id, s.status,
            (s.workspace_id is not null and s.status not in ('canceled', 'paused')
              and (s.current_period_end is null or s.current_period_end > ${at})) as live
          from workspaces w left join subscriptions s on s.workspace_id = w.id
        ),
        eff as (
          select s.id,
            case when s.live then s.plan_id else ${DEFAULT_PLAN_ID} end as plan_id,
            case
              when not s.live or s.plan_id = ${DEFAULT_PLAN_ID} then
                case when s.created_at > ${trialSince} then 'trial' else 'free' end
              when ${PAID} then 'paid'
              else 'gift'
            end as kind,
            case when s.live and ${PAID} then s.interval end as interval,
            case when s.live then s.quantity else 1 end as quantity
          from ws s
        ),
        used as (
          select workspace_id, sum(calls) as calls from usage_counters
          where day >= ${range.from} and day <= ${range.to}
          group by 1
        )
        select e.plan_id, e.kind, e.interval, e.quantity, count(*) as n,
          count(*) filter (where u.calls > 0) as active, coalesce(sum(u.calls), 0) as calls
        from eff e left join used u on u.workspace_id = e.id
        group by 1, 2, 3, 4`),
      this.rows(sql`
        select coalesce(a.source, 'unknown') as source, s.plan_id, s.interval, s.quantity
        from subscriptions s
        join workspace_members m on m.workspace_id = s.workspace_id and m.role = 'owner'
        left join user_attribution a on a.user_id = m.user_id
        where ${PAID}`),
    ]);
    const plans = new Map<string, PlanRow>();
    for (const g of groups) {
      const planId = String(g.plan_id);
      const kind = String(g.kind) as PlanKind;
      const interval = g.interval === null || g.interval === undefined ? null : String(g.interval);
      const n = num(g.n);
      const key = `${planId}\u0000${kind}\u0000${interval}`;
      const row = plans.get(key) ?? {
        planId,
        kind,
        interval,
        workspaces: 0,
        seats: 0,
        active: 0,
        calls: 0,
        mrr: 0,
      };
      row.workspaces += n;
      row.seats += n * Math.max(1, num(g.quantity));
      row.active += num(g.active);
      row.calls += num(g.calls);
      if (kind === 'paid') {
        row.mrr = Math.round((row.mrr + n * monthlyRevenue(planId, interval, num(g.quantity))) * 100) / 100;
      }
      plans.set(key, row);
    }
    const sources = new Map<string, { source: string; paying: number; mrr: number }>();
    for (const r of bySource) {
      const source = String(r.source);
      const entry = sources.get(source) ?? { source, paying: 0, mrr: 0 };
      entry.paying += 1;
      entry.mrr =
        Math.round(
          (entry.mrr + monthlyRevenue(String(r.plan_id), r.interval as string | null, num(r.quantity))) * 100,
        ) / 100;
      sources.set(source, entry);
    }
    const rows = [...plans.values()];
    const paid = rows.filter((r) => r.kind === 'paid');
    return {
      mrr: Math.round(paid.reduce((sum, r) => sum + r.mrr, 0) * 100) / 100,
      paying: paid.reduce((sum, r) => sum + r.workspaces, 0),
      workspaces: rows.reduce((sum, r) => sum + r.workspaces, 0),
      active: rows.reduce((sum, r) => sum + r.active, 0),
      plans: rows.sort(
        (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.mrr - a.mrr || b.workspaces - a.workspaces,
      ),
      bySource: [...sources.values()].sort((a, b) => b.mrr - a.mrr || b.paying - a.paying),
    };
  }

  /**
   * Weekly cohorts of sign-ups (weeks start on Monday, UTC) and the share of each that made at
   * least one call through the hub in each following week.
   */
  retention(weeks: number, filter: Filter = {}, now = new Date()): Promise<RetentionReport> {
    return this.cached(`retention:${JSON.stringify([weeks, filter])}`, () =>
      this.loadRetention(weeks, filter, now),
    );
  }

  private async loadRetention(weeks: number, filter: Filter, now: Date): Promise<RetentionReport> {
    const monday = new Date(now);
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7 * (weeks - 1));
    const since = monday.toISOString();
    const sinceDay = since.slice(0, 10);
    const cohortQuery = sql`
      select u.id, (date_trunc('week', u.created_at at time zone 'UTC'))::date as week
      from users u left join user_attribution a on a.user_id = u.id
      where u.created_at >= ${since}${this.where(filter, 'a')}`;
    const [sizes, activity] = await Promise.all([
      this.rows(sql`select c.week::text as week, count(*) as n from (${cohortQuery}) c group by 1`),
      this.rows(sql`
        with cohort as (${cohortQuery}),
        act as (
          select distinct m.user_id, (date_trunc('week', uc.day::timestamp))::date as week
          from usage_counters uc
          join workspace_members m on m.workspace_id = uc.workspace_id and m.role = 'owner'
          where uc.day >= ${sinceDay} and uc.calls > 0
        )
        select c.week::text as week, ((a.week - c.week) / 7) as k, count(distinct a.user_id) as n
        from cohort c join act a on a.user_id = c.id and a.week >= c.week
        group by 1, 2`),
    ]);
    const cohorts: RetentionReport['cohorts'] = [];
    for (let i = 0; i < weeks; i++) {
      const week = new Date(monday.getTime() + i * 7 * DAY).toISOString().slice(0, 10);
      const size = num(sizes.find((r) => r.week === week)?.n);
      const span = weeks - i;
      const active = Array.from({ length: span }, (_, k) =>
        num(activity.find((r) => r.week === week && num(r.k) === k)?.n),
      );
      cohorts.push({ week, size, active });
    }
    return { cohorts, weeks };
  }
}
