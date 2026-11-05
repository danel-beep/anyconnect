import { Hono } from 'hono';
import {
  actionRisk,
  actionText,
  type ConnectorDefinition,
  connectorGuide,
  connectorText,
} from '../connectors/sdk.js';
import type { AccountOwnerInput, AccountRow } from '../core/accounts.js';
import { connectFormFields, type FormField, fieldForIssue, readConnectForm } from '../core/connect-form.js';
import { hubClientMetadata } from '../core/custom-services.js';
import { getDefaultWorkspace, type Workspace } from '../core/identity.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { serviceAlternative } from '../web/catalog.js';
import {
  ConnectedPage,
  ConnectFormPage,
  type ConnectFormView,
  ServiceUnavailablePage,
} from '../web/connect-form.js';
import { csrfToken, safeNextPath, verifyCsrf } from '../web/http.js';
import type { Translate } from '../web/i18n.js';
import { ErrorPage } from '../web/pages.js';
import { classifyProblem } from '../web/problems.js';
import type { SessionUser } from '../web/sessions.js';
import { type AppContext, type AppEnv, bodyParams, currentUser } from './context.js';
import { renderInApp } from './page-helpers.js';

/**
 * Browser side of connecting accounts:
 *
 * - `GET /connect/:connectorId?account=&app=&label=&name=&returnTo=` is the link the panel and the
 *   setup tools give out. For OAuth services it starts a flow for the signed-in user and redirects
 *   to the provider (`POST /api/v1/connect` is the API equivalent); for the rest (and with
 *   `via=form` for optional OAuth; `via=oauth` forces the provider's sign-in) it shows a form built from the connector's schemas
 *   (`core/connect-form.ts`), posted back to `POST /connect/:connectorId`;
 * - `GET /connect/callback` is the single redirect URI registered at every provider.
 *
 * `team=<slug>` connects into a team the user belongs to: as their own account, or with
 * `owner=team` (admins) as the team's. Without it the account goes to the personal workspace.
 */
export function connectRoutes() {
  const app = new Hono<AppEnv>();

  const loginRedirect = (path: string) => `/login?next=${encodeURIComponent(path)}`;

  /** Client ID Metadata Document: the hub's OAuth client identity for MCP servers that accept CIMD. */
  app.get('/connect/client-metadata.json', (c) => {
    const s = c.get('services');
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('Access-Control-Allow-Origin', '*');
    return c.json(hubClientMetadata(s.config.publicUrl, s.connect.redirectUri));
  });

  app.get('/connect/callback', async (c) => {
    const s = c.get('services');
    const user = await currentUser(c);
    if (!user) {
      const url = new URL(c.req.url);
      return c.redirect(loginRedirect(url.pathname + url.search), 302);
    }
    const result = await s.connect.complete(user.id, {
      state: c.req.query('state'),
      code: c.req.query('code'),
      error: c.req.query('error'),
      errorDescription: c.req.query('error_description'),
    });
    const connector = await s.connectors.get(result.account.workspaceId, result.account.connectorId);
    const identity =
      typeof result.account.metadata.identity === 'string' ? result.account.metadata.identity : undefined;
    return renderConnected(c, user, connector, {
      account: result.account,
      created: result.created,
      identity,
      problem: result.account.status === 'active' ? undefined : (result.account.statusMessage ?? undefined),
      returnTo: safeNextPath(result.returnTo, '/app/services'),
    });
  });

  app.get('/connect/:connectorId', async (c) => {
    const s = c.get('services');
    const user = await currentUser(c);
    if (!user) {
      const url = new URL(c.req.url);
      return c.redirect(loginRedirect(url.pathname + url.search), 302);
    }
    const q = (key: string) => c.req.query(key) || undefined;
    const { workspace, owner } = await connectTarget(c, user, q);
    const connectorId = c.req.param('connectorId');
    const connector = await s.connectors.get(workspace.id, connectorId);
    if (!connector) throw badRequest(`Unknown service "${connectorId}"`);

    const via = q('via') === 'oauth' ? 'oauth' : await s.admin.connectVia(workspace.id, connector);
    if (via === 'form' || q('via') === 'form') {
      const reconnect = await reconnectTarget(c, user, workspace, connector, q('account'));
      return renderForm(c, connector, {
        oauth: via === 'oauth',
        hidden: hiddenFrom(q),
        values: prefilledValues(connectFormFields(connector, c.get('locale')), q),
        ...(reconnect ? { reconnect } : {}),
        ...(q('label') ? { label: q('label')! } : {}),
      });
    }

    const returnTo = q('returnTo');
    let authorizationUrl: string;
    try {
      ({ authorizationUrl } = await s.connect.start(
        { workspaceId: workspace.id, userId: user.id, ...(owner ? { owner } : {}) },
        {
          connectorId,
          ...(q('account') ? { accountId: q('account') } : {}),
          ...(q('app') ? { appId: q('app') } : {}),
          ...(q('label') ? { label: q('label') } : {}),
          ...(q('name') ? { name: q('name') } : {}),
          ...(q('description') ? { description: q('description') } : {}),
          ...(returnTo ? { returnTo: safeNextPath(returnTo) } : {}),
        },
      ));
    } catch (error) {
      // The hub has no OAuth app for this provider yet: say so in plain words, with another way in.
      if (!(error instanceof AppError) || error.code !== 'oauth_app_missing') throw error;
      return renderInApp(
        c,
        user,
        'services',
        <ServiceUnavailablePage
          t={c.get('t')}
          lang={c.get('locale')}
          view={{
            connectorId,
            service: connectorText(connector, c.get('locale')).name,
            isAdmin: user.role === 'admin',
            alternative: serviceAlternative(connectorId, s.connectors.builtin.all(), c.get('locale')),
          }}
        />,
        400,
      );
    }
    return c.redirect(authorizationUrl, 302);
  });

  /** The form post: creates the account (or updates a reconnected one) and checks it. */
  app.post('/connect/:connectorId', async (c) => {
    const s = c.get('services');
    const t = c.get('t');
    const user = await currentUser(c);
    if (!user) return c.redirect(loginRedirect(new URL(c.req.url).pathname), 303);
    const form = await bodyParams(c);
    const cookieOpts = { secure: s.config.secureCookies };
    if (!verifyCsrf(c, form.csrf, { ...cookieOpts, publicUrl: s.config.publicUrl })) {
      return c.html(<ErrorPage t={t} lang={c.get('locale')} message={t('error.csrf')} />, 403);
    }
    const { workspace, owner } = await connectTarget(c, user, (key) => form[key] || undefined);
    const connector = await s.connectors.get(workspace.id, c.req.param('connectorId'));
    if (!connector) throw badRequest(`Unknown service "${c.req.param('connectorId')}"`);

    const fields = connectFormFields(connector, c.get('locale'));
    const values = readConnectForm(fields, form);
    // The "sign in with the provider instead" link only when the provider's sign-in works here.
    const oauthReady =
      Boolean(connector.oauth) && (await s.admin.connectVia(workspace.id, connector)) === 'oauth';
    const reconnect = await reconnectTarget(c, user, workspace, connector, form.account);
    const retry = ({ message, invalid }: FormProblem) =>
      renderForm(
        c,
        connector,
        {
          oauth: oauthReady,
          hidden: hiddenFrom((key) => form[key] || undefined),
          error: message,
          invalid,
          values: visibleValues(fields, form),
          ...(reconnect ? { reconnect } : {}),
          ...(form.label ? { label: form.label } : {}),
        },
        400,
      );
    const problems = Object.entries(values.problems).map(([name, message]) => ({
      field: fields.find((f) => f.name === name),
      message,
    }));
    if (problems.length > 0) return retry(fieldProblems(t, problems));

    let account: AccountRow;
    try {
      account = reconnect
        ? await s.accounts.update(workspace.id, reconnect.id, {
            config: values.config,
            credentials: values.credentials,
          })
        : await s.accounts.create(
            workspace.id,
            {
              connectorId: connector.id,
              // A blank name becomes the mailbox address when there is one, so two mailboxes differ.
              label:
                form.label?.trim() ||
                (typeof values.config.email === 'string' ? values.config.email : undefined) ||
                (typeof form.email === 'string' && form.email.trim() ? form.email.trim() : undefined) ||
                connector.name,
              ...(form.name ? { name: form.name } : {}),
              config: values.config,
              credentials: values.credentials,
            },
            owner,
          );
    } catch (error) {
      if (error instanceof AppError && error.status < 500) return retry(formError(t, fields, error));
      throw error;
    }
    const test = await s.accounts.test(workspace.id, account.id, s.logger);
    if (!test.ok && !reconnect && form.keep !== '1') {
      // A new account that cannot sign in is not kept: the form comes back with the reason, so a
      // typo does not leave a broken account behind (the user can still keep it on purpose).
      await s.accounts.delete(workspace.id, account.id);
      const rejected = testProblem(t, fields, connectorText(connector, c.get('locale')).name, test.message);
      return renderForm(
        c,
        connector,
        {
          oauth: oauthReady,
          hidden: hiddenFrom((key) => form[key] || undefined),
          error: rejected.message,
          invalid: rejected.invalid,
          values: visibleValues(fields, form),
          // Keeping an account helps when the service is away for a while, not with wrong details.
          offerKeep: rejected.keepable,
          ...(form.label ? { label: form.label } : {}),
        },
        400,
      );
    }
    s.logger.info({ accountId: account.id, connectorId: connector.id }, 'account connected with the form');
    return renderConnected(c, user, connector, {
      account,
      created: !reconnect,
      identity: test.identity,
      problem: test.ok ? undefined : (test.message ?? undefined),
      returnTo: safeNextPath(form.returnTo, '/app/services'),
    });
  });

  return app;
}

/**
 * The workspace a connect link puts the account in: a team (`team=<slug>`, as the user's own
 * account or with `owner=team` the team's) or the user's personal workspace.
 */
async function connectTarget(
  c: AppContext,
  user: SessionUser,
  get: (key: string) => string | undefined,
): Promise<{ workspace: Workspace; owner?: AccountOwnerInput }> {
  const s = c.get('services');
  const slug = get('team');
  if (!slug) {
    const workspace = await getDefaultWorkspace(s.db, user.id);
    if (!workspace) throw badRequest('No workspace');
    return { workspace };
  }
  const team = await s.teams.bySlug(slug);
  if (!team) throw notFound('Team');
  const owner: AccountOwnerInput = { userId: get('owner') === 'team' ? null : user.id };
  await s.teams.assertCanConnect(team.id, user.id, owner);
  return { workspace: team, owner };
}

/** The account a link reconnects, if any: of this service, and one the user manages. */
async function reconnectTarget(
  c: AppContext,
  user: SessionUser,
  workspace: Workspace,
  connector: ConnectorDefinition,
  accountId: string | undefined,
): Promise<AccountRow | undefined> {
  if (!accountId) return undefined;
  const s = c.get('services');
  const account = await s.accounts.get(workspace.id, accountId).catch(() => undefined);
  if (account?.connectorId !== connector.id) throw notFound('Account');
  await s.teams.assertCanManage(workspace.id, user.id, account);
  return account;
}

/** Query or form values carried through the connect form. */
function hiddenFrom(get: (key: string) => string | undefined): Record<string, string> {
  const hidden: Record<string, string> = {};
  for (const key of ['name', 'account', 'returnTo', 'description', 'team', 'owner'] as const) {
    const value = get(key);
    if (value) hidden[key] = key === 'returnTo' ? safeNextPath(value) : value;
  }
  return hidden;
}

/**
 * Settings a link may fill in for the user (`?config.provider=gmail`): only non-secret fields, so a
 * link can never plant a password or token.
 */
function prefilledValues(
  fields: FormField[],
  get: (key: string) => string | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = field.group === 'config' ? get(field.name) : undefined;
    if (value !== undefined) values[field.name] = value.slice(0, 500);
  }
  return values;
}

/** What the user typed, minus secrets: shown again when the form comes back with an error. */
function visibleValues(fields: FormField[], form: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.group === 'config' && form[field.name] !== undefined) values[field.name] = form[field.name]!;
    if (field.kind === 'boolean') values[field.name] = String(form[field.name] === 'on');
  }
  return values;
}

/** An error to show above the submit button, and the inputs it is about. */
interface FormProblem {
  message: string;
  /** Input names of the fields at fault (their "Advanced" block opens). */
  invalid: string[];
}

/** Names fields by their label as the user sees it, e.g. "Адрес сервера IMAP: required ...". */
function fieldProblems(
  t: Translate,
  problems: Array<{ field?: FormField | undefined; path?: string | undefined; message?: string | undefined }>,
): FormProblem {
  const details = problems
    .map(({ field, path, message }) => {
      const name = field?.label ?? path;
      return name ? `${name}: ${message ?? ''}` : (message ?? '');
    })
    .join('; ');
  return {
    message: t('connect.formInvalid', { details }),
    invalid: problems.flatMap(({ field }) => (field ? [field.name] : [])),
  };
}

/**
 * Why a new account's check failed, said by its cause: a server that cannot be reached points at
 * the address fields (not the password), rejected details at the secrets. The service's own words
 * stay in brackets; system error codes do not.
 */
function testProblem(
  t: Translate,
  fields: FormField[],
  service: string,
  raw: string | undefined,
): FormProblem & { keepable: boolean } {
  const problem = classifyProblem(raw);
  const message = (raw ?? t('error.internal')).replace(/\.+$/, '').slice(0, 300);
  const secrets = fields.filter((f) => f.group === 'credentials' && f.required).map((f) => f.name);
  switch (problem.kind) {
    case 'unreachable':
      return {
        message: t('problem.form.unreachable', { host: problem.host ?? service }),
        invalid: fields
          .filter((f) => f.group === 'config' && /host|server|url|port/i.test(f.name))
          .map((f) => f.name),
        keepable: true,
      };
    case 'signin':
    case 'denied':
      return {
        message: t(`problem.form.${problem.kind}`, { service, message }),
        invalid: secrets,
        keepable: false,
      };
    case 'busy':
    case 'service':
      return {
        message: t(`problem.form.${problem.kind}`, { service, message }),
        invalid: [],
        keepable: true,
      };
    default:
      return { message: t('connect.testRejected', { service, message }), invalid: secrets, keepable: true };
  }
}

function formError(t: Translate, fields: FormField[], error: AppError): FormProblem {
  if (!Array.isArray(error.details) || error.details.length === 0)
    return { message: error.message, invalid: [] };
  const issues = error.details as Array<{ path?: string; message?: string }>;
  return fieldProblems(
    t,
    issues.map((issue) => ({ ...issue, field: fieldForIssue(fields, issue.path) })),
  );
}

/** The "Connected" page in the dashboard: what to ask the AI now, and the next step. */
async function renderConnected(
  c: AppContext,
  user: SessionUser,
  connector: ConnectorDefinition | undefined,
  result: {
    account: AccountRow;
    created: boolean;
    identity?: string | undefined;
    problem?: string | undefined;
    returnTo: string;
  },
) {
  const s = c.get('services');
  const locale = c.get('locale');
  const ws = result.account.workspaceId;
  const [grants, tokens] = await Promise.all([s.oauth.listGrants(ws), s.apiTokens.list(ws)]);
  const via = connector?.oauth ? 'oauth' : 'form';
  return renderInApp(
    c,
    user,
    'services',
    <ConnectedPage
      t={c.get('t')}
      lang={locale}
      view={{
        connectorId: result.account.connectorId,
        service: connector ? connectorText(connector, locale).name : result.account.connectorId,
        label: result.account.label,
        created: result.created,
        identity: result.identity,
        problem: result.problem,
        returnTo: result.returnTo,
        prompts: connector ? connectorGuide(connector, locale, via).prompts : [],
        needsAi: grants.length + tokens.length === 0,
        accountUrl: `/app/accounts/${encodeURIComponent(result.account.id)}`,
      }}
    />,
  );
}

async function renderForm(
  c: AppContext,
  connector: ConnectorDefinition,
  options: {
    oauth: boolean;
    hidden: Record<string, string>;
    reconnect?: AccountRow;
    label?: string;
    error?: string;
    invalid?: string[];
    values?: Record<string, string>;
    offerKeep?: boolean;
  },
  status: 200 | 400 = 200,
) {
  const s = c.get('services');
  const user = await currentUser(c);
  const csrf = csrfToken(c, { secure: s.config.secureCookies });
  const locale = c.get('locale');
  const fields = connectFormFields(connector, locale);
  const text = connectorText(connector, locale);
  const stored: Record<string, string> = {};
  if (options.reconnect) {
    for (const [key, value] of Object.entries(options.reconnect.config)) {
      stored[`config.${key}`] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }
  const oauthUrl = new URL(`/connect/${encodeURIComponent(connector.id)}`, s.config.publicUrl);
  for (const [key, value] of Object.entries(options.hidden)) oauthUrl.searchParams.set(key, value);
  const variants = connector.ui?.setupVariants;
  const fieldName = (key: string | undefined) => fields.find((f) => f.key === key)?.name;
  const view: ConnectFormView = {
    connectorId: connector.id,
    service: text.name,
    description: text.description,
    fields,
    hidden: options.hidden,
    guide: connectorGuide(connector, locale, 'form').setup,
    picker:
      variants && fieldName(variants.field)
        ? {
            field: fieldName(variants.field)!,
            emailField: fieldName(variants.emailField),
            domains: variants.domains,
          }
        : undefined,
    actions: connector.actions.map((a) => ({
      title: actionText(connector, a, locale).title,
      risk: actionRisk(a),
    })),
    ...(options.offerKeep ? { offerKeep: true } : {}),
    values: { ...stored, ...options.values },
    ...(options.reconnect ? { reconnecting: options.reconnect.label } : {}),
    ...(options.label ? { label: options.label } : {}),
    ...(options.error ? { error: options.error } : {}),
    ...(options.invalid?.length ? { invalid: options.invalid } : {}),
    ...(options.oauth ? { oauthUrl: oauthUrl.pathname + oauthUrl.search } : {}),
  };
  const page = <ConnectFormPage t={c.get('t')} lang={locale} csrf={csrf} view={view} />;
  return user ? renderInApp(c, user, 'services', page, status) : c.html(page, status);
}
