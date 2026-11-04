import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminActor } from '../admin/service.js';
import { monthPeriod } from '../billing/period.js';
import { getPlan, METRICS, type Metric, PLANS } from '../billing/plans.js';
import { isRecentAuth, isStrongAuth } from '../core/auth-methods.js';
import { AppError } from '../lib/errors.js';
import { IpAllowlist } from '../lib/ip-allowlist.js';
import {
  AdminAuditPage,
  AdminOverviewPage,
  AdminSystemPage,
  AdminUserPage,
  AdminUsersPage,
} from '../web/admin.js';
import { clientIp } from '../web/http.js';
import { ErrorPage } from '../web/pages.js';
import { type AppContext, type AppEnv, bodyParams, loginUrl } from './context.js';
import {
  type AppAuth,
  csrfFailedPage,
  csrfOk,
  pageCtx,
  requireApp,
  setFlash,
  shellInfo,
  takeFlash,
  uiError,
} from './page-helpers.js';

const DAY = 86_400_000;

type Gate = { ok: AppAuth & { actor: AdminActor } } | { response: Response };

/**
 * The hub owner's admin panel (`/admin/...`). Defence in depth, every request:
 * 1. a signed-in user with the `admin` role (everyone else gets a plain 404: the panel is not advertised);
 * 2. the client IP in ADMIN_ALLOWED_IPS, when set;
 * 3. a second factor set up, and this session signed in with it (amr pwd/fed + otp/rec, or a passkey);
 * 4. that sign-in at most ADMIN_SESSION_HOURS ago (otherwise sign in again);
 * 5. form posts: CSRF token + Origin check and a per-admin rate limit; every change goes to the admin log.
 * Admins never see credentials, tool arguments or results, only counts and metadata.
 */
export function adminRoutes() {
  const app = new Hono<AppEnv>();
  let allowlist: IpAllowlist | undefined;

  const gate = async (c: AppContext, next: string): Promise<Gate> => {
    const s = c.get('services');
    const notFound = () => ({ response: c.text('Not found', 404) });
    const auth = await requireApp(c, next);
    if ('redirect' in auth) {
      // Signed-out visitors are sent to sign in like on any other page; only a signed-in
      // non-admin learns nothing (404).
      return { response: c.redirect(auth.redirect, 302) };
    }
    if (auth.user.role !== 'admin') return notFound();
    const ip = clientIp(c, s.config.trustProxy);
    allowlist ??= new IpAllowlist(s.config.site.adminAllowedIps);
    if (!allowlist.allows(ip)) {
      s.logger.warn({ userId: auth.user.id, ip }, 'admin panel refused: IP not allowed');
      return notFound();
    }
    if (!(await s.secondFactors.hasAny(auth.user.id))) {
      const t = c.get('t');
      return {
        response: await c.html(
          <ErrorPage
            t={t}
            lang={c.get('locale')}
            title={t('admin.gate.title')}
            message={t('admin.gate.need2fa')}
            back={{ href: `/security?next=${encodeURIComponent(next)}`, label: t('admin.gate.setup') }}
          />,
          403,
        ),
      };
    }
    const fresh = isRecentAuth(auth.session.authenticatedAt, Date.now(), s.config.site.adminSessionMaxAgeMs);
    if (!isStrongAuth(auth.session.amr) || !fresh) {
      return { response: c.redirect(loginUrl(next, { reauth: true }), 302) };
    }
    return { ok: { ...auth, actor: { userId: auth.user.id, email: auth.user.email, ip } } };
  };

  const view =
    (render: (c: AppContext, auth: AppAuth & { actor: AdminActor }) => Promise<Response>) =>
    async (c: AppContext) => {
      const url = new URL(c.req.url);
      const g = await gate(c, url.pathname + url.search);
      if ('response' in g) return g.response;
      return render(c, g.ok);
    };

  /** A change to a user: checks, runs, logs (inside AdminService) and redirects back with a note. */
  const change =
    (
      run: (
        c: AppContext,
        actor: AdminActor,
        userId: string,
        form: Record<string, string>,
      ) => Promise<string | undefined>,
    ) =>
    async (c: AppContext) => {
      const s = c.get('services');
      const userId = c.req.param('id')!;
      const back = `/admin/users/${encodeURIComponent(userId)}`;
      const form = await bodyParams(c);
      // The gate first: to anyone but an admin the panel does not exist, not even as a CSRF error.
      const g = await gate(c, back);
      if ('response' in g) return g.response;
      if (!csrfOk(c, form)) return csrfFailedPage(c);
      if (!s.rateLimiter.consume(`admin:${g.ok.user.id}`, 60, 60_000).allowed) {
        setFlash(c, 'bad', 'admin.flash.error', { message: c.get('t')('login.rateLimited') });
        return c.redirect(back, 303);
      }
      try {
        const redirect = await run(c, g.ok.actor, userId, form);
        return c.redirect(redirect ?? back, 303);
      } catch (error) {
        if (!(error instanceof AppError) && !(error instanceof z.ZodError)) throw error;
        setFlash(c, 'bad', 'admin.flash.error', { message: uiError(c, error).slice(0, 300) });
        return c.redirect(back, 303);
      }
    };

  // --- Pages ------------------------------------------------------------------
  app.get(
    '/admin',
    view(async (c, auth) => {
      const s = c.get('services');
      const [overview, recent, requests, shell] = await Promise.all([
        s.adminPanel.overview(),
        s.adminPanel.listUsers({ perPage: 6 }),
        s.entitlements.openRequests(20),
        shellInfo(c, auth.workspace.id),
      ]);
      const planRequests = await Promise.all(
        requests.map(async (r) => ({
          userId: r.userId,
          email: (r.userId && (await s.users.get(r.userId))?.email) || '—',
          planId: r.planId,
          interval: r.interval,
          at: r.createdAt,
        })),
      );
      return c.html(
        <AdminOverviewPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            ...overview,
            planRequests,
            byConnector: overview.byConnector.map((x) => ({
              ...x,
              name: s.connectors.builtin.all().find((d) => d.id === x.connectorId)?.name ?? x.connectorId,
            })),
            recentUsers: recent.items.map((i) => ({
              id: i.user.id,
              email: i.user.email,
              name: i.user.name,
              createdAt: i.user.createdAt,
              planId: i.planId,
            })),
          }}
        />,
      );
    }),
  );

  const ListQuery = z.object({
    q: z.string().max(100).optional(),
    status: z.enum(['active', 'suspended']).optional().catch(undefined),
    role: z.enum(['admin', 'user']).optional().catch(undefined),
    page: z.coerce.number().int().min(1).max(10_000).optional().catch(undefined),
  });

  app.get(
    '/admin/users',
    view(async (c, auth) => {
      const s = c.get('services');
      const query = ListQuery.parse({
        q: c.req.query('q') || undefined,
        status: c.req.query('status') || undefined,
        role: c.req.query('role') || undefined,
        page: c.req.query('page') || undefined,
      });
      const [list, shell] = await Promise.all([
        s.adminPanel.listUsers(query),
        shellInfo(c, auth.workspace.id),
      ]);
      return c.html(
        <AdminUsersPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            q: query.q ?? '',
            status: query.status ?? '',
            role: query.role ?? '',
            page: list.page,
            pages: list.pages,
            total: list.total,
            items: list.items.map((i) => ({
              id: i.user.id,
              email: i.user.email,
              name: i.user.name,
              role: i.user.role,
              status: i.user.status,
              planId: i.planId,
              accounts: i.accounts,
              actions: i.actionsThisMonth,
              createdAt: i.user.createdAt,
              lastLoginAt: i.user.lastLoginAt,
            })),
          }}
        />,
      );
    }),
  );

  app.get(
    '/admin/users/:id',
    view(async (c, auth) => {
      const s = c.get('services');
      const detail = await s.adminPanel.userDetail(c.req.param('id')!).catch((error) => {
        if (error instanceof AppError && error.status === 404) return undefined;
        throw error;
      });
      if (!detail) return c.text('Not found', 404);
      const shell = await shellInfo(c, auth.workspace.id);
      const { user, summary } = detail;
      const now = Date.now();
      const sub = summary?.subscription;
      return c.html(
        <AdminUserPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            flash: takeFlash(c),
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
              status: user.status,
              statusReason: user.statusReason,
              createdAt: user.createdAt,
              lastLoginAt: user.lastLoginAt,
              hasPassword: user.passwordHash !== null,
            },
            self: user.id === auth.user.id,
            identities: detail.identities.map((i) => ({
              provider: i.provider,
              email: i.email,
              lastUsedAt: i.lastUsedAt,
            })),
            secondFactor: detail.secondFactor,
            sessions: detail.sessions,
            apps: detail.apps,
            workspaceId: detail.workspace?.id ?? null,
            plan: {
              id: summary?.plan.id ?? 'free',
              until: sub?.currentPeriodEnd ?? null,
              provider: sub?.provider ?? null,
              note: sub?.note ?? null,
            },
            usage: summary
              ? {
                  actions: summary.used.actions,
                  actionsLimit: summary.limits.actions,
                  accounts: summary.used.accounts,
                  accountsLimit: summary.limits.accounts,
                  resetsAt: summary.period.resetsAt,
                }
              : null,
            limits: summary ? summary.limits : null,
            grants: detail.grants.map((g) => ({
              id: g.id,
              metric: g.metric,
              amount: g.amount,
              reason: g.reason,
              expiresAt: g.expiresAt,
              revokedAt: g.revokedAt,
              createdAt: g.createdAt,
              active: !g.revokedAt && (!g.expiresAt || g.expiresAt.getTime() > now),
            })),
            accounts: detail.accounts.map((a) => ({
              connectorId: a.connectorId,
              label: a.label,
              name: a.name,
              status: a.status,
              enabled: a.enabled,
            })),
            audit: detail.audit.map((a) => ({
              action: a.action,
              actorEmail: a.actorEmail,
              details: (a.details ?? {}) as Record<string, unknown>,
              createdAt: a.createdAt,
            })),
          }}
        />,
      );
    }),
  );

  app.get(
    '/admin/audit',
    view(async (c, auth) => {
      const s = c.get('services');
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(10_000)
        .catch(1)
        .parse(c.req.query('page') ?? 1);
      const [log, shell] = await Promise.all([s.adminPanel.audit({ page }), shellInfo(c, auth.workspace.id)]);
      return c.html(
        <AdminAuditPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            page: log.page,
            pages: log.pages,
            rows: log.rows.map((r) => ({
              action: r.action,
              actorEmail: r.actorEmail,
              targetUserId: r.targetUserId,
              targetEmail: r.targetEmail ?? (r.details as { email?: string } | null)?.email ?? null,
              details: (r.details ?? {}) as Record<string, unknown>,
              ip: r.ip,
              createdAt: r.createdAt,
            })),
          }}
        />,
      );
    }),
  );

  app.get(
    '/admin/system',
    view(async (c, auth) => {
      const s = c.get('services');
      const cfg = s.config;
      const database = await s.database.pool
        .query('select 1')
        .then(() => true)
        .catch(() => false);
      const shell = await shellInfo(c, auth.workspace.id);
      const t = c.get('t');
      const yes = t('admin.sys.on');
      const no = t('admin.sys.off');
      const hours = Math.round(cfg.site.adminSessionMaxAgeMs / 3_600_000);
      const forwarded = c.req.header('x-forwarded-for');
      const checks = [
        { label: t('admin.sys.google'), ok: Boolean(cfg.site.google), detail: cfg.site.google ? yes : no },
        {
          label: t('admin.sys.signups'),
          ok: cfg.site.signups === 'open',
          detail: t(cfg.site.signups === 'open' ? 'admin.sys.open' : 'admin.sys.closed'),
        },
        {
          label: t('admin.sys.require2fa'),
          ok: cfg.auth.requireSecondFactor,
          detail: cfg.auth.requireSecondFactor ? t('admin.sys.yes') : t('admin.sys.no'),
        },
        {
          label: t('admin.sys.allowlist'),
          ok: cfg.site.adminAllowedIps.length > 0,
          detail: cfg.site.adminAllowedIps.length ? cfg.site.adminAllowedIps.join(', ') : no,
        },
        {
          // Lets the owner check the proxy settings (TRUST_PROXY) before relying on the IP allowlist.
          label: t('admin.sys.yourIp'),
          ok: true,
          detail: `${auth.actor.ip ?? '—'}${forwarded ? ` (X-Forwarded-For: ${forwarded.slice(0, 200)})` : ''}`,
        },
        { label: t('admin.sys.adminSession'), ok: true, detail: t('admin.sys.hours', { n: hours }) },
        { label: t('admin.sys.payments'), ok: Boolean(s.billing), detail: s.billing ? s.billing.name : no },
        { label: t('admin.sys.telegram'), ok: Boolean(s.telegramBot), detail: s.telegramBot ? yes : no },
        {
          label: t('admin.sys.support'),
          ok: Boolean(cfg.site.supportEmail),
          detail: cfg.site.supportEmail ?? no,
        },
        {
          label: t('admin.sys.https'),
          ok: cfg.secureCookies,
          detail: cfg.secureCookies ? t('admin.sys.yes') : t('admin.sys.httpsOff'),
        },
      ];
      return c.html(
        <AdminSystemPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{ version: s.version, env: cfg.env, publicUrl: cfg.publicUrl, database, checks }}
        />,
      );
    }),
  );

  // --- Changes ------------------------------------------------------------------
  app.post(
    '/admin/users/:id/plan',
    change(async (c, actor, userId, form) => {
      const input = z
        .object({
          plan: z.string().refine((id) => PLANS.some((p) => p.id === id), 'Unknown plan'),
          until: z.union([z.literal(''), z.iso.date()]),
          note: z.string().trim().max(200),
        })
        .parse({ plan: form.plan, until: form.until ?? '', note: form.note ?? '' });
      const periodEnd = input.until ? new Date(`${input.until}T23:59:59Z`) : null;
      if (periodEnd && periodEnd.getTime() <= Date.now())
        throw new AppError(400, 'past_date', 'The end date must be in the future');
      getPlan(input.plan);
      await c
        .get('services')
        .adminPanel.setPlan(actor, userId, { planId: input.plan, periodEnd, note: input.note || undefined });
      setFlash(c, 'ok', 'admin.flash.planSet');
    }),
  );

  app.post(
    '/admin/users/:id/limits',
    change(async (c, actor, userId, form) => {
      const input = z
        .object({
          metric: z.enum(METRICS as unknown as [Metric, ...Metric[]]),
          unlimited: z.boolean(),
          amount: z.coerce.number().int().min(1).max(100_000_000).optional(),
          duration: z.enum(['month', '30', '90', '365', 'forever']),
          reason: z.string().trim().max(200),
        })
        .parse({
          metric: form.metric,
          unlimited: form.unlimited === '1' || form.unlimited === 'on',
          amount: form.amount ? form.amount : undefined,
          duration: form.duration,
          reason: form.reason ?? '',
        });
      if (!input.unlimited && input.amount === undefined)
        throw new AppError(400, 'amount_required', 'Enter an amount or tick “Unlimited”');
      const now = new Date();
      const expiresAt =
        input.duration === 'forever'
          ? null
          : input.duration === 'month'
            ? monthPeriod(now).resetsAt
            : new Date(now.getTime() + Number(input.duration) * DAY);
      await c.get('services').adminPanel.grantLimit(actor, userId, {
        metric: input.metric,
        amount: input.unlimited ? null : (input.amount ?? null),
        expiresAt,
        reason: input.reason || undefined,
      });
      setFlash(c, 'ok', 'admin.flash.limitGranted');
    }),
  );

  app.post(
    '/admin/users/:id/limits/:grant/revoke',
    change(async (c, actor, userId) => {
      await c.get('services').adminPanel.revokeLimit(actor, userId, c.req.param('grant')!);
      setFlash(c, 'ok', 'admin.flash.limitRevoked');
    }),
  );

  app.post(
    '/admin/users/:id/sign-out',
    change(async (c, actor, userId) => {
      await c.get('services').adminPanel.signOutEverywhere(actor, userId);
      setFlash(c, 'ok', 'admin.flash.signedOut');
    }),
  );

  app.post(
    '/admin/users/:id/suspend',
    change(async (c, actor, userId, form) => {
      const reason = z
        .string()
        .trim()
        .max(200)
        .parse(form.reason ?? '');
      await c.get('services').adminPanel.suspend(actor, userId, reason || undefined);
      setFlash(c, 'ok', 'admin.flash.suspended');
    }),
  );

  app.post(
    '/admin/users/:id/reactivate',
    change(async (c, actor, userId) => {
      await c.get('services').adminPanel.reactivate(actor, userId);
      setFlash(c, 'ok', 'admin.flash.reactivated');
    }),
  );

  app.post(
    '/admin/users/:id/delete',
    change(async (c, actor, userId, form) => {
      await c.get('services').adminPanel.deleteUser(actor, userId, form.email ?? '');
      setFlash(c, 'ok', 'admin.flash.deleted');
      return '/admin/users';
    }),
  );

  return app;
}
