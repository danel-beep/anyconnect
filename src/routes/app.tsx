import { Hono } from 'hono';
import { z } from 'zod';
import { isMetric, type Metric } from '../billing/plans.js';
import type { AccountRow } from '../core/accounts.js';
import { isRecentAuth } from '../core/auth-methods.js';
import type { toolCalls } from '../db/schema.js';
import { hashToken } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { ACCESS_LEVELS, CONFIRM_LEVELS } from '../security/policy.js';
import {
  type AccountView,
  ActivityPage,
  AppsPage,
  type AppsView,
  BillingPage,
  type CallView,
  OverviewPage,
  ServicesAppPage,
  SettingsPage,
  type UsageView,
} from '../web/app.js';
import { clearCookie } from '../web/http.js';
import { RulesPage } from '../web/rules.js';
import { type AppContext, type AppEnv, bodyParams, SESSION_COOKIE } from './context.js';
import {
  type AppAuth,
  cookieOpts,
  csrfFailedPage,
  csrfOk,
  pageCtx,
  requireApp,
  saveLocale,
  setFlash,
  shellInfo,
  takeFlash,
  uiError,
} from './page-helpers.js';

const DAY = 86_400_000;

type ToolCallRow = typeof toolCalls.$inferSelect;

function accountView(a: AccountRow, serviceName: string, oauth: boolean): AccountView {
  return {
    id: a.id,
    connectorId: a.connectorId,
    service: serviceName,
    name: a.name,
    label: a.label,
    status: a.status,
    statusMessage: a.statusMessage,
    enabled: a.enabled,
    identity: typeof a.metadata.identity === 'string' ? a.metadata.identity : null,
    oauth,
    createdAt: a.createdAt,
  };
}

/** Error text for a failed form action: our own messages are user-safe, others are not shown. */
const errorText = (c: AppContext, error: unknown): string =>
  error instanceof AppError ? uiError(c, error) : c.get('t')('error.internal');

/**
 * The signed-in dashboard (`/app/...`): overview, services and accounts, AI apps and tokens,
 * activity, plan and limits, settings. Every page needs a session (and the second factor when the
 * hub requires it); every form post checks the CSRF token and redirects back with a flash note.
 */
export function appRoutes() {
  const app = new Hono<AppEnv>();

  /** Runs a GET page for the signed-in user. */
  const page =
    (path: string, render: (c: AppContext, auth: AppAuth) => Promise<Response>) => async (c: AppContext) => {
      const auth = await requireApp(c, new URL(c.req.url).pathname + new URL(c.req.url).search || path);
      if ('redirect' in auth) return c.redirect(auth.redirect, 302);
      return render(c, auth);
    };

  /** Runs a form post: CSRF, session, then the action; errors come back as a flash note. */
  const action =
    (
      back: string,
      run: (c: AppContext, auth: AppAuth, form: Record<string, string>) => Promise<Response | undefined>,
    ) =>
    async (c: AppContext) => {
      const form = await bodyParams(c);
      if (!csrfOk(c, form)) return csrfFailedPage(c);
      const auth = await requireApp(c, back);
      if ('redirect' in auth) return c.redirect(auth.redirect, 303);
      try {
        const response = await run(c, auth, form);
        if (response) return response;
      } catch (error) {
        if (error instanceof z.ZodError) {
          setFlash(c, 'bad', 'app.flash.invalid');
          return c.redirect(back, 303);
        }
        if (!(error instanceof AppError))
          c.get('services').logger.error({ err: error }, 'dashboard action failed');
        setFlash(c, 'bad', 'app.flash.error', { message: errorText(c, error).slice(0, 400) });
      }
      return c.redirect(back, 303);
    };

  const usageOf = async (c: AppContext, workspaceId: string): Promise<UsageView> => {
    const summary = await c.get('services').entitlements.summary(workspaceId);
    return {
      planId: summary.plan.id,
      actions: { used: summary.used.actions, limit: summary.limits.actions },
      accounts: { used: summary.used.accounts, limit: summary.limits.accounts },
      resetsAt: summary.period.resetsAt,
      introUntil: summary.intro?.until,
    };
  };

  const accountsOf = async (c: AppContext, workspaceId: string): Promise<AccountView[]> => {
    const s = c.get('services');
    const [rows, connectors] = await Promise.all([
      s.accounts.list(workspaceId),
      s.connectors.list(workspaceId),
    ]);
    const byId = new Map(connectors.map((x) => [x.id, x]));
    return rows
      .filter((a) => a.connectorId !== 'anyconnect')
      .map((a) =>
        accountView(
          a,
          byId.get(a.connectorId)?.name ?? a.connectorId,
          Boolean(byId.get(a.connectorId)?.oauth),
        ),
      );
  };

  const callViews = async (c: AppContext, workspaceId: string, rows: ToolCallRow[]): Promise<CallView[]> => {
    const s = c.get('services');
    const clients = new Map((await s.aiClients.list(workspaceId)).map((x) => [x.id, x.name]));
    const grants = new Map(
      (await s.oauth.listGrants(workspaceId)).map((g) => [g.clientId, g.clientName ?? g.clientId]),
    );
    return rows.map((r) => ({
      toolName: r.toolName,
      connectorId: r.connectorId ?? '',
      status: r.status,
      outcome: r.outcome,
      createdAt: r.createdAt,
      durationMs: r.durationMs,
      client: (r.clientId && (grants.get(r.clientId) ?? clients.get(r.clientId))) || null,
    }));
  };

  // --- Overview ---------------------------------------------------------------
  app.get(
    '/app',
    page('/app', async (c, auth) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const [usage, accounts, grants, tokens, recentRows, calls7d, shell] = await Promise.all([
        usageOf(c, ws),
        accountsOf(c, ws),
        s.oauth.listGrants(ws),
        s.apiTokens.list(ws),
        s.activity.recent(ws, { limit: 6 }),
        s.activity.countSince(ws, new Date(Date.now() - 7 * DAY)),
        shellInfo(c, ws),
      ]);
      const name = auth.user.name?.trim();
      return c.html(
        <OverviewPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            firstName: name ? (name.split(/\s+/)[0] ?? null) : null,
            welcome: c.req.query('welcome') === '1',
            steps: {
              ai: grants.length + tokens.length > 0,
              service: accounts.length > 0,
              call: recentRows.length > 0,
            },
            usage,
            apps: grants.length,
            calls7d,
            accounts: accounts.slice(0, 6),
            recent: await callViews(c, ws, recentRows),
          }}
        />,
      );
    }),
  );

  // --- Services ---------------------------------------------------------------
  app.get(
    '/app/services',
    page('/app/services', async (c, auth) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const [accounts, catalog, custom, usage, shell] = await Promise.all([
        accountsOf(c, ws),
        s.admin.services(ws),
        s.customServices.list(ws),
        usageOf(c, ws),
        shellInfo(c, ws),
      ]);
      return c.html(
        <ServicesAppPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            accounts,
            catalog: catalog
              .filter((e) => e.service !== 'anyconnect' && e.service !== 'demo')
              .map((e) => ({
                service: e.service,
                name: e.name,
                description: e.description,
                connect: e.connect,
                ready: e.ready,
                custom: e.custom,
                accounts: e.accounts,
              })),
            custom: custom.map((x) => ({
              connectorId: x.connectorId,
              name: x.name,
              kind: x.kind,
              url: x.url,
              tools: x.tools,
              lastError: x.lastError,
            })),
            usage,
            flash: takeFlash(c),
            ...(c.req.query('draft')
              ? {
                  customDraft: {
                    name: (c.req.query('name') ?? '').slice(0, 60),
                    url: (c.req.query('url') ?? '').slice(0, 2000),
                  },
                }
              : {}),
          }}
        />,
      );
    }),
  );

  const accountAction = (
    name: string,
    run: (c: AppContext, auth: AppAuth, account: AccountRow, form: Record<string, string>) => Promise<void>,
  ) =>
    app.post(
      `/app/accounts/:id/${name}`,
      action('/app/services', async (c, auth, form) => {
        const account = await c.get('services').accounts.get(auth.workspace.id, c.req.param('id')!);
        await run(c, auth, account, form);
      }),
    );

  accountAction('test', async (c, auth, account) => {
    const { test } = await c.get('services').admin.testAccount(auth.workspace.id, account.id);
    if (test.ok)
      setFlash(c, 'ok', account.enabled ? 'app.flash.testOk' : 'app.flash.testOkPaused', {
        label: account.label,
      });
    else
      setFlash(c, 'bad', 'app.flash.testFailed', {
        label: account.label,
        message: (test.message ?? '').slice(0, 300),
      });
  });
  accountAction('rename', async (c, auth, account, form) => {
    const label = z
      .string()
      .trim()
      .min(1)
      .max(100)
      .parse(form.label ?? '');
    await c.get('services').accounts.update(auth.workspace.id, account.id, { label });
    setFlash(c, 'ok', 'app.flash.renamed');
  });
  accountAction('toggle', async (c, auth, account) => {
    await c.get('services').accounts.update(auth.workspace.id, account.id, { enabled: !account.enabled });
    setFlash(c, 'ok', account.enabled ? 'app.flash.disabled' : 'app.flash.enabled', { label: account.label });
  });
  accountAction('delete', async (c, auth, account) => {
    await c.get('services').accounts.delete(auth.workspace.id, account.id);
    setFlash(c, 'ok', 'app.flash.deleted', { label: account.label });
  });

  app.post(
    '/app/custom',
    action('/app/services', async (c, auth, form) => {
      const s = c.get('services');
      const name = (form.name ?? '').trim().slice(0, 60);
      const url = (form.url ?? '').trim().slice(0, 2000);
      const token = (form.token ?? '').trim();
      // On failure the user gets the form back as they filled it (but never the token).
      const retry = (
        key: 'app.flash.customFailed' | 'app.flash.customExists' | 'app.flash.customInvalid',
      ) => {
        setFlash(c, 'bad', key);
        return c.redirect(`/app/services?${new URLSearchParams({ draft: '1', name, url })}#custom`, 303);
      };
      let added: Awaited<ReturnType<typeof s.customServices.add>>;
      try {
        added = await s.customServices.add(auth.workspace.id, {
          kind: 'mcp',
          name,
          url,
          ...(token ? { auth: 'bearer' as const } : {}),
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        if (error.status === 409) return retry('app.flash.customExists');
        if (error.message.startsWith('Invalid service')) return retry('app.flash.customInvalid');
        return retry('app.flash.customFailed');
      }
      if (token) {
        await s.accounts.create(auth.workspace.id, {
          connectorId: added.connectorId,
          label: name,
          credentials: { token },
        });
      }
      setFlash(c, 'ok', 'app.flash.customAdded', { name: added.name });
      return undefined;
    }),
  );

  app.post(
    '/app/custom/:id/delete',
    action('/app/services', async (c, auth) => {
      await c.get('services').customServices.remove(auth.workspace.id, c.req.param('id')!);
      setFlash(c, 'ok', 'app.flash.customDeleted');
    }),
  );

  // --- AI apps and tokens -------------------------------------------------------
  const renderApps = async (c: AppContext, auth: AppAuth, extra: Pick<AppsView, 'newToken'> = {}) => {
    const s = c.get('services');
    const ws = auth.workspace.id;
    const [grants, tokens, personas, clients, shell] = await Promise.all([
      s.oauth.listGrants(ws),
      s.apiTokens.list(ws),
      s.personas.list(ws),
      s.aiClients.list(ws),
      shellInfo(c, ws),
    ]);
    const clientNames = new Map(clients.map((x) => [x.id, x.name]));
    return c.html(
      <AppsPage
        ctx={pageCtx(c, auth.user)}
        shell={shell}
        view={{
          grants: grants.map((g) => ({
            id: g.id,
            name: g.clientName ?? g.clientId,
            client: g.aiClientId ? (clientNames.get(g.aiClientId) ?? null) : null,
            createdAt: g.createdAt,
            lastUsedAt: g.lastUsedAt,
          })),
          tokens: tokens.map((tok) => ({
            id: tok.id,
            name: tok.name,
            createdAt: tok.createdAt,
            lastUsedAt: tok.lastUsedAt,
            expiresAt: tok.expiresAt,
          })),
          personas: personas.map((p) => ({ name: p.name, url: s.personas.urlFor(p.slug) })),
          flash: takeFlash(c),
          ...extra,
        }}
      />,
    );
  };

  app.get(
    '/app/apps',
    page('/app/apps', (c, auth) => renderApps(c, auth)),
  );

  app.post(
    '/app/tokens',
    action('/app/apps', async (c, auth, form) => {
      const s = c.get('services');
      const input = z
        .object({ name: z.string().trim().min(1).max(80), days: z.coerce.number().int().min(0).max(3650) })
        .parse({ name: form.name, days: form.days ?? '0' });
      const client = await s.aiClients.createUnique(auth.workspace.id, input.name, 'api_token');
      const { token } = await s.apiTokens.create({
        workspaceId: auth.workspace.id,
        userId: auth.user.id,
        name: input.name,
        ...(input.days > 0 ? { expiresInDays: input.days } : {}),
        aiClientId: client.id,
      });
      // Shown once, right in the response: never stored in a cookie or the URL.
      return renderApps(c, auth, { newToken: token });
    }),
  );

  app.post(
    '/app/tokens/:id/revoke',
    action('/app/apps', async (c, auth) => {
      await c.get('services').apiTokens.revoke(auth.workspace.id, c.req.param('id')!);
      setFlash(c, 'ok', 'app.flash.tokenRevoked');
    }),
  );

  // --- Activity ----------------------------------------------------------------
  app.get(
    '/app/activity',
    page('/app/activity', async (c, auth) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const entitlements = await s.entitlements.entitlements(ws);
      const historyDays = entitlements.limits.historyDays;
      const days = Math.min(30, historyDays ?? 30);
      const [summary, rows, connectors, shell] = await Promise.all([
        s.activity.summary(ws, days),
        s.activity.recent(ws, { limit: 100, sinceDays: historyDays }),
        s.connectors.list(ws),
        shellInfo(c, ws),
      ]);
      const names = new Map(connectors.map((x) => [x.id, x.name]));
      return c.html(
        <ActivityPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            calls: await callViews(c, ws, rows),
            daily: summary.daily,
            byService: summary.byConnector.map((x) => ({
              connectorId: x.connectorId,
              name: names.get(x.connectorId) ?? x.connectorId,
              calls: x.calls,
            })),
            total: summary.total,
            errors: summary.errors,
            historyDays,
          }}
        />,
      );
    }),
  );

  // --- Plan and limits ------------------------------------------------------------
  app.get(
    '/app/billing',
    page('/app/billing', async (c, auth) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const [usage, entitlements, request, shell] = await Promise.all([
        usageOf(c, ws),
        s.entitlements.entitlements(ws),
        s.entitlements.openRequest(ws),
        shellInfo(c, ws),
      ]);
      const sub = entitlements.subscription;
      return c.html(
        <BillingPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            usage,
            plan: entitlements.plan,
            subscription:
              sub && sub.planId === entitlements.plan.id
                ? { provider: sub.provider, periodEnd: sub.currentPeriodEnd, status: sub.status }
                : undefined,
            grants: entitlements.grants
              .filter((g) => isMetric(g.metric))
              .map((g) => ({
                metric: g.metric as Metric,
                amount: g.amount,
                expiresAt: g.expiresAt,
                reason: g.reason,
              })),
            requested: request ? { planId: request.planId, at: request.createdAt } : undefined,
            flash: takeFlash(c),
          }}
        />,
      );
    }),
  );

  app.post(
    '/app/billing/checkout',
    action('/app/billing', async (c, auth, form) => {
      const s = c.get('services');
      if (!s.billing) return c.redirect('/app/billing', 303);
      const input = z
        .object({ plan: z.string().max(40), interval: z.enum(['month', 'year']).default('month') })
        .parse({ plan: form.plan, interval: form.interval || undefined });
      const { url } = await s.billing.checkout({
        workspaceId: auth.workspace.id,
        userId: auth.user.id,
        email: auth.user.email,
        planId: input.plan,
        interval: input.interval,
        successUrl: `${s.config.publicUrl}/app/billing?paid=1`,
        cancelUrl: `${s.config.publicUrl}/app/billing`,
      });
      return c.redirect(url, 303);
    }),
  );

  /** Payments are manual until a `BillingProvider` is wired: the request shows up in the admin panel. */
  app.post(
    '/app/billing/request',
    action('/app/billing', async (c, auth, form) => {
      const input = z
        .object({ plan: z.string().max(40), interval: z.enum(['month', 'year']).default('month') })
        .parse({ plan: form.plan, interval: form.interval || undefined });
      await c
        .get('services')
        .entitlements.requestPlan(auth.workspace.id, auth.user.id, input.plan, input.interval);
      setFlash(c, 'ok', 'app.flash.planRequested', {
        plan: c.get('t')(`plan.${input.plan}.name` as 'plan.free.name'),
      });
      return undefined;
    }),
  );

  // --- Rules: confirmations and access -----------------------------------------------
  app.get(
    '/app/rules',
    page('/app/rules', async (c, auth) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const [security, rules, clients, accounts, shell] = await Promise.all([
        s.admin.security(ws),
        s.policies.listRules(ws),
        s.aiClients.list(ws),
        accountsOf(c, ws),
        shellInfo(c, ws),
      ]);
      const simple = (r: (typeof rules)[number]) => r.personaId === null && r.connectorId === null;
      const appRule = (id: string) =>
        rules.find((r) => simple(r) && r.aiClientId === id && r.accountId === null);
      const accountRule = (id: string) =>
        rules.find((r) => simple(r) && r.accountId === id && r.aiClientId === null);
      const edited = new Set(
        [...clients.map((x) => appRule(x.id)?.id), ...accounts.map((a) => accountRule(a.id)?.id)].filter(
          Boolean,
        ),
      );
      return c.html(
        <RulesPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            defaultConfirm: security.defaultConfirm,
            undoWindowSeconds: security.undoWindowSeconds,
            apps: clients.map((x) => ({
              id: x.id,
              name: x.name,
              access: appRule(x.id)?.access ?? null,
              confirm: appRule(x.id)?.confirm ?? null,
            })),
            accounts: accounts.map((a) => ({
              id: a.id,
              name: a.label,
              detail: `${a.service} · ${a.connectorId}:${a.name}`,
              access: accountRule(a.id)?.access ?? null,
              confirm: accountRule(a.id)?.confirm ?? null,
            })),
            otherRules: rules.filter((r) => !edited.has(r.id)).length,
            flash: takeFlash(c),
          }}
        />,
      );
    }),
  );

  app.post(
    '/app/rules/defaults',
    action('/app/rules', async (c, auth, form) => {
      const input = z
        .object({ confirm: z.enum(CONFIRM_LEVELS), undo: z.coerce.number().int().min(0).max(3600) })
        .parse({ confirm: form.confirm, undo: form.undo ?? '0' });
      await c.get('services').admin.updateSecurity(auth.workspace.id, {
        defaultConfirm: input.confirm,
        undoWindowSeconds: input.undo,
      });
      setFlash(c, 'ok', 'app.flash.rulesSaved');
      return undefined;
    }),
  );

  app.post(
    '/app/rules/scoped',
    action('/app/rules', async (c, auth, form) => {
      const s = c.get('services');
      const input = z
        .object({
          kind: z.enum(['app', 'account']),
          id: z.string().min(1).max(64),
          access: z.union([z.literal(''), z.enum(ACCESS_LEVELS)]),
          confirm: z.union([z.literal(''), z.enum(CONFIRM_LEVELS)]),
        })
        .parse({ kind: form.kind, id: form.id, access: form.access ?? '', confirm: form.confirm ?? '' });
      const value = { access: input.access || null, confirm: input.confirm || null };
      // The rule service checks that the app or account belongs to this workspace.
      await s.policies.setScopedRule(
        auth.workspace.id,
        input.kind === 'app' ? { aiClientId: input.id } : { accountId: input.id },
        value,
      );
      setFlash(c, 'ok', 'app.flash.rulesSaved');
      return undefined;
    }),
  );

  // --- Settings -----------------------------------------------------------------
  app.get(
    '/app/settings',
    page('/app/settings', async (c, auth) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const [settings, identities, sessions, shell] = await Promise.all([
        s.admin.settings(ws),
        s.users.identities(auth.user.id),
        s.sessions.list(auth.user.id),
        shellInfo(c, ws),
      ]);
      const current = hashToken(auth.session.token);
      return c.html(
        <SettingsPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            name: auth.user.name,
            email: auth.user.email,
            locale: auth.user.locale,
            toolListing: settings.toolListing ?? 'auto',
            toolExposure: settings.toolExposure ?? 'grouped',
            identities: identities.map((i) => ({ provider: i.provider, email: i.email })),
            hasPassword: auth.user.passwordHash !== null,
            sessions: sessions.map((x) => ({
              current: x.tokenHash === current,
              ip: x.ip,
              userAgent: x.userAgent,
              lastSeenAt: x.lastSeenAt,
            })),
            recentAuth: isRecentAuth(auth.session.authenticatedAt),
            flash: takeFlash(c),
          }}
        />,
      );
    }),
  );

  app.post(
    '/app/settings/profile',
    action('/app/settings', async (c, auth, form) => {
      const input = z
        .object({ name: z.string().trim().max(100), locale: z.enum(['', 'ru', 'en']) })
        .parse({ name: form.name ?? '', locale: form.locale ?? '' });
      const locale = input.locale === '' ? null : input.locale;
      await c.get('services').users.setProfile(auth.user.id, { name: input.name || null, locale });
      saveLocale(c, locale);
      setFlash(c, 'ok', 'app.flash.profileSaved');
    }),
  );

  app.post(
    '/app/settings/tools',
    action('/app/settings', async (c, auth, form) => {
      const input = z
        .object({
          toolListing: z.enum(['auto', 'direct', 'discovery']),
          toolExposure: z.enum(['grouped', 'per_account']),
        })
        .parse({ toolListing: form.toolListing, toolExposure: form.toolExposure });
      await c.get('services').admin.updateSettings(auth.workspace.id, input);
      setFlash(c, 'ok', 'app.flash.toolsSaved');
    }),
  );

  app.post(
    '/app/settings/sessions/others',
    action('/app/settings', async (c, auth) => {
      const n = await c.get('services').sessions.destroyOthers(auth.user.id, auth.session.token);
      setFlash(c, 'ok', 'app.flash.sessionsEnded', { n: String(n) });
    }),
  );

  app.post(
    '/app/settings/delete',
    action('/app/settings', async (c, auth, form) => {
      const s = c.get('services');
      if (!isRecentAuth(auth.session.authenticatedAt))
        return c.redirect(`/login?reauth=1&next=${encodeURIComponent('/app/settings')}`, 303);
      if ((form.email ?? '').trim().toLowerCase() !== auth.user.email.toLowerCase()) {
        setFlash(c, 'bad', 'app.flash.deleteMismatch');
        return;
      }
      // The hub owner would lock everyone out of the admin panel; roles change in the CLI.
      if (auth.user.role === 'admin') {
        setFlash(c, 'bad', 'app.flash.deleteAdmin');
        return;
      }
      await s.users.delete(auth.user.id);
      clearCookie(c, SESSION_COOKIE, cookieOpts(c));
      s.logger.info({ userId: auth.user.id }, 'user deleted their account');
      return c.redirect('/?deleted=1', 303);
    }),
  );

  return app;
}
