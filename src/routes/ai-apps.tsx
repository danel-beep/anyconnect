import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { AiAppPage } from '../web/ai-app-page.js';
import type { AppContext, AppEnv } from './context.js';
import { appAction, appPage, callViews, pageCtx, setFlash, shellInfo, takeFlash } from './page-helpers.js';

const RECENT_CALLS = 20;

const appPath = (c: AppContext) => `/app/apps/${encodeURIComponent(c.req.param('id') ?? '')}`;

/**
 * One AI app in the dashboard (`/app/apps/:id`): its sign-ins and tokens, its rule, its name, its
 * recent actions, and disconnecting or removing it. The chat has the same through
 * `manyplug_apps`, `manyplug_rename_app` and `manyplug_disconnect_app` (`src/hub/app-tools.ts`).
 */
export function aiAppRoutes() {
  const app = new Hono<AppEnv>();

  app.get(
    '/app/apps/:id',
    appPage('/app/apps', async (c, auth) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const id = c.req.param('id')!;
      // A removed app (or another workspace's) leads back to the list.
      const found = await s.aiApps.get(ws, id).catch((error: unknown) => {
        if (error instanceof AppError && error.status === 404) return undefined;
        throw error;
      });
      if (!found) return c.redirect('/app/apps', 302);
      const [personas, rules, security, entitlements, credentials, shell] = await Promise.all([
        s.personas.list(ws),
        s.policies.listRules(ws),
        s.admin.security(ws),
        s.entitlements.entitlements(ws),
        s.aiApps.credentialIds(ws, found.id),
        shellInfo(c, ws),
      ]);
      const calls = await s.activity.recent(ws, {
        limit: RECENT_CALLS,
        sinceDays: entitlements.limits.historyDays,
        filter: { principalIds: credentials },
      });
      const profiles = new Map(personas.map((p) => [p.id, { id: p.id, name: p.name }]));
      // The app's own rule as the rules page edits it: not narrowed to a profile, account or service.
      const rule = rules.find(
        (r) =>
          r.aiClientId === found.id && r.accountId === null && r.personaId === null && r.connectorId === null,
      );
      return c.html(
        <AiAppPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            app: {
              id: found.id,
              name: found.name,
              kind: found.kind,
              createdAt: found.createdAt,
              lastUsedAt: found.lastUsedAt,
            },
            connections: found.connections.map((x) => ({
              id: x.id,
              kind: x.kind,
              name: x.name,
              profile: x.personaId ? (profiles.get(x.personaId) ?? null) : null,
              createdAt: x.createdAt,
              lastUsedAt: x.lastUsedAt,
              expiresAt: x.expiresAt,
            })),
            rule: { access: rule?.access ?? null, confirm: rule?.confirm ?? null },
            defaults: { access: security.defaultAccess, confirm: security.defaultConfirm },
            calls: await callViews(c, ws, calls),
            flash: takeFlash(c),
          }}
        />,
      );
    }),
  );

  app.post('/app/apps/:id/rename', (c) =>
    appAction(appPath(c), async (c, auth, form) => {
      const name = z
        .string()
        .trim()
        .min(1)
        .max(100)
        .parse(form.name ?? '');
      await c.get('services').aiApps.rename(auth.workspace.id, c.req.param('id')!, name);
      setFlash(c, 'ok', 'aiapp.flash.renamed');
      return undefined;
    })(c),
  );

  app.post('/app/apps/:id/disconnect', (c) =>
    appAction(appPath(c), async (c, auth) => {
      const s = c.get('services');
      const found = await s.aiApps.get(auth.workspace.id, c.req.param('id')!);
      await s.aiApps.disconnect(auth.workspace.id, found.id);
      setFlash(c, 'ok', 'aiapp.flash.disconnected', { name: found.name });
      return undefined;
    })(c),
  );

  app.post('/app/apps/:id/forget', (c) =>
    appAction(appPath(c), async (c, auth) => {
      await c.get('services').aiApps.forget(auth.workspace.id, c.req.param('id')!);
      setFlash(c, 'ok', 'aiapp.flash.removed');
      return c.redirect('/app/apps', 303);
    })(c),
  );

  return app;
}
