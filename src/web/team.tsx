import type { FC } from 'hono/jsx';
import type { MemberRole, ShareLevel } from '../db/schema.js';
import { AppShell, Flash, PageHead, type ShellInfo } from './app.js';
import type { Translate } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { Layout } from './pages.js';
import { CodeBlock, CopyField, fmtAgo, fmtDate, fmtNumber, Meter, Tabs } from './ui.js';

/**
 * The team pages: the list of the user's teams (`/app/teams`), one team (`/app/team/:slug`) and the
 * invitation a person accepts (`/invite/:token`). Views are plain data; `routes/team.tsx` fills them.
 */

const SHARE_LEVELS: ShareLevel[] = ['read', 'write', 'full'];
const roleText = (t: Translate, role: MemberRole) => t(`team.role.${role}`);

export interface TeamsView {
  teams: { name: string; slug: string; role: MemberRole; members: number }[];
  /** How many teams the user owns, and the most they may. */
  owned: number;
  maxOwned: number;
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
}

export const TeamsPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: TeamsView }> = ({ ctx, shell, view }) => {
  const { t } = ctx;
  return (
    <AppShell ctx={ctx} shell={shell} section="teams" title={t('app.nav.teams')}>
      <PageHead title={t('app.nav.teams')} sub={t('team.list.sub')} />
      <Flash flash={view.flash} />
      <div class="card flush">
        {view.teams.length === 0 ? (
          <p class="muted pad">{t('team.list.none')}</p>
        ) : (
          <ul class="plain pad-x">
            {view.teams.map((team) => (
              <li>
                <span class="grow">
                  <a href={`/app/team/${team.slug}`}>
                    <strong>{team.name}</strong>
                  </a>
                  <div class="small muted">
                    {roleText(t, team.role)} · {t('team.list.members', { n: team.members })}
                  </div>
                </span>
                <a class="btn sm" href={`/app/team/${team.slug}`}>
                  →
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div class="card">
        <h2>{t('team.list.create')}</h2>
        {view.owned >= view.maxOwned ? (
          <p class="muted">{t('team.list.limit', { n: view.maxOwned })}</p>
        ) : (
          <form method="post" action="/app/teams" class="inline-form">
            <input type="hidden" name="csrf" value={ctx.csrf} />
            <div class="wide-2">
              <label for="team-name">{t('team.list.name')}</label>
              <input
                id="team-name"
                type="text"
                name="name"
                required
                maxlength={60}
                placeholder={t('team.list.namePlaceholder')}
              />
            </div>
            <div>
              <button type="submit" class="primary block">
                {t('team.list.create')}
              </button>
            </div>
          </form>
        )}
        <p class="hint">{t('team.list.createHint')}</p>
      </div>
    </AppShell>
  );
};

export interface TeamAccountView {
  id: string;
  label: string;
  name: string;
  service: string;
  status: string;
}

export interface TeamPageView {
  team: { name: string; slug: string; url: string };
  me: { userId: string; role: MemberRole };
  members: {
    userId: string;
    name: string;
    email: string;
    role: MemberRole;
    joinedAt: Date;
    /** False when the team has more members than seats and this one is beyond them. */
    holdsSeat: boolean;
  }[];
  invitations: { id: string; email: string; role: MemberRole; expiresAt: Date }[];
  /** An invitation just created: its link is shown once. */
  newInvite?: { email: string; url: string } | undefined;
  mine: (TeamAccountView & { shares: { userId: string | null; name: string; access: ShareLevel }[] })[];
  sharedWithMe: (TeamAccountView & { owner: string; access: ShareLevel })[];
  teamAccounts: (TeamAccountView & { access: ShareLevel; managed: boolean })[];
  services: { id: string; name: string }[];
  plan: {
    id: string;
    name: string;
    seats: number | null;
    taken: number;
    actions: { used: number; limit: number | null };
    trial?: { until: Date; seats: number | null } | undefined;
    live?: { interval: 'month' | 'year' | null; quantity: number; until: Date | null; ending: boolean } | undefined;
    team: { month: number; year: number; actions: number | null; messengers: number | null; min: number; max: number };
    payments: boolean;
  };
  keys: { id: string; name: string; createdAt: Date; lastUsedAt: Date | null }[];
  /** A shared key just created: shown once. */
  newKey?: string | undefined;
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
}

const usd = (n: number) => `$${n}`;

export const TeamPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: TeamPageView }> = ({ ctx, shell, view }) => {
  const { t, lang } = ctx;
  const base = `/app/team/${view.team.slug}`;
  const admin = view.me.role === 'owner' || view.me.role === 'admin';
  const owner = view.me.role === 'owner';
  const others = view.members.filter((m) => m.userId !== view.me.userId);
  const csrf = <input type="hidden" name="csrf" value={ctx.csrf} />;
  const connectForm = (forTeam: boolean) => (
    <form method="get" action="/app/team/connect" class="inline-form">
      <input type="hidden" name="team" value={view.team.slug} />
      {forTeam ? <input type="hidden" name="owner" value="team" /> : null}
      <div class="wide-2">
        <label for={forTeam ? 'connect-team' : 'connect-mine'}>{t('team.accounts.service')}</label>
        <select id={forTeam ? 'connect-team' : 'connect-mine'} name="service" required>
          {view.services.map((s) => (
            <option value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
      <div>
        <button type="submit" class="block">
          {forTeam ? t('team.accounts.connectTeam') : t('team.accounts.connect')}
        </button>
      </div>
    </form>
  );
  const levelSelect = (id: string, selected?: ShareLevel) => (
    <select id={id} name="access">
      {SHARE_LEVELS.map((level) => (
        <option value={level} selected={level === selected}>
          {t(`team.level.${level}`)}
        </option>
      ))}
    </select>
  );
  return (
    <AppShell ctx={ctx} shell={shell} section="teams" title={view.team.name}>
      <PageHead
        title={view.team.name}
        sub={`${roleText(t, view.me.role)} · ${t('team.list.members', { n: view.members.length })}`}
        crumbs={<a href="/app/teams">{t('app.nav.teams')}</a>}
      />
      <Flash flash={view.flash} />

      <div class="card" id="connector">
        <h2>{t('team.connector.title')}</h2>
        <CopyField t={t} id="team-url" value={view.team.url} label={t('team.connector.title')} />
        <p class="hint">{t('team.connector.hint')}</p>
        <Tabs
          id="team-clients"
          remember="client"
          tabs={[
            { id: 'chatgpt', label: 'ChatGPT', panel: <p>{t('team.guide.chatgpt')}</p> },
            { id: 'claude', label: 'Claude', panel: <p>{t('team.guide.claude')}</p> },
            {
              id: 'claude-code',
              label: 'Claude Code',
              panel: (
                <div class="stack">
                  <p>{t('team.guide.code')}</p>
                  <CodeBlock
                    t={t}
                    id="team-code"
                    code={`claude mcp add --transport http manyplug-${view.team.slug} ${view.team.url}`}
                  />
                </div>
              ),
            },
            { id: 'other', label: '…', panel: <p>{t('team.guide.other')}</p> },
          ]}
        />
      </div>

      <div class="card" id="accounts">
        <h2>{t('team.accounts.mine')}</h2>
        <p class="muted">{t('team.accounts.mineHint')}</p>
        {view.mine.length === 0 ? <p class="muted">{t('team.accounts.none')}</p> : null}
        <ul class="plain">
          {view.mine.map((a) => (
            <li class="stack">
              <div class="row">
                <span class="grow">
                  <strong>{a.label}</strong> <span class="muted small">{a.service}</span>{' '}
                  <code class="small">{a.name}</code>
                  <div class="small muted">
                    {t('team.accounts.sharedWith')}:{' '}
                    {a.shares.length
                      ? a.shares.map((s) => `${s.name} (${t(`team.level.${s.access}`)})`).join(', ')
                      : t('team.accounts.notShared')}
                  </div>
                </span>
                <form
                  method="post"
                  action={`${base}/accounts/${a.id}/remove`}
                  data-confirm={t('team.accounts.removeConfirm', { name: a.label })}
                >
                  {csrf}
                  <button class="sm danger" type="submit">
                    {t('team.accounts.remove')}
                  </button>
                </form>
              </div>
              {others.length ? (
                <form method="post" action={`${base}/share`} class="inline-form">
                  {csrf}
                  <input type="hidden" name="account" value={a.id} />
                  <div>
                    <label for={`share-with-${a.id}`}>{t('team.accounts.with')}</label>
                    <select id={`share-with-${a.id}`} name="with">
                      <option value="team">{t('team.accounts.everyone')}</option>
                      {others.map((m) => (
                        <option value={m.userId}>{m.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label for={`share-level-${a.id}`}>{t('team.accounts.level')}</label>
                    {levelSelect(`share-level-${a.id}`)}
                  </div>
                  <div class="row">
                    <button type="submit" class="sm">
                      {t('team.accounts.share')}
                    </button>
                    <button type="submit" class="sm" name="access" value="none">
                      {t('team.accounts.stop')}
                    </button>
                  </div>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {view.services.length ? connectForm(false) : null}
      </div>

      {view.sharedWithMe.length ? (
        <div class="card">
          <h2>{t('team.accounts.shared')}</h2>
          <ul class="plain">
            {view.sharedWithMe.map((a) => (
              <li>
                <span class="grow">
                  <strong>{a.label}</strong> <span class="muted small">{a.service}</span>
                  <div class="small muted">
                    {t('team.accounts.sharedBy', { name: a.owner })} · {t(`team.level.${a.access}`)}
                  </div>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.teamAccounts.length || admin ? (
        <div class="card">
          <h2>{t('team.accounts.team')}</h2>
          <p class="muted">{t('team.accounts.teamHint')}</p>
          <ul class="plain">
            {view.teamAccounts.map((a) => (
              <li class="stack">
                <div class="row">
                  <span class="grow">
                    <strong>{a.label}</strong> <span class="muted small">{a.service}</span>{' '}
                    <code class="small">{a.name}</code>
                    <div class="small muted">{t(`team.level.${a.access}`)}</div>
                  </span>
                  {a.managed ? (
                    <form
                      method="post"
                      action={`${base}/accounts/${a.id}/remove`}
                      data-confirm={t('team.accounts.removeConfirm', { name: a.label })}
                    >
                      {csrf}
                      <button class="sm danger" type="submit">
                        {t('team.accounts.remove')}
                      </button>
                    </form>
                  ) : null}
                </div>
                {a.managed ? (
                  <form method="post" action={`${base}/share`} class="inline-form">
                    {csrf}
                    <input type="hidden" name="account" value={a.id} />
                    <input type="hidden" name="with" value="team" />
                    <div class="wide-2">
                      <label for={`team-level-${a.id}`}>{t('team.accounts.level')}</label>
                      {levelSelect(`team-level-${a.id}`, a.access)}
                    </div>
                    <div>
                      <button type="submit" class="sm">
                        {t('team.accounts.share')}
                      </button>
                    </div>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          {admin && view.services.length ? connectForm(true) : null}
        </div>
      ) : null}

      <div class="card" id="people">
        <h2>{t('team.members.title')}</h2>
        <ul class="plain">
          {view.members.map((m) => (
            <li>
              <span class="grow">
                <strong>{m.name}</strong>
                {m.userId === view.me.userId ? <span class="badge">{t('team.you')}</span> : null}{' '}
                <span class="badge">{roleText(t, m.role)}</span>
                <div class="small muted">
                  {m.email} · {t('team.members.joined', { date: fmtDate(lang, m.joinedAt) })}
                  {m.holdsSeat ? '' : ` · ${t('team.members.noSeat')}`}
                </div>
              </span>
              {owner && m.role !== 'owner' ? (
                <form method="post" action={`${base}/members/${m.userId}/role`}>
                  {csrf}
                  <input type="hidden" name="role" value={m.role === 'admin' ? 'member' : 'admin'} />
                  <button class="sm" type="submit">
                    {m.role === 'admin' ? t('team.members.makeMember') : t('team.members.makeAdmin')}
                  </button>
                </form>
              ) : null}
              {admin && m.role !== 'owner' && m.userId !== view.me.userId && (owner || m.role === 'member') ? (
                <form
                  method="post"
                  action={`${base}/members/${m.userId}/remove`}
                  data-confirm={t('team.members.removeConfirm', { name: m.name })}
                >
                  {csrf}
                  <button class="sm danger" type="submit">
                    {t('team.members.remove')}
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {admin ? (
          <>
            {view.invitations.length ? (
              <>
                <h3>{t('team.invite.open')}</h3>
                <ul class="plain">
                  {view.invitations.map((i) => (
                    <li>
                      <span class="grow">
                        <strong>{i.email}</strong> <span class="badge">{roleText(t, i.role)}</span>
                        <div class="small muted">
                          {t('team.invite.expires', { date: fmtDate(lang, i.expiresAt) })}
                        </div>
                      </span>
                      <form method="post" action={`${base}/invitations/${i.id}/revoke`}>
                        {csrf}
                        <button class="sm" type="submit">
                          {t('team.invite.revoke')}
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <h3>{t('team.invite.title')}</h3>
            {view.newInvite ? (
              <div class="notice ok" data-replace-url={base}>
                <p>{t('team.invite.created', { email: view.newInvite.email })}</p>
                <CopyField t={t} id="invite-url" value={view.newInvite.url} label={t('team.invite.title')} />
              </div>
            ) : null}
            <form method="post" action={`${base}/invite`} class="inline-form">
              {csrf}
              <div class="wide-2">
                <label for="invite-email">{t('team.invite.email')}</label>
                <input id="invite-email" type="email" name="email" required maxlength={254} />
              </div>
              <div>
                <label for="invite-role">{t('team.invite.role')}</label>
                <select id="invite-role" name="role">
                  <option value="member" selected>
                    {t('team.role.member')}
                  </option>
                  <option value="admin">{t('team.role.admin')}</option>
                </select>
              </div>
              <div>
                <button type="submit" class="primary block">
                  {t('team.invite.send')}
                </button>
              </div>
            </form>
            <p class="hint">{t('team.invite.hint')}</p>
          </>
        ) : null}
      </div>

      <TeamPlanCard ctx={ctx} view={view} admin={admin} />

      {admin ? (
        <div class="card" id="keys">
          <h2>{t('team.keys.title')}</h2>
          <p class="muted">{t('team.keys.hint')}</p>
          {view.newKey ? (
            <div class="notice ok" data-replace-url={base}>
              <p>
                <strong>{t('team.keys.created')}</strong>
              </p>
              <CopyField t={t} id="team-key" value={view.newKey} label={t('team.keys.title')} />
            </div>
          ) : null}
          {view.keys.length ? (
            <ul class="plain">
              {view.keys.map((k) => (
                <li>
                  <span class="grow">
                    <strong>{k.name}</strong>
                    <div class="small muted">
                      {t('app.apps.since', { date: fmtDate(lang, k.createdAt) })} ·{' '}
                      {k.lastUsedAt ? t('app.apps.used', { ago: fmtAgo(lang, k.lastUsedAt) }) : t('home.never')}
                    </div>
                  </span>
                  <form
                    method="post"
                    action={`${base}/keys/${k.id}/revoke`}
                    data-confirm={t('team.keys.revokeConfirm', { name: k.name })}
                  >
                    {csrf}
                    <button class="sm danger" type="submit">
                      {t('team.keys.revoke')}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          ) : null}
          <form method="post" action={`${base}/keys`} class="inline-form">
            {csrf}
            <div class="wide-2">
              <label for="key-name">{t('team.keys.name')}</label>
              <input id="key-name" type="text" name="name" required maxlength={80} />
            </div>
            <div>
              <button type="submit" class="block">
                {t('team.keys.create')}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <div class="card">
        <h2>{t('team.danger.title')}</h2>
        {owner ? (
          <form method="post" action={`${base}/delete`} data-confirm={t('team.danger.deleteConfirm')}>
            {csrf}
            <p class="muted">{t('team.danger.deleteHint')}</p>
            <button class="danger" type="submit">
              {t('team.danger.delete')}
            </button>
          </form>
        ) : (
          <form method="post" action={`${base}/leave`} data-confirm={t('team.danger.leaveConfirm')}>
            {csrf}
            <p class="muted">{t('team.danger.leaveHint')}</p>
            <button class="danger" type="submit">
              {t('team.danger.leave')}
            </button>
          </form>
        )}
      </div>
    </AppShell>
  );
};

const TeamPlanCard: FC<{ ctx: PageCtx; view: TeamPageView; admin: boolean }> = ({ ctx, view, admin }) => {
  const { t, lang } = ctx;
  const { plan } = view;
  const base = `/app/team/${view.team.slug}`;
  const suggested = Math.min(plan.team.max, Math.max(plan.team.min, view.members.length, plan.live?.quantity ?? 0));
  return (
    <div class="card" id="plan">
      <h2>{t('team.plan.title')}</h2>
      <p>
        <strong>{t('team.plan.current', { plan: plan.name })}</strong>
        {plan.live?.until
          ? ` · ${t(plan.live.ending ? 'team.plan.ends' : 'team.plan.renews', { date: fmtDate(lang, plan.live.until) })}`
          : ''}
      </p>
      {plan.trial ? (
        <p class="muted">
          {t('team.plan.trial', { date: fmtDate(lang, plan.trial.until), seats: plan.trial.seats ?? '∞' })}{' '}
          {t('team.plan.free')}
        </p>
      ) : plan.id === 'free' ? (
        <p class="muted">{t('team.plan.free')}</p>
      ) : null}
      <p class="small">
        {plan.seats === null
          ? t('team.plan.seatsUnlimited', { used: plan.taken })
          : t('team.plan.seatsUsed', { used: plan.taken, limit: plan.seats })}
      </p>
      <Meter used={plan.taken} limit={plan.seats} label={t('team.plan.seats')} />
      <p class="small">
        {t('team.plan.actions')}: {fmtNumber(lang, plan.actions.used)}
        {plan.actions.limit === null ? '' : ` / ${fmtNumber(lang, plan.actions.limit)}`}
      </p>
      <Meter used={plan.actions.used} limit={plan.actions.limit} label={t('team.plan.actions')} />
      <p class="muted">
        {t('team.plan.team', { month: usd(plan.team.month), year: usd(plan.team.year) })}{' '}
        {t('team.plan.teamLimits', {
          actions: plan.team.actions === null ? '∞' : fmtNumber(lang, plan.team.actions),
          messengers: plan.team.messengers ?? '∞',
        })}
      </p>
      {!admin ? (
        <p class="hint">{t('team.plan.ownerOnly')}</p>
      ) : plan.payments ? (
        <form method="post" action={`${base}/plan`} class="inline-form">
          <input type="hidden" name="csrf" value={ctx.csrf} />
          <div>
            <label for="plan-seats">{t('team.plan.seats')}</label>
            <input
              id="plan-seats"
              type="number"
              name="seats"
              min={Math.max(plan.team.min, view.members.length)}
              max={plan.team.max}
              value={String(suggested)}
              required
            />
          </div>
          <div>
            <label for="plan-interval">{t('team.plan.interval')}</label>
            <select id="plan-interval" name="interval">
              <option value="month" selected={plan.live?.interval !== 'year'}>
                {t('team.plan.month')}
              </option>
              <option value="year" selected={plan.live?.interval === 'year'}>
                {t('team.plan.year')}
              </option>
            </select>
          </div>
          <div>
            <button type="submit" class="primary block">
              {plan.live ? t('team.plan.change') : t('team.plan.buy')}
            </button>
          </div>
        </form>
      ) : (
        <p class="hint">
          {ctx.supportEmail
            ? t('team.plan.paymentsOff', { email: ctx.supportEmail })
            : t('team.plan.paymentsOffNoEmail')}
        </p>
      )}
    </div>
  );
};

export interface InviteView {
  token: string;
  team: string;
  inviter: string | null;
  role: MemberRole;
  email: string;
  /** The signed-in user's email, when someone is signed in. */
  me?: string | undefined;
  csrf: string;
}

/** The page an invitation link opens: what joining means, then join (or sign in first). */
export const InvitePage: FC<{ t: Translate; lang: string; view?: InviteView | undefined }> = ({
  t,
  lang,
  view,
}) => (
  <Layout title={view ? t('invite.title', { team: view.team }) : t('invite.invalid')} narrow lang={lang}>
    <div class="card">
      {!view ? (
        <p>{t('invite.invalid')}</p>
      ) : (
        <>
          <h1>{t('invite.title', { team: view.team })}</h1>
          <p>
            {view.inviter
              ? t('invite.sub', { inviter: view.inviter, team: view.team, role: roleText(t, view.role) })
              : t('invite.subNoInviter', { team: view.team, role: roleText(t, view.role) })}
          </p>
          <h2>{t('invite.what')}</h2>
          <ul class="bullets">
            <li>{t('invite.point1')}</li>
            <li>{t('invite.point2')}</li>
            <li>{t('invite.point3')}</li>
            <li>{t('invite.point4')}</li>
          </ul>
          {!view.me ? (
            <a class="btn primary" href={`/login?next=${encodeURIComponent(`/invite/${view.token}`)}`}>
              {t('invite.signIn')}
            </a>
          ) : view.me.toLowerCase() !== view.email ? (
            <div class="warning">{t('invite.wrongEmail', { email: view.email, me: view.me })}</div>
          ) : (
            <form method="post" action={`/invite/${encodeURIComponent(view.token)}`}>
              <input type="hidden" name="csrf" value={view.csrf} />
              <button class="primary" type="submit">
                {t('invite.accept')}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  </Layout>
);
