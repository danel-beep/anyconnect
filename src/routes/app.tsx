import { Hono } from 'hono';
import { z } from 'zod';
import { isMetric, type Metric, PLANS, planFits } from '../billing/plans.js';
import { actionRisk, actionText, connectorGuide, connectorText } from '../connectors/sdk.js';
import type { AccountRow } from '../core/accounts.js';
import { isRecentAuth } from '../core/auth-methods.js';
import { isSetupConnector } from '../hub/setup-tools.js';
import { hashToken } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { ACCESS_LEVELS, accessAllows, CONFIRM_LEVELS, confirmationRequired } from '../security/policy.js';
import { AccountPage } from '../web/account-page.js';
import {
  ACCOUNT_BACK,
  type AccountView,
  ActivityPage,
  AppsPage,
  type AppsView,
  BillingPage,
  groupByService,
  OverviewPage,
  ServicesAppPage,
  SettingsPage,
  type UsageView,
} from '../web/app.js';
import { serviceAlternative } from '../web/catalog.js';
import { clearCookie } from '../web/http.js';
import { RulesPage } from '../web/rules.js';
import { fmtAgo, fmtDate } from '../web/ui.js';
import { type AppContext, type AppEnv, SESSION_COOKIE } from './context.js';
import {
  type AppAuth,
  appAction,
  appPage,
  callViews,
  connectionBack,
  cookieOpts,
  pageCtx,
  saveLocale,
  setFlash,
  shellInfo,
  takeFlash,
} from './page-helpers.js';

const DAY = 86_400_000;
/** Ids of AI apps and accounts, as rule rows name them (and the rules page links to them). */
const RULE_ID = /^[\w-]{1,64}$/;

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
    lastUsedAt: a.lastUsedAt,
  };
}

/**
 * The signed-in dashboard (`/app/...`): overview, services and accounts, AI apps and tokens,
 * activity, plan and limits, settings. Every page needs a session (and the second factor when the
 * hub requires it); every form post checks the CSRF token and redirects back with a flash note.
 */
export function appRoutes() {
  const app = new Hono<AppEnv>();

  const page = appPage;
  const action = appAction;

  const usageOf = async (c: AppContext, workspaceId: string): Promise<UsageView> => {
    const summary = await c.get('services').entitlements.summary(workspaceId);
    return {
      planId: summary.plan.id,
      actions: { used: summary.used.actions, limit: summary.limits.actions },
      accounts: { used: summary.used.accounts, limit: summary.limits.accounts },
      resetsAt: summary.period.resetsAt,
      phase: summary.phase
        ? { kind: summary.phase.kind, asPlan: summary.phase.asPlan, until: summary.phase.until }
        : undefined,
      schedule: summary.schedule.map((p) => ({
        kind: p.kind,
        from: p.from,
        until: p.until,
        actions: p.limits.actions,
        asPlan: p.asPlan,
      })),
      planLimitActions: summary.plan.limits.actions,
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
      .filter((a) => !isSetupConnector(a.connectorId))
      .map((a) =>
        accountView(
          a,
          byId.has(a.connectorId)
            ? connectorText(byId.get(a.connectorId)!, c.get('locale')).name
            : a.connectorId,
          Boolean(byId.get(a.connectorId)?.oauth),
        ),
      );
  };

  // --- Overview ---------------------------------------------------------------
  app.get(
    '/app',
    page('/app', async (c, auth) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const [usage, accounts, grants, tokens, recentRows, calls7d, open, shell] = await Promise.all([
        usageOf(c, ws),
        accountsOf(c, ws),
        s.oauth.listGrants(ws),
        s.apiTokens.list(ws),
        s.activity.recent(ws, { limit: 6 }),
        s.activity.countSince(ws, new Date(Date.now() - 7 * DAY)),
        s.pendingCalls.listOpenFor(auth.user.id),
        shellInfo(c, ws),
      ]);
      const asking = open.filter((row) => row.status === 'awaiting_confirmation');
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
              // Ticked by a real request from a connected app, not by a test from the dashboard.
              call: grants.length + tokens.length > 0 && recentRows.length > 0,
            },
            usage,
            apps: grants.length,
            calls7d,
            waiting: {
              count: asking.length,
              soonest: asking.reduce<Date | null>(
                (min, row) => (row.expiresAt && (!min || row.expiresAt < min) ? row.expiresAt : min),
                null,
              ),
            },
            accounts,
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
      const builtinNames = new Map(
        s.connectors.builtin.all().map((x) => [x.id, connectorText(x, c.get('locale')).name]),
      );
      return c.html(
        <ServicesAppPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            accounts,
            catalog: catalog
              .filter((e) => !isSetupConnector(e.service) && e.service !== 'demo')
              .map((e) => ({
                service: e.service,
                name: builtinNames.get(e.service) ?? e.name,
                description: e.description,
                connect: e.connect,
                ready: e.ready,
                custom: e.custom,
                accounts: e.accounts,
                alternative: e.ready
                  ? undefined
                  : serviceAlternative(e.service, s.connectors.builtin.all(), c.get('locale')),
              }))
              // What can be connected now comes first; services waiting for setup go last.
              .sort((a, b) => Number(b.ready) - Number(a.ready)),
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

  // --- One account ------------------------------------------------------------
  app.get(
    '/app/accounts/:id',
    page('/app/services', async (c, auth) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const locale = c.get('locale');
      const row = await s.accounts.get(ws, c.req.param('id')!);
      const [connector, rules, security, entitlements, shell] = await Promise.all([
        s.connectors.get(ws, row.connectorId),
        s.policies.listRules(ws),
        s.admin.security(ws),
        s.entitlements.entitlements(ws),
        shellInfo(c, ws),
      ]);
      const [calls, usage] = await Promise.all([
        s.activity.recent(ws, {
          limit: 10,
          sinceDays: entitlements.limits.historyDays,
          filter: { accountId: row.id },
        }),
        s.activity.accountTotals(ws, row.id, new Date(Date.now() - 30 * DAY)),
      ]);
      const rule = rules.find(
        (r) =>
          r.accountId === row.id && r.aiClientId === null && r.personaId === null && r.connectorId === null,
      );
      const disabled = new Set(row.settings.disabledActions ?? []);
      // The rule in force here: this account's own, else the workspace default.
      const access = rule?.access ?? security.defaultAccess;
      const confirm = rule?.confirm ?? security.defaultConfirm;
      return c.html(
        <AccountPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            account: accountView(
              row,
              connector ? connectorText(connector, locale).name : row.connectorId,
              Boolean(connector?.oauth),
            ),
            createdAt: row.createdAt,
            tools: (connector?.actions ?? []).map((a) => ({
              name: a.name,
              ...actionText(connector!, a, locale),
              risk: actionRisk(a),
              enabled: !disabled.has(a.name),
              blocked: !accessAllows(access, actionRisk(a)),
              asks: confirmationRequired(confirm, actionRisk(a)),
            })),
            usage,
            rule: { access: rule?.access ?? null, confirm: rule?.confirm ?? null },
            defaults: { access: security.defaultAccess, confirm: security.defaultConfirm },
            prompts: connector
              ? connectorGuide(connector, locale, connector.oauth ? 'oauth' : 'form').prompts
              : [],
            calls: await callViews(c, ws, calls),
            flash: takeFlash(c),
          }}
        />,
      );
    }),
  );

  /** Where an account form goes back to: the account's own page when it came from there. */
  const accountBack = (form: Record<string, string>, fallback = '/app/services') =>
    ACCOUNT_BACK.test(form.back ?? '') ? form.back! : fallback;

  const accountAction = (
    name: string,
    run: (c: AppContext, auth: AppAuth, account: AccountRow, form: Record<string, string>) => Promise<void>,
  ) =>
    app.post(
      `/app/accounts/:id/${name}`,
      action(
        (form) => accountBack(form),
        async (c, auth, form) => {
          const account = await c.get('services').accounts.get(auth.workspace.id, c.req.param('id')!);
          await run(c, auth, account, form);
          return undefined;
        },
      ),
    );

  /** Turns the account's actions on and off: a checked box keeps the action available to the AI. */
  accountAction('tools', async (c, auth, account, form) => {
    const s = c.get('services');
    const connector = await s.connectors.get(auth.workspace.id, account.connectorId);
    const disabledActions = (connector?.actions ?? [])
      .map((a) => a.name)
      .filter((name) => form[`on.${name}`] !== 'on');
    await s.accounts.update(auth.workspace.id, account.id, { settings: { disabledActions } });
    setFlash(c, 'ok', 'app.flash.toolsSaved', { label: account.label });
  });

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
      // Each attempt makes the hub fetch a user-supplied address: keep it to a human pace.
      if (!s.rateLimiter.consume(`custom:${auth.workspace.id}`, 10, 10 * 60_000).allowed)
        return retry('app.flash.customFailed');
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
        if (error.status === 400) return retry('app.flash.customInvalid');
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
    const [grants, tokens, personas, used, accounts, clients, shell] = await Promise.all([
      s.oauth.listGrants(ws),
      s.apiTokens.list(ws),
      s.personas.list(ws),
      s.personas.connections(ws),
      s.accounts.list(ws),
      s.aiClients.list(ws),
      shellInfo(c, ws),
    ]);
    const clientNames = new Map(clients.map((x) => [x.id, x.name]));
    const profileNames = new Map(personas.map((p) => [p.id, p.name]));
    const accountIds = new Set(accounts.map((a) => a.id));
    const profileOf = (id: string | null) => (id ? (profileNames.get(id) ?? null) : null);
    return c.html(
      <AppsPage
        ctx={pageCtx(c, auth.user)}
        shell={shell}
        view={{
          grants: grants.map((g) => ({
            id: g.id,
            name: g.clientName ?? g.clientId,
            client: g.aiClientId ? (clientNames.get(g.aiClientId) ?? null) : null,
            appId: g.aiClientId,
            profile: profileOf(g.personaId),
            createdAt: g.createdAt,
            lastUsedAt: g.lastUsedAt,
          })),
          tokens: tokens.map((tok) => ({
            id: tok.id,
            // Renaming the app (here or from the chat) renames its token too.
            name: (tok.aiClientId && clientNames.get(tok.aiClientId)) || tok.name,
            appId: tok.aiClientId,
            profile: profileOf(tok.personaId),
            api: tok.scopes.includes('api'),
            createdAt: tok.createdAt,
            lastUsedAt: tok.lastUsedAt,
            expiresAt: tok.expiresAt,
          })),
          profiles: personas.map((p) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            accounts: p.accountIds.filter((id) => accountIds.has(id)).length,
            apps: (used.get(p.id)?.apps ?? 0) + (used.get(p.id)?.tokens ?? 0),
          })),
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
        .object({
          name: z.string().trim().min(1).max(80),
          days: z.coerce.number().int().min(0).max(3650),
          api: z.boolean(),
        })
        .parse({ name: form.name, days: form.days ?? '0', api: form.api === '1' });
      // A token for an access profile works only with that profile's address.
      const persona = form.profile ? await s.personas.get(auth.workspace.id, form.profile) : undefined;
      const client = await s.aiClients.createUnique(auth.workspace.id, input.name, 'api_token');
      const { token } = await s.apiTokens.create({
        workspaceId: auth.workspace.id,
        userId: auth.user.id,
        name: input.name,
        ...(input.days > 0 ? { expiresInDays: input.days } : {}),
        // MCP only unless the user ticks "management API" on purpose (never for a profile).
        scopes: input.api && !persona ? ['mcp', 'api'] : ['mcp'],
        aiClientId: client.id,
        ...(persona ? { personaId: persona.id } : {}),
      });
      // Shown once, right in the response: never stored in a cookie or the URL.
      return renderApps(c, auth, { newToken: token });
    }),
  );

  app.post(
    '/app/tokens/:id/revoke',
    action(connectionBack, async (c, auth) => {
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
      // `?before=<ISO time>~<id>` continues the log after the last row shown (30 per page).
      const cursor = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)~(\d{1,18})$/.exec(c.req.query('before') ?? '');
      const before =
        cursor && !Number.isNaN(Date.parse(cursor[1]!))
          ? { at: new Date(cursor[1]!), id: Number(cursor[2]) }
          : undefined;
      const PAGE = 30;
      const [connectors, accounts] = await Promise.all([s.connectors.list(ws), accountsOf(c, ws)]);
      // Filters from the address; unknown values are ignored rather than showing an empty log.
      const filter = {
        account: accounts.find((a) => a.id === c.req.query('account'))?.id,
        service: connectors.find((x) => x.id === c.req.query('service'))?.id,
        errors: c.req.query('status') === 'error',
      };
      const [summary, found, shell] = await Promise.all([
        s.activity.summary(ws, days),
        s.activity.recent(ws, {
          limit: PAGE + 1,
          sinceDays: historyDays,
          before,
          filter: {
            accountId: filter.account,
            connectorId: filter.service,
            status: filter.errors ? 'error' : undefined,
          },
        }),
        shellInfo(c, ws),
      ]);
      const names = new Map(connectors.map((x) => [x.id, connectorText(x, c.get('locale')).name]));
      const rows = found.slice(0, PAGE);
      const last = rows.at(-1);
      const logUrl = (extra: Record<string, string> = {}) => {
        const query = new URLSearchParams({
          ...(filter.account ? { account: filter.account } : {}),
          ...(filter.service ? { service: filter.service } : {}),
          ...(filter.errors ? { status: 'error' } : {}),
          ...extra,
        }).toString();
        return `/app/activity${query ? `?${query}` : ''}#log`;
      };
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
            more:
              found.length > PAGE && last
                ? logUrl({ before: `${last.createdAt.toISOString()}~${last.id}` })
                : undefined,
            newest: logUrl(),
            paged: Boolean(before),
            filters: {
              // Two accounts with one name ("Todoist" and "Todoist") differ by their address or key.
              accounts: accounts.map((a) => ({
                id: a.id,
                label: a.label,
                service: a.service,
                detail:
                  a.label === a.service ||
                  accounts.some((b) => b !== a && b.label === a.label && b.service === a.service)
                    ? (a.identity ?? a.name)
                    : undefined,
              })),
              services: [...new Set(accounts.map((a) => a.connectorId))].map((id) => ({
                id,
                name: names.get(id) ?? id,
              })),
              ...filter,
            },
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
      const paid = s.billing.liveSubscription(sub);
      const query = z
        .object({ plan: z.string().max(40).optional(), interval: z.enum(['month', 'year']).optional() })
        .safeParse({ plan: c.req.query('plan'), interval: c.req.query('interval') });
      const focus =
        query.success && query.data.plan && query.data.plan !== entitlements.plan.id
          ? PLANS.find(
              (p) => p.id === query.data.plan && p.public && p.priceMonthly > 0 && planFits(p, 'personal'),
            )
          : undefined;
      const buyable = PLANS.flatMap((p) =>
        (['month', 'year'] as const).filter((i) => s.billing.canBuy(p.id, i)).map((i) => `${p.id}:${i}`),
      );
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
            paid: paid
              ? {
                  provider: s.billing.provider!.name,
                  status: paid.status,
                  interval: paid.interval,
                  periodEnd: paid.currentPeriodEnd,
                  cancelAtPeriodEnd: paid.cancelAtPeriodEnd,
                }
              : undefined,
            buyable,
            testMode: s.billing.provider?.testMode ?? false,
            justPaid: c.req.query('paid') === '1',
            focus: focus
              ? { planId: focus.id, interval: (query.success && query.data.interval) || 'month' }
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

  /** Buying a plan: the provider's checkout, or a plan change when the workspace already pays. */
  app.post(
    '/app/billing/checkout',
    action('/app/billing', async (c, auth, form) => {
      const s = c.get('services');
      const input = z
        .object({ plan: z.string().max(40), interval: z.enum(['month', 'year']).default('month') })
        .parse({ plan: form.plan, interval: form.interval || undefined });
      const outcome = await s.billing.checkout({
        workspaceId: auth.workspace.id,
        userId: auth.user.id,
        email: auth.user.email,
        planId: input.plan,
        interval: input.interval,
        successUrl: `${s.config.publicUrl}/app/billing?paid=1`,
        cancelUrl: `${s.config.publicUrl}/app/billing`,
      });
      if (outcome.kind === 'redirect') return c.redirect(outcome.url, 303);
      setFlash(c, 'ok', 'app.flash.planChanging', {
        plan: c.get('t')(`plan.${outcome.planId}.name` as 'plan.free.name'),
      });
      return undefined;
    }),
  );

  /** The provider's page for the card, invoices and cancelling. */
  app.post(
    '/app/billing/portal',
    action('/app/billing', async (c, auth) => {
      const s = c.get('services');
      const { url } = await s.billing.portal(auth.workspace.id, `${s.config.publicUrl}/app/billing`);
      return c.redirect(url, 303);
    }),
  );

  app.post(
    '/app/billing/cancel',
    action('/app/billing', async (c, auth, form) => {
      const cancel = form.undo !== '1';
      const sub = await c.get('services').billing.setCancelAtPeriodEnd(auth.workspace.id, cancel);
      const date = sub.currentPeriodEnd ? fmtDate(c.get('locale'), sub.currentPeriodEnd) : '';
      setFlash(c, 'ok', cancel ? 'app.flash.planCanceled' : 'app.flash.planResumed', { date });
      return undefined;
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
      const [security, rules, allApps, accounts, shell] = await Promise.all([
        s.admin.security(ws),
        s.policies.listRules(ws),
        s.aiApps.list(ws),
        accountsOf(c, ws),
        shellInfo(c, ws),
      ]);
      // Apps with live access (as on the AI apps page), plus any that already have a rule here.
      const ruled = new Set(rules.map((r) => r.aiClientId).filter(Boolean));
      const clients = allApps.filter((x) => x.connections.length > 0 || ruled.has(x.id));
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
            defaultAccess: security.defaultAccess,
            defaultConfirm: security.defaultConfirm,
            undoWindowSeconds: security.undoWindowSeconds,
            apps: clients.map((x) => ({
              id: x.id,
              name: x.name,
              // Two apps can share a name (e.g. two tokens called "Script"): tell them apart.
              detail: [
                c.get('t')(x.kind === 'api_token' ? 'app.rules.viaToken' : 'app.rules.viaOauth'),
                c.get('t')('app.rules.added', { date: fmtDate(c.get('locale'), x.createdAt) }),
                `${c.get('t')('home.lastUsed')}: ${x.lastUsedAt ? fmtAgo(c.get('locale'), x.lastUsedAt) : c.get('t')('home.never')}`,
              ].join(' · '),
              href: `/app/apps/${encodeURIComponent(x.id)}`,
              access: appRule(x.id)?.access ?? null,
              confirm: appRule(x.id)?.confirm ?? null,
            })),
            // Grouped by service, in the order of the Services page.
            accounts: groupByService(accounts).flatMap(([service, group]) =>
              group.map((a) => ({
                id: a.id,
                name: a.label,
                detail: a.identity ?? `${a.connectorId}:${a.name}`,
                connectorId: a.connectorId,
                group: service,
                href: `/app/accounts/${encodeURIComponent(a.id)}`,
                access: accountRule(a.id)?.access ?? null,
                confirm: accountRule(a.id)?.confirm ?? null,
              })),
            ),
            otherRules: rules.filter((r) => !edited.has(r.id)).length,
            saved: RULE_ID.test(c.req.query('saved') ?? '') ? c.req.query('saved') : undefined,
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
    // An account's own page sets its rule too, and gets the user back there. On the rules page a
    // row saves as soon as a choice changes, so the page comes back at that row, marked "Saved".
    action(
      (form) =>
        accountBack(
          form,
          RULE_ID.test(form.id ?? '') ? `/app/rules?saved=${form.id}#rule-${form.id}` : '/app/rules',
        ),
      async (c, auth, form) => {
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
        if (ACCOUNT_BACK.test(form.back ?? '')) setFlash(c, 'ok', 'app.flash.rulesSaved');
        return undefined;
      },
    ),
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
