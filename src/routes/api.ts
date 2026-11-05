import { verifyBearerToken } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { BUILTIN_PROVIDERS, resolveProvider } from '../connectors/oauth/providers.js';
import { actionCapabilities, actionIdempotent, actionRisk, toJsonSchema } from '../connectors/sdk.js';
import { toAccountView } from '../core/accounts.js';
import { TOKEN_SCOPES, toApiTokenView } from '../core/api-tokens.js';
import { principalFromAuthInfo } from '../core/auth.js';
import { StartConnectInput } from '../core/connect.js';
import { getDefaultWorkspace, getUser, getWorkspace } from '../core/identity.js';
import { CreateOAuthAppInput } from '../core/oauth-apps.js';
import { bearerVaultSecret, type VaultSecret } from '../core/vault-scope.js';
import { workspaces } from '../db/schema.js';
import { utcDay } from '../hub/usage.js';
import { AppError, badRequest, notFound, unauthorized } from '../lib/errors.js';
import { json, principal } from './api-helpers.js';
import { securityRoutes } from './api-security.js';
import { type AppEnv, currentSession, secondFactorRedirect } from './context.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Management REST API (`/api/v1`). Authenticated with a personal access token
 * (`Authorization: Bearer ac_pat_...`) or the browser session of the web panel.
 * OAuth tokens issued to AI apps only carry the `mcp` scope and cannot use it.
 */
export function apiRoutes() {
  const api = new Hono<AppEnv>();

  api.use('*', async (c, next) => {
    const s = c.get('services');
    const authorization = c.req.header('authorization');
    let vaultSecret: VaultSecret | undefined;
    if (authorization) {
      try {
        const info = await verifyBearerToken(authorization, {
          verifier: s.verifier,
          requiredScopes: ['api'],
        });
        const principal = principalFromAuthInfo(info);
        // Profile tokens (made before profiles were limited to MCP) never manage the workspace.
        if (principal.personaId) throw unauthorized();
        c.set('principal', principal);
        if (info.token) vaultSecret = bearerVaultSecret(principal, info.token);
      } catch {
        throw unauthorized('Invalid or insufficient token: use a personal access token with the "api" scope');
      }
      // This API sees a whole workspace; in a team each member sees only part of it, which the MCP
      // tools and the team's page enforce. Team keys only carry the `mcp` scope; this is the backstop.
      const workspace = await getWorkspace(s.db, principal(c).workspaceId);
      if (workspace?.kind === 'team') {
        throw new AppError(
          403,
          'team_api_unsupported',
          'The management API works with personal workspaces. Manage a team on its page or from the chat.',
        );
      }
    } else {
      const session = await currentSession(c);
      if (!session) throw unauthorized();
      if (await secondFactorRedirect(c, session, '/')) {
        throw new AppError(403, 'second_factor_required', 'Set up a second factor on /security first');
      }
      const user = session.user;
      // Cookie-authenticated writes must come from the hub's own pages.
      if (UNSAFE.has(c.req.method) && c.req.header('origin') !== s.config.publicUrl) {
        throw new AppError(403, 'forbidden', 'Cross-origin request rejected');
      }
      const workspace = await getDefaultWorkspace(s.db, user.id);
      if (!workspace) throw notFound('Workspace');
      c.set('principal', {
        kind: 'session',
        userId: user.id,
        workspaceId: workspace.id,
        scopes: ['mcp', 'api'],
      });
      // Signed-in browser: the device vault scope set by `webVault()` already applies.
      return next();
    }
    // A personal token opens its owner's vault for this request (sealed accounts, docs/VAULTS.md).
    await s.vaultScopes.run(vaultSecret, () => next());
  });

  api.get('/me', async (c) => {
    const s = c.get('services');
    const p = principal(c);
    const [user, workspace] = await Promise.all([getUser(s.db, p.userId), getWorkspace(s.db, p.workspaceId)]);
    return c.json({
      user: user && { id: user.id, email: user.email, name: user.name },
      workspace: workspace && { id: workspace.id, name: workspace.name, settings: workspace.settings },
      mcpUrl: s.config.mcpUrl,
      authenticatedWith: p.kind,
    });
  });

  api.patch('/workspace', async (c) => {
    const s = c.get('services');
    const p = principal(c);
    const body = await json(
      c,
      z.object({
        name: z.string().trim().min(1).max(100).optional(),
        settings: z
          .object({
            toolExposure: z.enum(['grouped', 'per_account']).optional(),
            toolListing: z.enum(['auto', 'direct', 'discovery']).optional(),
          })
          .optional(),
      }),
    );
    const current = await getWorkspace(s.db, p.workspaceId);
    if (!current) throw notFound('Workspace');
    const [updated] = await s.db
      .update(workspaces)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.settings ? { settings: { ...current.settings, ...body.settings } } : {}),
      })
      .where(eq(workspaces.id, p.workspaceId))
      .returning();
    return c.json({ id: updated!.id, name: updated!.name, settings: updated!.settings });
  });

  // --- Services (connectors) ----------------------------------------------
  api.get('/connectors', async (c) => {
    const s = c.get('services');
    const connectors = await s.connectors.list(principal(c).workspaceId);
    return c.json(
      connectors.map((connector) => ({
        id: connector.id,
        name: connector.name,
        description: connector.description,
        version: connector.version,
        homepage: connector.homepage,
        configSchema: toJsonSchema(connector.config),
        credentialsSchema: toJsonSchema(connector.credentials),
        auth: connector.oauth ? 'oauth2' : 'credentials',
        actions: connector.actions.map((a) => ({
          name: a.name,
          title: a.title,
          description: a.description,
          hints: a.hints ?? {},
          risk: actionRisk(a),
          idempotent: actionIdempotent(a),
          ...(a.undo ? { undo: a.undo } : {}),
          capabilities: actionCapabilities(a).map((b) => b.id),
          ...(a.response?.fields ? { fields: a.response.fields } : {}),
          inputSchema: a.inputSchema ?? toJsonSchema(a.input),
        })),
      })),
    );
  });

  // --- Accounts -------------------------------------------------------------
  api.get('/accounts', async (c) => {
    const rows = await c.get('services').accounts.list(principal(c).workspaceId);
    return c.json(rows.map(toAccountView));
  });

  api.post('/accounts', async (c) => {
    const s = c.get('services');
    const p = principal(c);
    const body = await json(c, z.record(z.string(), z.unknown()));
    const row = await s.accounts.create(p.workspaceId, body as never);
    await s.customServices.afterAccountConnected(row);
    const test = await s.accounts.test(p.workspaceId, row.id, s.logger);
    const fresh = await s.accounts.get(p.workspaceId, row.id);
    return c.json({ account: toAccountView(fresh), test }, 201);
  });

  api.get('/accounts/:id', async (c) => {
    const row = await c.get('services').accounts.get(principal(c).workspaceId, c.req.param('id'));
    return c.json(toAccountView(row));
  });

  api.patch('/accounts/:id', async (c) => {
    const s = c.get('services');
    const body = await json(c, z.record(z.string(), z.unknown()));
    const row = await s.accounts.update(principal(c).workspaceId, c.req.param('id'), body as never);
    return c.json(toAccountView(row));
  });

  api.delete('/accounts/:id', async (c) => {
    await c.get('services').accounts.delete(principal(c).workspaceId, c.req.param('id'));
    return c.body(null, 204);
  });

  // --- Services added without code (remote MCP servers, HTTP manifests) ---
  api.get('/services', async (c) => {
    return c.json(await c.get('services').customServices.list(principal(c).workspaceId));
  });

  api.post('/services', async (c) => {
    const s = c.get('services');
    const body = await json(c, z.record(z.string(), z.unknown()));
    return c.json(await s.customServices.add(principal(c).workspaceId, body as never), 201);
  });

  api.patch('/services/:id', async (c) => {
    const s = c.get('services');
    const body = await json(c, z.record(z.string(), z.unknown()));
    return c.json(await s.customServices.update(principal(c).workspaceId, c.req.param('id'), body));
  });

  api.post('/services/:id/refresh', async (c) => {
    const s = c.get('services');
    return c.json(await s.customServices.refreshTools(principal(c).workspaceId, c.req.param('id')));
  });

  api.delete('/services/:id', async (c) => {
    await c.get('services').customServices.remove(principal(c).workspaceId, c.req.param('id'));
    return c.body(null, 204);
  });

  // --- Connecting accounts through OAuth (the hub is the OAuth client) ------
  api.get('/oauth/providers', async (c) => {
    const s = c.get('services');
    const connectors = await s.connectors.list(principal(c).workspaceId);
    const apps = await s.oauthApps.list(principal(c).workspaceId);
    const providers = new Map<
      string,
      { id: string; name: string; appSetupUrl?: string; connectors: string[] }
    >();
    for (const connector of connectors) {
      if (!connector.oauth) continue;
      const provider = resolveProvider(connector.oauth);
      const entry = providers.get(provider.id) ?? {
        id: provider.id,
        name: provider.name,
        ...(provider.appSetupUrl ? { appSetupUrl: provider.appSetupUrl } : {}),
        connectors: [],
      };
      entry.connectors.push(connector.id);
      providers.set(provider.id, entry);
    }
    return c.json({
      redirectUri: s.connect.redirectUri,
      providers: [...providers.values()].map((p) => ({
        ...p,
        apps: apps.filter((a) => a.providerId === p.id).map((a) => a.id),
      })),
    });
  });

  api.get('/oauth/apps', async (c) => {
    const s = c.get('services');
    return c.json(await s.oauthApps.list(principal(c).workspaceId));
  });

  api.post('/oauth/apps', async (c) => {
    const s = c.get('services');
    const body = await json(c, CreateOAuthAppInput);
    const workspaceId = principal(c).workspaceId;
    const known = new Set(Object.keys(BUILTIN_PROVIDERS));
    for (const connector of await s.connectors.list(workspaceId)) {
      if (connector.oauth) known.add(resolveProvider(connector.oauth).id);
    }
    return c.json(await s.oauthApps.create(workspaceId, body, known), 201);
  });

  api.delete('/oauth/apps/:id', async (c) => {
    await c.get('services').oauthApps.delete(principal(c).workspaceId, c.req.param('id'));
    return c.body(null, 204);
  });

  /** Starts connecting (or re-connecting) an account; open `authorizationUrl` in the browser. */
  api.post('/connect', async (c) => {
    const s = c.get('services');
    const p = principal(c);
    const body = await json(c, StartConnectInput);
    return c.json(await s.connect.start({ workspaceId: p.workspaceId, userId: p.userId }, body), 201);
  });

  api.post('/accounts/:id/test', async (c) => {
    const s = c.get('services');
    return c.json(await s.accounts.test(principal(c).workspaceId, c.req.param('id'), s.logger));
  });

  // --- Messenger accounts ----------------------------------------------------
  /** Webhook URL and token to paste into the messenger's settings, and the connection status. */
  api.get('/accounts/:id/messenger', async (c) => {
    const s = c.get('services');
    const row = await s.accounts.get(principal(c).workspaceId, c.req.param('id'));
    const resolved = await s.messaging.service.resolve(row.id);
    if (!resolved) throw badRequest('This account is not a messenger');
    const messaging = s.messaging.service.forAccount(row.id);
    const state = await s.messaging.accounts.get(row.id);
    return c.json({
      transport: resolved.transport.kind,
      ...(resolved.transport.kind === 'direct' && resolved.transport.webhook
        ? { webhook: { url: messaging.webhook().url, token: messaging.webhook().secret } }
        : {}),
      session: await messaging.session(),
      sendPausedUntil: state?.sendPausedUntil?.toISOString() ?? null,
      sendPauseReason: state?.sendPauseReason ?? null,
    });
  });

  /** Lifts a sending pause (after a spam warning or a long flood wait) once the user decides to. */
  api.post('/accounts/:id/messenger/resume-sending', async (c) => {
    const s = c.get('services');
    const row = await s.accounts.get(principal(c).workspaceId, c.req.param('id'));
    await s.messaging.accounts.resumeSending(row.id);
    s.messaging.dispatcher.kick();
    return c.json({ ok: true });
  });

  // --- Usage ---------------------------------------------------------------
  /** Executed calls per day, caller (AI account or app connection) and action; `?days=` (1–90, default 30). */
  api.get('/usage', async (c) => {
    const s = c.get('services');
    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 90);
    const since = utcDay(new Date(Date.now() - (days - 1) * 86_400_000));
    const rows = await s.usage.list(principal(c).workspaceId, since);
    const total = rows.reduce((n, r) => n + r.calls, 0);
    return c.json({ since, total, rows });
  });

  // --- Tools as the AI sees them -------------------------------------------
  api.get('/tools', async (c) => {
    const catalog = await c.get('services').hub.getCatalog(principal(c));
    // `?all=1` also returns tools that discovery mode does not list (reachable via call_tool).
    const tools = c.req.query('all') ? catalog.tools : catalog.listed;
    return c.json({
      exposure: catalog.mode,
      listing: catalog.listing,
      stats: catalog.stats,
      instructions: catalog.instructions,
      tools: tools.map(({ name, title, description, inputSchema, annotations, risk }) => ({
        name,
        title,
        description,
        inputSchema,
        annotations,
        risk,
      })),
    });
  });

  api.post('/tools/:name/call', async (c) => {
    const s = c.get('services');
    const p = principal(c);
    const body = await json(c, z.object({ arguments: z.record(z.string(), z.unknown()).default({}) }));
    const catalog = await s.hub.getCatalog(p);
    if (!catalog.tools.some((t) => t.name === c.req.param('name'))) throw notFound('Tool');
    return c.json(
      await s.hub.callTool(p, catalog, c.req.param('name'), body.arguments, { signal: c.req.raw.signal }),
    );
  });

  api.get('/tool-calls', async (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    const before = c.req.query('before') ? Number(c.req.query('before')) : undefined;
    const rows = await c
      .get('services')
      .hub.recentToolCalls(principal(c).workspaceId, { limit, ...(before ? { before } : {}) });
    return c.json(rows);
  });

  // --- Connected AI apps (OAuth grants) -------------------------------------
  api.get('/grants', async (c) => {
    const grants = await c.get('services').oauth.listGrants(principal(c).workspaceId);
    return c.json(
      grants.map((g) => ({
        id: g.id,
        clientId: g.clientId,
        clientName: g.clientName,
        aiClientId: g.aiClientId,
        personaId: g.personaId,
        scopes: g.scopes,
        createdAt: g.createdAt,
        lastUsedAt: g.lastUsedAt,
      })),
    );
  });

  api.delete('/grants/:id', async (c) => {
    const revoked = await c.get('services').oauth.revokeGrant(principal(c).workspaceId, c.req.param('id'));
    if (!revoked) throw notFound('Grant');
    return c.body(null, 204);
  });

  securityRoutes(api);

  // --- Personal access tokens -----------------------------------------------
  api.get('/tokens', async (c) => {
    const rows = await c.get('services').apiTokens.list(principal(c).workspaceId);
    return c.json(rows.map(toApiTokenView));
  });

  api.post('/tokens', async (c) => {
    const s = c.get('services');
    const p = principal(c);
    const body = await json(
      c,
      z.object({
        name: z.string().trim().min(1).max(100),
        expiresInDays: z.number().int().min(1).max(3650).optional(),
        /** Default: `["mcp"]`; add `"api"` for scripts that manage the workspace. */
        scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).optional(),
        /** Act as an existing AI client (shares its access rules); by default a new one is created. */
        aiClientId: z.string().optional(),
        /** Bind the token to a persona's MCP URL. */
        personaId: z.string().optional(),
      }),
    );
    if (body.personaId) await s.personas.get(p.workspaceId, body.personaId);
    const aiClient = body.aiClientId
      ? await s.aiClients.get(p.workspaceId, body.aiClientId)
      : await s.aiClients.createUnique(p.workspaceId, body.name, 'api_token');
    const { token, row } = await s.apiTokens.create({
      workspaceId: p.workspaceId,
      userId: p.userId,
      ...body,
      aiClientId: aiClient.id,
    });
    return c.json({ token, ...toApiTokenView(row) }, 201);
  });

  api.delete('/tokens/:id', async (c) => {
    await c.get('services').apiTokens.revoke(principal(c).workspaceId, c.req.param('id'));
    return c.body(null, 204);
  });

  return api;
}
