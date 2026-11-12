import { Hono } from 'hono';
import { getDefaultWorkspace, type Workspace } from '../core/identity.js';
import type { MemberRole } from '../db/schema.js';
import { isMetadataDocumentClientId, OAuthProtocolError } from '../oauth/clients.js';
import { isLoopbackRedirect, knownAppInName, knownClientName } from '../oauth/redirect.js';
import type { AuthorizationRequest } from '../oauth/server.js';
import { suggestClientIdentity } from '../security/clients.js';
import { clientRateKey, csrfToken, publicCors, verifyCsrf } from '../web/http.js';
import { ConsentPage, ErrorPage } from '../web/pages.js';
import {
  type AppContext,
  type AppEnv,
  bodyParams,
  currentSession,
  currentUser,
  loginUrl,
  secondFactorRedirect,
} from './context.js';

/** Authorization requests one address may open per minute for clients named by a metadata URL. */
const AUTHORIZE_DOCUMENTS_PER_MINUTE = 60;

const OAUTH_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'resource',
] as const;

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function pickOAuthParams(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of OAUTH_PARAMS) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function oauthErrorResponse(c: AppContext, error: unknown) {
  if (error instanceof OAuthProtocolError) {
    const headers: Record<string, string> = { ...NO_STORE };
    if (error.status === 401 && c.req.header('authorization')?.toLowerCase().startsWith('basic ')) {
      headers['WWW-Authenticate'] = 'Basic realm="manyplug"';
    }
    return c.json(error.toJSON(), error.status as 400 | 401, headers);
  }
  throw error;
}

function rateLimited(c: AppContext, key: string, limit: number, windowMs: number) {
  const result = c.get('services').rateLimiter.consume(key, limit, windowMs);
  if (result.allowed) return undefined;
  return c.json({ error: 'slow_down', error_description: 'Too many requests' }, 429, {
    'Retry-After': String(result.retryAfterSeconds),
  });
}

function displayName(request: AuthorizationRequest): { clientName: string; verifiedDomain?: string } {
  const verifiedDomain =
    request.client.registrationType === 'metadata_document' ? new URL(request.client.id).host : undefined;
  const clientName =
    request.client.metadata.client_name ??
    verifiedDomain ??
    knownClientName(new URL(request.redirectUri).host) ??
    'Application';
  return verifiedDomain ? { clientName, verifiedDomain } : { clientName };
}

/** Where the app takes the user (and the access) back to; a custom scheme for a desktop app. */
function redirectHostOf(request: AuthorizationRequest): string {
  const redirect = new URL(request.redirectUri);
  return redirect.host || `${redirect.protocol}//`;
}

type PersonaRow = NonNullable<Awaited<ReturnType<AppContext['var']['services']['personas']['bySlug']>>>;

/** Where an app that asks for an MCP URL connects, and how many accounts it will see there. */
type ConsentTarget =
  | { kind: 'personal'; workspace: Workspace; persona: PersonaRow | null; visible: number }
  | { kind: 'team'; workspace: Workspace; role: MemberRole; visible: number }
  | { kind: 'error'; message: string; status: 403 | 404 | 500 };

/**
 * The workspace behind the requested MCP URL: a team the user belongs to (`/mcp/team/<slug>`), or
 * their personal workspace, maybe through a persona (`/mcp/<persona>`). Someone outside a team gets
 * the same answer whether the team exists or not.
 */
async function consentTarget(c: AppContext, userId: string, resource: string): Promise<ConsentTarget> {
  const s = c.get('services');
  const t = c.get('t');
  const teamSlug = s.teams.slugOfResource(resource);
  if (teamSlug) {
    const team = await s.teams.bySlug(teamSlug);
    const membership = team ? await s.teams.forMember(team.id, userId).catch(() => undefined) : undefined;
    if (!team || !membership) return { kind: 'error', message: t('consent.teamMissing'), status: 403 };
    const view = await s.teams.view({ kind: 'session', userId, workspaceId: team.id, scopes: [] });
    const visible = (await s.accounts.list(team.id)).filter((a) => a.enabled && view?.access.access[a.id]);
    return { kind: 'team', workspace: team, role: membership.role, visible: visible.length };
  }
  const workspace = await getDefaultWorkspace(s.db, userId);
  if (!workspace) return { kind: 'error', message: 'No workspace', status: 500 };
  const slug = s.personas.slugOfResource(resource);
  const persona = slug ? await s.personas.bySlug(workspace.id, slug) : null;
  if (persona === undefined) return { kind: 'error', message: t('consent.personaMissing'), status: 404 };
  const visible = (await s.accounts.list(workspace.id)).filter(
    (a) => a.enabled && (!persona || persona.accountIds.includes(a.id)),
  );
  return { kind: 'personal', workspace, persona, visible: visible.length };
}

const NEW_CLIENT = 'new';

async function clientChoice(c: AppContext, workspaceId: string, request: AuthorizationRequest) {
  const s = c.get('services');
  const identity = suggestClientIdentity(request.client, request.redirectUri);
  const [existing, all] = await Promise.all([
    s.aiClients.findByKey(workspaceId, identity.matchKey),
    s.aiClients.list(workspaceId),
  ]);
  const t = c.get('t');
  const options = [
    ...(existing ? [] : [{ value: NEW_CLIENT, label: t('consent.clientNew', { name: identity.name }) }]),
    ...all.map((client) => ({ value: client.id, label: client.name })),
  ];
  return { identity, selected: existing?.id ?? NEW_CLIENT, options };
}

async function renderConsent(c: AppContext, request: AuthorizationRequest, params: Record<string, string>) {
  const s = c.get('services');
  const user = (await currentUser(c))!;
  const target = await consentTarget(c, user.id, request.resource);
  if (target.kind === 'error')
    return c.html(
      <ErrorPage t={c.get('t')} lang={c.get('locale')} message={target.message} />,
      target.status,
    );
  const { workspace } = target;
  const persona = target.kind === 'personal' ? target.persona : null;
  const choice = await clientChoice(c, workspace.id, request);
  const redirect = new URL(request.redirectUri);
  const redirectHost = redirectHostOf(request);
  const { clientName, verifiedDomain } = displayName(request);
  const knownApp =
    knownClientName(redirect.host) ?? (verifiedDomain ? knownClientName(verifiedDomain) : undefined);
  const trusted = knownApp && redirect.protocol === 'https:' ? knownApp : undefined;
  const loopback = isLoopbackRedirect(request.redirectUri);
  // A local app is covered by the localhost warning; anything else that borrows a famous name
  // without coming from that app's hosts is called out.
  const borrowed = knownAppInName(clientName);
  return c.html(
    <ConsentPage
      t={c.get('t')}
      lang={c.get('locale')}
      view={{
        clientName,
        ...(verifiedDomain ? { verifiedDomain } : {}),
        redirectHost,
        ...(trusted ? { knownApp: trusted } : {}),
        ...(!trusted && !loopback && borrowed ? { lookalike: borrowed } : {}),
        loopback,
        workspaceName: workspace.name,
        activeAccounts: target.visible,
        ...(persona ? { persona: { name: persona.name, slug: persona.slug } } : {}),
        ...(target.kind === 'team' ? { team: { name: workspace.name } } : {}),
        clientChoice: { selected: choice.selected, options: choice.options },
        email: user.email,
        csrf: csrfToken(c, { secure: s.config.secureCookies }),
        hidden: params,
      }}
    />,
  );
}

/** OAuth authorization server endpoints plus the consent page (sign-in lives in `login.tsx`). */
export function oauthRoutes() {
  const app = new Hono<AppEnv>();

  // --- Discovery ------------------------------------------------------------
  app.use('/.well-known/*', publicCors());
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(c.get('services').oauth.metadata()));
  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json(c.get('services').oauth.protectedResourceMetadata()),
  );
  app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
    c.json(c.get('services').oauth.protectedResourceMetadata()),
  );
  const subResourceMetadata = (c: AppContext, path: string) => {
    const s = c.get('services');
    const resource = s.oauth.canonicalResource(`${s.config.mcpUrl}/${path}`);
    if (!resource) return c.json({ error: 'not_found' }, 404);
    return c.json(s.oauth.protectedResourceMetadata(resource));
  };
  app.get('/.well-known/oauth-protected-resource/mcp/team/:team', (c) =>
    subResourceMetadata(c, `team/${c.req.param('team')}`),
  );
  app.get('/.well-known/oauth-protected-resource/mcp/:persona', (c) =>
    subResourceMetadata(c, c.req.param('persona')),
  );

  // --- Client registration, token, revocation (machine endpoints) ----------
  app.use('/oauth/register', publicCors());
  app.use('/oauth/token', publicCors());
  app.use('/oauth/revoke', publicCors());

  app.post('/oauth/register', async (c) => {
    const s = c.get('services');
    const limited = rateLimited(c, `register:${clientRateKey(c, s.config.trustProxy)}`, 30, 60 * 60_000);
    if (limited) return limited;
    const body = await c.req.json().catch(() => undefined);
    try {
      return c.json(await s.clients.register(body), 201, NO_STORE);
    } catch (error) {
      return oauthErrorResponse(c, error);
    }
  });

  app.post('/oauth/token', async (c) => {
    const s = c.get('services');
    const limited = rateLimited(c, `token:${clientRateKey(c, s.config.trustProxy)}`, 120, 60_000);
    if (limited) return limited;
    try {
      const tokens = await s.oauth.token(await bodyParams(c), c.req.header('authorization'));
      return c.json(tokens, 200, NO_STORE);
    } catch (error) {
      return oauthErrorResponse(c, error);
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const s = c.get('services');
    try {
      await s.oauth.revoke(await bodyParams(c), c.req.header('authorization'));
      return c.body(null, 200, NO_STORE);
    } catch (error) {
      return oauthErrorResponse(c, error);
    }
  });

  // --- Authorization (browser) ---------------------------------------------
  app.get('/oauth/authorize', async (c) => {
    const s = c.get('services');
    const params = pickOAuthParams(c.req.query());
    // A client id that is a URL makes the hub fetch its metadata document, so one address cannot
    // ask for many of them (the request needs no sign-in).
    if (isMetadataDocumentClientId(params.client_id ?? '')) {
      const limited = s.rateLimiter.consume(
        `authorize:${clientRateKey(c, s.config.trustProxy)}`,
        AUTHORIZE_DOCUMENTS_PER_MINUTE,
        60_000,
      );
      if (!limited.allowed) {
        return c.html(
          <ErrorPage t={c.get('t')} lang={c.get('locale')} message={c.get('t')('login.rateLimited')} />,
          429,
          { 'Retry-After': String(limited.retryAfterSeconds) },
        );
      }
    }
    const validation = await s.oauth.validateAuthorizationRequest(params);
    if (validation.kind === 'error_page') {
      return c.html(
        <ErrorPage t={c.get('t')} lang={c.get('locale')} message={validation.description} />,
        400,
      );
    }
    if (validation.kind === 'error_redirect') return c.redirect(validation.location, 302);
    const url = new URL(c.req.url);
    const session = await currentSession(c);
    if (!session) return c.redirect(loginUrl(url.pathname + url.search), 302);
    const gate = await secondFactorRedirect(c, session, url.pathname + url.search);
    if (gate) return c.redirect(gate, 302);
    return renderConsent(c, validation.request, params);
  });

  app.post('/oauth/authorize', async (c) => {
    const s = c.get('services');
    const form = await bodyParams(c);
    if (!verifyCsrf(c, form.csrf, { secure: s.config.secureCookies, publicUrl: s.config.publicUrl })) {
      return c.html(
        <ErrorPage t={c.get('t')} lang={c.get('locale')} message={c.get('t')('error.csrf')} />,
        403,
      );
    }
    const params = pickOAuthParams(form);
    const session = await currentSession(c);
    const retry = `/oauth/authorize?${new URLSearchParams(params)}`;
    if (!session) return c.redirect(loginUrl(retry), 303);
    const gate = await secondFactorRedirect(c, session, retry);
    if (gate) return c.redirect(gate, 303);
    const user = session.user;
    const validation = await s.oauth.validateAuthorizationRequest(params);
    if (validation.kind === 'error_page') {
      return c.html(
        <ErrorPage t={c.get('t')} lang={c.get('locale')} message={validation.description} />,
        400,
      );
    }
    if (validation.kind === 'error_redirect') return c.redirect(validation.location, 303);
    if (form.decision !== 'approve') return c.redirect(s.oauth.deny(validation.request), 303);
    const target = await consentTarget(c, user.id, validation.request.resource);
    if (target.kind === 'error')
      return c.html(
        <ErrorPage t={c.get('t')} lang={c.get('locale')} message={target.message} />,
        target.status,
      );
    const { workspace } = target;
    const persona = target.kind === 'personal' ? target.persona : null;
    // Link the app to an AI client entity: the one the user picked, or the suggested identity.
    const { identity } = await clientChoice(c, workspace.id, validation.request);
    const picked = form.ai_client && form.ai_client !== NEW_CLIENT ? form.ai_client : undefined;
    const aiClient = picked
      ? await s.aiClients.get(workspace.id, picked)
      : await s.aiClients.ensure(workspace.id, { ...identity, kind: 'oauth' });
    const location = await s.oauth.approve(validation.request, user.id, workspace.id, {
      aiClientId: aiClient.id,
      ...(persona ? { personaId: persona.id } : {}),
    });
    s.logger.info(
      {
        clientId: validation.request.client.id,
        userId: user.id,
        aiClientId: aiClient.id,
        ...(target.kind === 'team' ? { teamId: workspace.id } : {}),
      },
      'oauth access approved',
    );
    // The name is the app's own claim, so the notice also says where the access goes.
    const { clientName } = displayName(validation.request);
    void s.securityNotices.report(
      user.id,
      'app_connected',
      `${clientName} · ${redirectHostOf(validation.request)}`,
    );
    return c.redirect(location, 303);
  });

  return app;
}
