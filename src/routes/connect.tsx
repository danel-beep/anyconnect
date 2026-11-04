import { Hono } from 'hono';
import { type ConnectorDefinition, connectorText } from '../connectors/sdk.js';
import type { AccountRow } from '../core/accounts.js';
import { connectFormFields, type FormField, fieldForIssue, readConnectForm } from '../core/connect-form.js';
import { hubClientMetadata } from '../core/custom-services.js';
import { getDefaultWorkspace } from '../core/identity.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { ConnectFormPage, type ConnectFormView } from '../web/connect-form.js';
import { csrfToken, safeNextPath, verifyCsrf } from '../web/http.js';
import type { Translate } from '../web/i18n.js';
import { ConnectedPage, ErrorPage } from '../web/pages.js';
import { type AppContext, type AppEnv, bodyParams, currentUser } from './context.js';

/**
 * Browser side of connecting accounts:
 *
 * - `GET /connect/:connectorId?account=&app=&label=&name=&returnTo=` is the link the panel and the
 *   setup tools give out. For OAuth services it starts a flow for the signed-in user and redirects
 *   to the provider (`POST /api/v1/connect` is the API equivalent); for the rest (and with
 *   `via=form` for optional OAuth; `via=oauth` forces the provider's sign-in) it shows a form built from the connector's schemas
 *   (`core/connect-form.ts`), posted back to `POST /connect/:connectorId`;
 * - `GET /connect/callback` is the single redirect URI registered at every provider.
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
    return c.html(
      <ConnectedPage
        t={c.get('t')}
        lang={c.get('locale')}
        view={{
          service: connector ? connectorText(connector, c.get('locale')).name : result.account.connectorId,
          label: result.account.label,
          created: result.created,
          identity,
          problem:
            result.account.status === 'active' ? undefined : (result.account.statusMessage ?? undefined),
          returnTo: safeNextPath(result.returnTo, '/app/services'),
        }}
      />,
    );
  });

  app.get('/connect/:connectorId', async (c) => {
    const s = c.get('services');
    const user = await currentUser(c);
    if (!user) {
      const url = new URL(c.req.url);
      return c.redirect(loginRedirect(url.pathname + url.search), 302);
    }
    const workspace = await getDefaultWorkspace(s.db, user.id);
    if (!workspace) throw badRequest('No workspace');
    const q = (key: string) => c.req.query(key) || undefined;
    const connectorId = c.req.param('connectorId');
    const connector = await s.connectors.get(workspace.id, connectorId);
    if (!connector) throw badRequest(`Unknown service "${connectorId}"`);

    const via = q('via') === 'oauth' ? 'oauth' : await s.admin.connectVia(workspace.id, connector);
    if (via === 'form' || q('via') === 'form') {
      const reconnect = q('account')
        ? await s.accounts.get(workspace.id, q('account')!).catch(() => undefined)
        : undefined;
      if (q('account') && reconnect?.connectorId !== connector.id) throw notFound('Account');
      return renderForm(c, connector, {
        oauth: via === 'oauth',
        hidden: hiddenFrom(q),
        ...(reconnect ? { reconnect } : {}),
        ...(q('label') ? { label: q('label')! } : {}),
      });
    }

    const returnTo = q('returnTo');
    const { authorizationUrl } = await s.connect.start(
      { workspaceId: workspace.id, userId: user.id },
      {
        connectorId,
        ...(q('account') ? { accountId: q('account') } : {}),
        ...(q('app') ? { appId: q('app') } : {}),
        ...(q('label') ? { label: q('label') } : {}),
        ...(q('name') ? { name: q('name') } : {}),
        ...(q('description') ? { description: q('description') } : {}),
        ...(returnTo ? { returnTo: safeNextPath(returnTo) } : {}),
      },
    );
    return c.redirect(authorizationUrl, 302);
  });

  /** The form post: creates the account (or updates a reconnected one) and checks it. */
  app.post('/connect/:connectorId', async (c) => {
    const s = c.get('services');
    const t = c.get('t');
    const user = await currentUser(c);
    if (!user) return c.redirect(loginRedirect(new URL(c.req.url).pathname), 303);
    const workspace = await getDefaultWorkspace(s.db, user.id);
    if (!workspace) throw badRequest('No workspace');
    const connector = await s.connectors.get(workspace.id, c.req.param('connectorId'));
    if (!connector) throw badRequest(`Unknown service "${c.req.param('connectorId')}"`);
    const form = await bodyParams(c);
    const cookieOpts = { secure: s.config.secureCookies };
    if (!verifyCsrf(c, form.csrf, { ...cookieOpts, publicUrl: s.config.publicUrl })) {
      return c.html(<ErrorPage t={t} lang={c.get('locale')} message={t('error.csrf')} />, 403);
    }

    const fields = connectFormFields(connector, c.get('locale'));
    const values = readConnectForm(fields, form);
    const reconnect = form.account
      ? await s.accounts.get(workspace.id, form.account).catch(() => undefined)
      : undefined;
    if (form.account && reconnect?.connectorId !== connector.id) throw notFound('Account');
    const retry = ({ message, invalid }: FormProblem) =>
      renderForm(
        c,
        connector,
        {
          oauth: Boolean(connector.oauth),
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
        : await s.accounts.create(workspace.id, {
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
          });
    } catch (error) {
      if (error instanceof AppError && error.status < 500) return retry(formError(t, fields, error));
      throw error;
    }
    const test = await s.accounts.test(workspace.id, account.id, s.logger);
    s.logger.info({ accountId: account.id, connectorId: connector.id }, 'account connected with the form');
    return c.html(
      <ConnectedPage
        t={t}
        lang={c.get('locale')}
        view={{
          service: connectorText(connector, c.get('locale')).name,
          label: account.label,
          created: !reconnect,
          identity: test.identity,
          problem: test.ok ? undefined : (test.message ?? undefined),
          returnTo: safeNextPath(form.returnTo, '/app/services'),
        }}
      />,
    );
  });

  return app;
}

/** Query or form values carried through the connect form. */
function hiddenFrom(get: (key: string) => string | undefined): Record<string, string> {
  const hidden: Record<string, string> = {};
  for (const key of ['name', 'account', 'returnTo', 'description'] as const) {
    const value = get(key);
    if (value) hidden[key] = key === 'returnTo' ? safeNextPath(value) : value;
  }
  return hidden;
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

function formError(t: Translate, fields: FormField[], error: AppError): FormProblem {
  if (!Array.isArray(error.details) || error.details.length === 0)
    return { message: error.message, invalid: [] };
  const issues = error.details as Array<{ path?: string; message?: string }>;
  return fieldProblems(
    t,
    issues.map((issue) => ({ ...issue, field: fieldForIssue(fields, issue.path) })),
  );
}

function renderForm(
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
  },
  status: 200 | 400 = 200,
) {
  const s = c.get('services');
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
  const view: ConnectFormView = {
    connectorId: connector.id,
    service: text.name,
    description: text.description,
    fields,
    hidden: options.hidden,
    values: { ...stored, ...options.values },
    ...(options.reconnect ? { reconnecting: options.reconnect.label } : {}),
    ...(options.label ? { label: options.label } : {}),
    ...(options.error ? { error: options.error } : {}),
    ...(options.invalid?.length ? { invalid: options.invalid } : {}),
    ...(options.oauth ? { oauthUrl: oauthUrl.pathname + oauthUrl.search } : {}),
  };
  return c.html(<ConnectFormPage t={c.get('t')} lang={locale} csrf={csrf} view={view} />, status);
}
