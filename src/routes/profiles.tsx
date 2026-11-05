import { Hono } from 'hono';
import { z } from 'zod';
import { connectorText } from '../connectors/sdk.js';
import { isSetupConnector } from '../hub/setup-tools.js';
import { AppError } from '../lib/errors.js';
import { MAX_PERSONAS, PERSONA_SLUG } from '../security/personas.js';
import {
  PROFILE_ACCESS,
  type ProfileAccountOption,
  type ProfileDraft,
  ProfilePage,
  ProfilesPage,
} from '../web/profiles.js';
import type { AppContext, AppEnv } from './context.js';
import {
  type AppAuth,
  appAction,
  appPage,
  type FlashKind,
  pageCtx,
  setFlash,
  shellInfo,
  takeFlash,
} from './page-helpers.js';

const ProfileForm = z.object({
  name: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).default(''),
  maxAccess: z.enum(PROFILE_ACCESS).default('full'),
});

/** The workspace's accounts for the picker, grouped by service name. */
async function accountOptions(c: AppContext, workspaceId: string): Promise<ProfileAccountOption[]> {
  const s = c.get('services');
  const [rows, connectors] = await Promise.all([
    s.accounts.list(workspaceId),
    s.connectors.list(workspaceId),
  ]);
  const names = new Map(connectors.map((x) => [x.id, connectorText(x, c.get('locale')).name]));
  return rows
    .filter((a) => !isSetupConnector(a.connectorId))
    .map((a) => ({
      id: a.id,
      label: a.label,
      ref: `${a.connectorId}:${a.name}`,
      connectorId: a.connectorId,
      service: names.get(a.connectorId) ?? a.connectorId,
    }))
    .sort((a, b) => a.service.localeCompare(b.service) || a.label.localeCompare(b.label));
}

/** The accounts ticked in the form (`account.<id>` checkboxes), limited to the workspace's own. */
const pickedAccounts = (form: Record<string, string>, accounts: ProfileAccountOption[]): string[] => {
  const known = new Set(accounts.map((a) => a.id));
  return Object.keys(form)
    .filter((key) => key.startsWith('account.'))
    .map((key) => key.slice('account.'.length))
    .filter((id) => known.has(id));
};

/**
 * Access profiles in the dashboard (`/app/profiles`): list, create, change and delete. A profile is
 * a persona: its own MCP address that shows an AI app only some accounts, with at most some access.
 * The same operations are setup tools in the chat (`manyplug_*_access_profile`).
 */
export function profileRoutes() {
  const app = new Hono<AppEnv>();

  const renderList = async (
    c: AppContext,
    auth: AppAuth,
    retry?: { draft: ProfileDraft; flash: { kind: FlashKind; text: string } },
  ) => {
    const s = c.get('services');
    const ws = auth.workspace.id;
    const [rows, used, accounts, shell] = await Promise.all([
      s.personas.list(ws),
      s.personas.connections(ws),
      accountOptions(c, ws),
      shellInfo(c, ws),
    ]);
    const known = new Set(accounts.map((a) => a.id));
    return c.html(
      <ProfilesPage
        ctx={pageCtx(c, auth.user)}
        shell={shell}
        view={{
          profiles: rows.map((p) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            url: s.personas.urlFor(p.slug),
            accounts: p.accountIds.filter((id) => known.has(id)).length,
            maxAccess: p.maxAccess,
            apps: (used.get(p.id)?.apps ?? 0) + (used.get(p.id)?.tokens ?? 0),
          })),
          accounts,
          max: MAX_PERSONAS,
          draft: retry?.draft,
          flash: retry?.flash ?? takeFlash(c),
        }}
      />,
      retry ? 400 : 200,
    );
  };

  app.get(
    '/app/profiles',
    appPage('/app/profiles', (c, auth) => renderList(c, auth)),
  );

  app.post(
    '/app/profiles',
    appAction('/app/profiles', async (c, auth, form) => {
      const s = c.get('services');
      const t = c.get('t');
      const ws = auth.workspace.id;
      const input = ProfileForm.parse(form);
      const accounts = await accountOptions(c, ws);
      const slug = (form.slug ?? '').trim().toLowerCase();
      const draft: ProfileDraft = { ...input, slug, accountIds: pickedAccounts(form, accounts) };
      // A failed create shows the form again as it was filled in.
      const retry = (text: string) => renderList(c, auth, { draft, flash: { kind: 'bad', text } });
      if (!draft.accountIds.length) return retry(t('profiles.flash.pickOne'));
      if (slug && !PERSONA_SLUG.test(slug)) return retry(t('profiles.flash.addressInvalid'));
      if ((await s.personas.list(ws)).length >= MAX_PERSONAS) {
        return retry(t('profiles.flash.limit', { n: MAX_PERSONAS }));
      }
      try {
        const row = await s.personas.create(ws, {
          slug: slug || (await s.personas.freeSlug(ws, input.name)),
          name: input.name,
          ...(input.note ? { description: input.note } : {}),
          accountIds: draft.accountIds,
          maxAccess: input.maxAccess,
        });
        return c.redirect(`/app/profiles/${encodeURIComponent(row.id)}?created=1`, 303);
      } catch (error) {
        if (error instanceof AppError && error.status === 409) return retry(t('profiles.flash.addressTaken'));
        throw error;
      }
    }),
  );

  app.get(
    '/app/profiles/:id',
    appPage('/app/profiles', async (c, auth) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const row = await s.personas.get(ws, c.req.param('id')!).catch(() => undefined);
      if (!row) return c.redirect('/app/profiles', 302);
      const [grants, tokens, clients, accounts, shell] = await Promise.all([
        s.oauth.listGrants(ws),
        s.apiTokens.list(ws),
        s.aiClients.list(ws),
        accountOptions(c, ws),
        shellInfo(c, ws),
      ]);
      const clientNames = new Map(clients.map((x) => [x.id, x.name]));
      const now = Date.now();
      return c.html(
        <ProfilePage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            profile: {
              id: row.id,
              name: row.name,
              slug: row.slug,
              url: s.personas.urlFor(row.slug),
              description: row.description,
              accountIds: row.accountIds,
              maxAccess: row.maxAccess,
              createdAt: row.createdAt,
            },
            accounts,
            apps: grants
              .filter((g) => g.personaId === row.id)
              .map((g) => ({
                id: g.id,
                name: (g.aiClientId && clientNames.get(g.aiClientId)) || g.clientName || g.clientId,
                createdAt: g.createdAt,
                lastUsedAt: g.lastUsedAt,
              })),
            tokens: tokens
              .filter((tok) => tok.personaId === row.id && (!tok.expiresAt || tok.expiresAt.getTime() > now))
              .map((tok) => ({
                id: tok.id,
                name: tok.name,
                createdAt: tok.createdAt,
                lastUsedAt: tok.lastUsedAt,
                expiresAt: tok.expiresAt,
              })),
            created: c.req.query('created') === '1',
            flash: takeFlash(c),
          }}
        />,
      );
    }),
  );

  const profilePath = (c: AppContext) => `/app/profiles/${encodeURIComponent(c.req.param('id') ?? '')}`;

  app.post('/app/profiles/:id', (c) =>
    appAction(profilePath(c), async (c, auth, form) => {
      const s = c.get('services');
      const ws = auth.workspace.id;
      const input = ProfileForm.parse(form);
      const accountIds = pickedAccounts(form, await accountOptions(c, ws));
      if (!accountIds.length) {
        setFlash(c, 'bad', 'profiles.flash.pickOne');
        return undefined;
      }
      await s.personas.update(ws, c.req.param('id')!, {
        name: input.name,
        description: input.note || null,
        accountIds,
        maxAccess: input.maxAccess,
      });
      setFlash(c, 'ok', 'profiles.flash.saved');
      return undefined;
    })(c),
  );

  app.post(
    '/app/profiles/:id/delete',
    appAction('/app/profiles', async (c, auth) => {
      await c.get('services').personas.delete(auth.workspace.id, c.req.param('id')!);
      setFlash(c, 'ok', 'profiles.flash.deleted');
      return undefined;
    }),
  );

  return app;
}
