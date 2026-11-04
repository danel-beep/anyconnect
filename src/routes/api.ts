import { verifyBearerToken } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { actionCapabilities, actionIdempotent, actionRisk, toJsonSchema } from '../connectors/sdk.js';
import { toAccountView } from '../core/accounts.js';
import { toApiTokenView } from '../core/api-tokens.js';
import { principalFromAuthInfo } from '../core/auth.js';
import { getDefaultWorkspace, getUser, getWorkspace } from '../core/identity.js';
import { workspaces } from '../db/schema.js';
import { AppError, notFound, unauthorized } from '../lib/errors.js';
import { json, principal } from './api-helpers.js';
import { securityRoutes } from './api-security.js';
import { type AppEnv, currentUser } from './context.js';

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
    if (authorization) {
      try {
        const info = await verifyBearerToken(authorization, {
          verifier: s.verifier,
          requiredScopes: ['api'],
        });
        c.set('principal', principalFromAuthInfo(info));
      } catch {
        throw unauthorized('Invalid or insufficient token: use a personal access token');
      }
    } else {
      const user = await currentUser(c);
      if (!user) throw unauthorized();
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
    }
    await next();
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
        settings: z.object({ toolExposure: z.enum(['grouped', 'per_account']).optional() }).optional(),
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

  api.post('/accounts/:id/test', async (c) => {
    const s = c.get('services');
    return c.json(await s.accounts.test(principal(c).workspaceId, c.req.param('id'), s.logger));
  });

  // --- Tools as the AI sees them -------------------------------------------
  api.get('/tools', async (c) => {
    const catalog = await c.get('services').hub.getCatalog(principal(c));
    return c.json({
      exposure: catalog.mode,
      instructions: catalog.instructions,
      tools: catalog.tools.map(({ name, title, description, inputSchema, annotations, risk }) => ({
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
        scopes: z
          .array(z.enum(['mcp', 'api']))
          .min(1)
          .optional(),
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
