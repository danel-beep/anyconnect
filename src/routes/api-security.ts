import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { getWorkspace } from '../core/identity.js';
import { workspaces } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { toAiClientView } from '../security/clients.js';
import { ACCESS_LEVELS, CONFIRM_LEVELS, DEFAULT_SECURITY } from '../security/policy.js';
import { toRuleView } from '../security/policy-service.js';
import { json, principal } from './api-helpers.js';
import type { AppEnv } from './context.js';

/**
 * Data protection endpoints of the REST API: AI clients, personas, access rules and the
 * workspace's default policy. Registered on the authenticated `/api/v1` router.
 */
export function securityRoutes(api: Hono<AppEnv>) {
  // --- Default policy -------------------------------------------------------
  api.get('/security', async (c) => {
    const s = c.get('services');
    const workspace = await getWorkspace(s.db, principal(c).workspaceId);
    if (!workspace) throw notFound('Workspace');
    return c.json({ ...DEFAULT_SECURITY, ...workspace.settings.security });
  });

  api.patch('/security', async (c) => {
    const s = c.get('services');
    const p = principal(c);
    const body = await json(
      c,
      z.object({
        defaultAccess: z.enum(ACCESS_LEVELS).optional(),
        defaultConfirm: z.enum(CONFIRM_LEVELS).optional(),
        undoWindowSeconds: z.number().int().min(0).max(3600).optional(),
      }),
    );
    const workspace = await getWorkspace(s.db, p.workspaceId);
    if (!workspace) throw notFound('Workspace');
    const security = { ...workspace.settings.security, ...body };
    await s.db
      .update(workspaces)
      .set({ settings: { ...workspace.settings, security } })
      .where(eq(workspaces.id, p.workspaceId));
    return c.json({ ...DEFAULT_SECURITY, ...security });
  });

  // --- AI clients -------------------------------------------------------------
  api.get('/clients', async (c) => {
    const rows = await c.get('services').aiClients.list(principal(c).workspaceId);
    return c.json(rows.map(toAiClientView));
  });

  api.patch('/clients/:id', async (c) => {
    const body = await json(c, z.object({ name: z.string().trim().min(1).max(100) }));
    const row = await c
      .get('services')
      .aiClients.rename(principal(c).workspaceId, c.req.param('id'), body.name);
    return c.json(toAiClientView(row));
  });

  api.delete('/clients/:id', async (c) => {
    await c.get('services').aiClients.delete(principal(c).workspaceId, c.req.param('id'));
    return c.body(null, 204);
  });

  // --- Personas ---------------------------------------------------------------
  api.get('/personas', async (c) => {
    const s = c.get('services');
    const rows = await s.personas.list(principal(c).workspaceId);
    return c.json(rows.map((row) => s.personas.toView(row)));
  });

  api.post('/personas', async (c) => {
    const s = c.get('services');
    const body = await json(c, z.record(z.string(), z.unknown()));
    const row = await s.personas.create(principal(c).workspaceId, body as never);
    return c.json(s.personas.toView(row), 201);
  });

  api.get('/personas/:id', async (c) => {
    const s = c.get('services');
    return c.json(s.personas.toView(await s.personas.get(principal(c).workspaceId, c.req.param('id'))));
  });

  api.patch('/personas/:id', async (c) => {
    const s = c.get('services');
    const body = await json(c, z.record(z.string(), z.unknown()));
    const row = await s.personas.update(principal(c).workspaceId, c.req.param('id'), body as never);
    return c.json(s.personas.toView(row));
  });

  api.delete('/personas/:id', async (c) => {
    await c.get('services').personas.delete(principal(c).workspaceId, c.req.param('id'));
    return c.body(null, 204);
  });

  // --- Access rules -----------------------------------------------------------
  api.get('/rules', async (c) => {
    const rows = await c.get('services').policies.listRules(principal(c).workspaceId);
    return c.json(rows.map(toRuleView));
  });

  api.post('/rules', async (c) => {
    const body = await json(c, z.record(z.string(), z.unknown()));
    const row = await c.get('services').policies.createRule(principal(c).workspaceId, body as never);
    return c.json(toRuleView(row), 201);
  });

  api.put('/rules/:id', async (c) => {
    const body = await json(c, z.record(z.string(), z.unknown()));
    const row = await c
      .get('services')
      .policies.updateRule(principal(c).workspaceId, c.req.param('id'), body as never);
    return c.json(toRuleView(row));
  });

  api.delete('/rules/:id', async (c) => {
    await c.get('services').policies.deleteRule(principal(c).workspaceId, c.req.param('id'));
    return c.body(null, 204);
  });
}
