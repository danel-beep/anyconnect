import type { Hono } from 'hono';
import { z } from 'zod';
import { getWorkspace } from '../core/identity.js';
import { forbidden, notFound } from '../lib/errors.js';
import { toAiClientView } from '../security/clients.js';
import { previewArguments } from '../security/confirmations.js';
import type { PendingCallRow } from '../security/pending-calls.js';
import { ACCESS_LEVELS, CONFIRM_IN, CONFIRM_LEVELS, DEFAULT_SECURITY } from '../security/policy.js';
import { toRuleView } from '../security/policy-service.js';
import { json, principal } from './api-helpers.js';
import type { AppEnv } from './context.js';

async function pendingCallJson(s: AppEnv['Variables']['services'], row: PendingCallRow) {
  const d = await s.confirmations.describe(row);
  return {
    id: row.id,
    status: row.status,
    client: d.client,
    service: d.service,
    account: d.account,
    action: d.action,
    tool: row.toolName,
    risk: row.risk,
    reason: row.reason,
    arguments: previewArguments(s.pendingCalls.args(row)),
    confirmUrl: s.confirmations.confirmUrl(row.id),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    executeAt: row.executeAt,
  };
}

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
        confirmIn: z.enum(CONFIRM_IN).optional(),
      }),
    );
    return c.json(await s.admin.updateSecurity(p.workspaceId, body));
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

  // --- Held-back calls -------------------------------------------------------
  api.get('/pending-calls', async (c) => {
    const s = c.get('services');
    const rows = await s.pendingCalls.listOpen(principal(c).workspaceId);
    return c.json({ calls: await Promise.all(rows.map((row) => pendingCallJson(s, row))) });
  });

  api.get('/pending-calls/:id', async (c) => {
    const s = c.get('services');
    const row = await s.pendingCalls.getInWorkspace(principal(c).workspaceId, c.req.param('id'));
    return c.json(await pendingCallJson(s, row));
  });

  api.post('/pending-calls/:id/:decision{approve|deny|cancel}', async (c) => {
    const s = c.get('services');
    const p = principal(c);
    const decision = c.req.param('decision') as 'approve' | 'deny' | 'cancel';
    // A confirmation protects the user from their AI apps, so no token can answer it, not even a
    // personal access token: only the user signed in to the web panel. Cancelling is always allowed.
    if (decision !== 'cancel' && p.kind !== 'session') {
      throw forbidden('Only the signed-in user can approve or deny an action (web panel or Telegram).');
    }
    const id = c.req.param('id');
    const held = await s.pendingCalls.getInWorkspace(p.workspaceId, id);
    if (decision === 'approve') await s.retainVault(held);
    const row = await s.confirmations.decide(id, decision, 'api');
    if (!row)
      return c.json({ error: { code: 'conflict', message: 'The call was already decided or expired' } }, 409);
    return c.json(await pendingCallJson(s, row));
  });
}
