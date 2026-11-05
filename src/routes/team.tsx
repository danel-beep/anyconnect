import { Hono } from 'hono';
import { z } from 'zod';
import { getPlan } from '../billing/plans.js';
import type { Principal } from '../core/principal.js';
import { MAX_OWNED_TEAMS } from '../core/teams.js';
import type { MemberRole, ShareLevel } from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { isTeamAdmin, SHARE_LEVELS } from '../security/members.js';
import { csrfToken } from '../web/http.js';
import { InvitePage, TeamPage, type TeamPageView, TeamsPage } from '../web/team.js';
import {
  type AppContext,
  type AppEnv,
  bodyParams,
  currentSession,
  loginUrl,
  secondFactorRedirect,
} from './context.js';
import {
  type AppAuth,
  appAction,
  appPage,
  csrfFailedPage,
  csrfOk,
  pageCtx,
  setFlash,
  shellInfo,
  takeFlash,
} from './page-helpers.js';

/**
 * The team pages of the dashboard (`/app/teams`, `/app/team/:slug/...`) and the invitation link
 * (`/invite/:token`). Every rule (who may invite, share, remove) lives in `TeamService`; these
 * routes only read forms and render. The same things can be done from the chat (`hub/team-tools.ts`).
 */
export function teamRoutes() {
  const app = new Hono<AppEnv>();
  const page = appPage;
  const action = appAction;

  /** The team of the URL with the user's role in it; not found when they are not a member. */
  const teamOf = async (c: AppContext, auth: AppAuth) => {
    const s = c.get('services');
    const team = await s.teams.bySlug(c.req.param('slug') ?? '');
    if (!team?.slug) throw notFound('Team');
    const { role } = await s.teams.forMember(team.id, auth.user.id);
    return { team: { ...team, slug: team.slug }, role };
  };
  const backToTeam = (_form: Record<string, string>, c: AppContext) =>
    `/app/team/${encodeURIComponent(c.req.param('slug') ?? '')}`;

  // --- The list ------------------------------------------------------------------

  app.get(
    '/app/teams',
    page('/app/teams', async (c, auth) => {
      const s = c.get('services');
      const [teams, shell] = await Promise.all([
        s.teams.teamsOf(auth.user.id),
        shellInfo(c, auth.workspace.id),
      ]);
      return c.html(
        <TeamsPage
          ctx={pageCtx(c, auth.user)}
          shell={shell}
          view={{
            teams: teams.map((x) => ({
              name: x.team.name,
              slug: x.team.slug ?? '',
              role: x.role,
              members: x.members,
            })),
            owned: teams.filter((x) => x.role === 'owner').length,
            maxOwned: MAX_OWNED_TEAMS,
            flash: takeFlash(c),
          }}
        />,
      );
    }),
  );

  app.post(
    '/app/teams',
    action('/app/teams', async (c, auth, form) => {
      const team = await c.get('services').teams.create(auth.user, form.name ?? '');
      setFlash(c, 'ok', 'team.flash.created', { name: team.name });
      return c.redirect(`/app/team/${team.slug}`, 303);
    }),
  );

  /** The "connect an account" form of a team page: on to the usual connect page, into this team. */
  app.get(
    '/app/team/connect',
    page('/app/teams', async (c) => {
      const q = z
        .object({
          team: z.string().max(60),
          service: z.string().min(1).max(100),
          owner: z.literal('team').optional(),
        })
        .safeParse(c.req.query());
      if (!q.success) return c.redirect('/app/teams', 302);
      const url = new URL(`/connect/${encodeURIComponent(q.data.service)}`, 'http://hub');
      url.searchParams.set('team', q.data.team);
      if (q.data.owner) url.searchParams.set('owner', 'team');
      url.searchParams.set('returnTo', `/app/team/${q.data.team}`);
      return c.redirect(url.pathname + url.search, 302);
    }),
  );

  // --- One team ------------------------------------------------------------------

  const renderTeam = async (
    c: AppContext,
    auth: AppAuth,
    extra: Pick<TeamPageView, 'newInvite' | 'newKey'> = {},
  ) => {
    const s = c.get('services');
    const t = c.get('t');
    const { team, role } = await teamOf(c, auth);
    const admin = isTeamAdmin(role);
    const principal: Principal = { kind: 'session', userId: auth.user.id, workspaceId: team.id, scopes: [] };
    const [view, members, invitations, accounts, shares, summary, tokens, services, shell] =
      await Promise.all([
        s.teams.view(principal),
        s.teams.members(team.id),
        s.teams.invitations(team.id),
        s.accounts.list(team.id),
        s.teams.shares(team.id),
        s.entitlements.summary(team.id),
        admin ? s.apiTokens.list(team.id) : Promise.resolve([]),
        s.admin.services(team.id),
        shellInfo(c, auth.workspace.id),
      ]);
    if (!view) throw notFound('Team');
    const names = new Map(members.map((m) => [m.userId, m.name]));
    const serviceName = new Map(services.map((x) => [x.service, x.name]));
    const base = (a: (typeof accounts)[number]) => ({
      id: a.id,
      label: a.label,
      name: a.name,
      service: serviceName.get(a.connectorId) ?? a.connectorId,
      status: a.status,
    });
    const seats = summary.limits.seats;
    const holders = new Set(
      [...members]
        .sort((x, y) => Number(y.role === 'owner') - Number(x.role === 'owner') || +x.joinedAt - +y.joinedAt)
        .slice(0, seats ?? members.length)
        .map((m) => m.userId),
    );
    const teamPlan = getPlan('team');
    const live = s.billing.liveSubscription(summary.subscription);
    const focus = z
      .object({
        seats: z.coerce.number().int().min(1).max(10_000).optional(),
        interval: z.enum(['month', 'year']).optional(),
      })
      .safeParse({
        seats: c.req.query('seats') || undefined,
        interval: c.req.query('interval') || undefined,
      });
    const paidFlash =
      c.req.query('paid') === '1' ? { kind: 'ok' as const, text: t('team.flash.paid') } : undefined;
    return c.html(
      <TeamPage
        ctx={pageCtx(c, auth.user)}
        shell={shell}
        view={{
          team: { name: team.name, slug: team.slug, url: s.teams.teamUrl(team.slug) },
          me: { userId: auth.user.id, role },
          members: members.map((m) => ({
            userId: m.userId,
            name: m.name,
            email: m.email,
            role: m.role,
            joinedAt: m.joinedAt,
            holdsSeat: holders.has(m.userId),
          })),
          invitations: admin
            ? invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt }))
            : [],
          mine: accounts
            .filter((a) => a.ownerUserId === auth.user.id)
            .map((a) => ({
              ...base(a),
              shares: shares
                .filter((x) => x.accountId === a.id)
                .map((x) => ({
                  userId: x.userId,
                  name: x.userId === null ? t('team.accounts.everyone') : (names.get(x.userId) ?? '—'),
                  access: x.access,
                })),
            })),
          sharedWithMe: accounts.flatMap((a) => {
            const owner = view.access.owners[a.id];
            return owner?.kind === 'member' ? [{ ...base(a), owner: owner.name, access: owner.access }] : [];
          }),
          teamAccounts: accounts
            .filter((a) => a.ownerUserId === null)
            .map((a) => ({
              ...base(a),
              access: (shares.find((x) => x.accountId === a.id && x.userId === null)?.access ??
                'full') as ShareLevel,
              managed: view.access.manages.has(a.id),
            })),
          services: services.filter((x) => x.ready).map((x) => ({ id: x.service, name: x.name })),
          plan: {
            id: summary.plan.id,
            name: t(`plan.${summary.plan.id}.name` as 'plan.free.name'),
            seats,
            taken: members.length + invitations.length,
            actions: { used: summary.used.actions, limit: summary.limits.actions },
            trial:
              summary.phase?.kind === 'trial'
                ? { until: summary.phase.until, seats: summary.phase.limits.seats }
                : undefined,
            live: live
              ? {
                  interval: live.interval,
                  quantity: live.quantity,
                  until: live.currentPeriodEnd,
                  ending: live.cancelAtPeriodEnd,
                }
              : undefined,
            team: {
              month: teamPlan.priceMonthly,
              year: teamPlan.priceYearly,
              actions: teamPlan.limits.actions,
              messengers: teamPlan.limits.messengers,
              min: teamPlan.perSeat?.min ?? 1,
              max: teamPlan.perSeat?.max ?? 1,
            },
            payments: s.billing.canBuy('team', 'month') || s.billing.canBuy('team', 'year'),
            ...(focus.success ? { focus: focus.data } : {}),
          },
          keys: tokens
            .filter((k) => k.shared)
            .map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
          flash: takeFlash(c) ?? paidFlash,
          ...extra,
        }}
      />,
    );
  };

  app.get(
    '/app/team/:slug',
    page('/app/teams', (c, auth) => renderTeam(c, auth)),
  );

  app.post(
    '/app/team/:slug/invite',
    action(backToTeam, async (c, auth, form) => {
      const s = c.get('services');
      const { team } = await teamOf(c, auth);
      const role = form.role === 'admin' ? 'admin' : 'member';
      const { invitation, url } = await s.teams.invite(auth.user.id, team.id, {
        email: form.email ?? '',
        role,
      });
      // The link is shown once, in this response: it is never stored, only its hash.
      return renderTeam(c, auth, { newInvite: { email: invitation.email, url } });
    }),
  );

  app.post(
    '/app/team/:slug/invitations/:id/revoke',
    action(backToTeam, async (c, auth) => {
      const { team } = await teamOf(c, auth);
      await c.get('services').teams.revokeInvitation(auth.user.id, team.id, c.req.param('id')!);
      setFlash(c, 'ok', 'team.flash.invitationRevoked');
      return undefined;
    }),
  );

  app.post(
    '/app/team/:slug/members/:userId/role',
    action(backToTeam, async (c, auth, form) => {
      const { team } = await teamOf(c, auth);
      const role = z.enum(['admin', 'member']).parse(form.role);
      await c.get('services').teams.setRole(auth.user.id, team.id, c.req.param('userId')!, role);
      setFlash(c, 'ok', 'team.flash.role');
      return undefined;
    }),
  );

  app.post(
    '/app/team/:slug/members/:userId/remove',
    action(backToTeam, async (c, auth) => {
      const s = c.get('services');
      const { team } = await teamOf(c, auth);
      const userId = c.req.param('userId')!;
      const name = (await s.teams.members(team.id)).find((m) => m.userId === userId)?.name ?? '';
      await s.teams.removeMember(auth.user.id, team.id, userId);
      setFlash(c, 'ok', 'team.flash.removed', { name });
      return undefined;
    }),
  );

  app.post(
    '/app/team/:slug/share',
    action(backToTeam, async (c, auth, form) => {
      const s = c.get('services');
      const { team } = await teamOf(c, auth);
      const input = z
        .object({
          account: z.string().min(1).max(64),
          with: z.string().min(1).max(64),
          access: z.enum([...SHARE_LEVELS, 'none']),
        })
        .parse({ account: form.account, with: form.with, access: form.access });
      await s.teams.share(
        auth.user.id,
        team.id,
        input.account,
        input.with === 'team' ? null : input.with,
        input.access === 'none' ? null : input.access,
      );
      setFlash(c, 'ok', 'team.flash.shared');
      return undefined;
    }),
  );

  app.post(
    '/app/team/:slug/accounts/:id/remove',
    action(backToTeam, async (c, auth) => {
      const s = c.get('services');
      const { team } = await teamOf(c, auth);
      const account = await s.accounts.get(team.id, c.req.param('id')!);
      await s.teams.assertCanManage(team.id, auth.user.id, account);
      await s.accounts.delete(team.id, account.id);
      setFlash(c, 'ok', 'team.flash.accountRemoved');
      return undefined;
    }),
  );

  app.post(
    '/app/team/:slug/keys',
    action(backToTeam, async (c, auth, form) => {
      const s = c.get('services');
      const { team, role } = await teamOf(c, auth);
      if (!isTeamAdmin(role))
        throw new AppError(403, 'team_admin_only', 'Only team admins create shared keys');
      const name = z.string().trim().min(1).max(80).parse(form.name);
      const client = await s.aiClients.createUnique(team.id, name, 'api_token');
      // MCP only: the management API sees a whole workspace, which nobody in a team does.
      const { token } = await s.apiTokens.create({
        workspaceId: team.id,
        userId: auth.user.id,
        name,
        scopes: ['mcp'],
        aiClientId: client.id,
        shared: true,
      });
      return renderTeam(c, auth, { newKey: token });
    }),
  );

  app.post(
    '/app/team/:slug/keys/:id/revoke',
    action(backToTeam, async (c, auth) => {
      const s = c.get('services');
      const { team, role } = await teamOf(c, auth);
      if (!isTeamAdmin(role))
        throw new AppError(403, 'team_admin_only', 'Only team admins revoke shared keys');
      const key = (await s.apiTokens.list(team.id)).find((k) => k.id === c.req.param('id') && k.shared);
      if (!key) throw notFound('Key');
      await s.apiTokens.revoke(team.id, key.id);
      setFlash(c, 'ok', 'team.flash.keyRevoked');
      return undefined;
    }),
  );

  app.post(
    '/app/team/:slug/plan',
    action(backToTeam, async (c, auth, form) => {
      const s = c.get('services');
      const { team, role } = await teamOf(c, auth);
      if (!isTeamAdmin(role)) throw new AppError(403, 'team_admin_only', 'Only team admins manage the plan');
      const input = z
        .object({ seats: z.coerce.number().int().min(1).max(10_000), interval: z.enum(['month', 'year']) })
        .parse({ seats: form.seats, interval: form.interval || 'month' });
      const back = new URL(`/app/team/${team.slug}`, s.config.publicUrl).toString();
      const outcome = await s.billing.checkout({
        workspaceId: team.id,
        userId: auth.user.id,
        email: auth.user.email,
        planId: 'team',
        interval: input.interval,
        seats: input.seats,
        successUrl: `${back}?paid=1#plan`,
        cancelUrl: `${back}#plan`,
      });
      if (outcome.kind === 'redirect') return c.redirect(outcome.url, 303);
      setFlash(c, 'ok', 'team.flash.planChanged', { plan: c.get('t')('plan.team.name') });
      return undefined;
    }),
  );

  app.post(
    '/app/team/:slug/leave',
    action(backToTeam, async (c, auth) => {
      const { team } = await teamOf(c, auth);
      await c.get('services').teams.leave(auth.user.id, team.id);
      setFlash(c, 'ok', 'team.flash.left');
      return c.redirect('/app/teams', 303);
    }),
  );

  app.post(
    '/app/team/:slug/delete',
    action(backToTeam, async (c, auth) => {
      const { team } = await teamOf(c, auth);
      await c.get('services').teams.deleteTeam(auth.user.id, team.id);
      setFlash(c, 'ok', 'team.flash.deleted');
      return c.redirect('/app/teams', 303);
    }),
  );

  // --- Invitations -----------------------------------------------------------------

  const invitePage = async (c: AppContext, status: 200 | 403 | 404 = 200) => {
    const s = c.get('services');
    const token = c.req.param('token') ?? '';
    const found = await s.teams.invitation(token);
    const session = await currentSession(c);
    return c.html(
      <InvitePage
        t={c.get('t')}
        lang={c.get('locale')}
        view={
          found
            ? {
                token,
                team: found.team.name,
                inviter: found.invitedBy,
                role: found.invitation.role as MemberRole,
                email: found.invitation.email,
                me: session?.user.email,
                csrf: csrfToken(c, { secure: s.config.secureCookies }),
              }
            : undefined
        }
      />,
      found ? status : 404,
    );
  };

  app.get('/invite/:token', (c) => invitePage(c));

  app.post('/invite/:token', async (c) => {
    const s = c.get('services');
    const token = c.req.param('token');
    const next = `/invite/${encodeURIComponent(token)}`;
    const form = await bodyParams(c);
    if (!csrfOk(c, form)) return csrfFailedPage(c);
    const session = await currentSession(c);
    if (!session) return c.redirect(loginUrl(next), 303);
    const gate = await secondFactorRedirect(c, session, next);
    if (gate) return c.redirect(gate, 303);
    try {
      const team = await s.teams.accept(token, session.user);
      s.logger.info({ teamId: team.id, userId: session.user.id }, 'team invitation accepted');
      setFlash(c, 'ok', 'team.flash.joined', { name: team.name });
      return c.redirect(`/app/team/${team.slug}`, 303);
    } catch (error) {
      // The page says why (another address signed in, a used or expired link).
      if (error instanceof AppError && error.status < 500)
        return invitePage(c, error.status === 403 ? 403 : 404);
      throw error;
    }
  });

  return app;
}
