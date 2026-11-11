import type { FC } from 'hono/jsx';
import type { RiskLevel } from '../connectors/sdk.js';
import type { AccessLevel, ConfirmLevel } from '../db/schema.js';
import {
  AccountStatus,
  type AccountView,
  AppShell,
  CallsTable,
  type CallView,
  Flash,
  PageHead,
  type ShellInfo,
} from './app.js';
import type { Key } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { classifyProblem, needsReconnect, ProblemText } from './problems.js';
import { PromptList, RiskBadge } from './setup-guide.js';
import { fmtAgo, fmtDate, Icon } from './ui.js';

/**
 * One connected account: its state, what the AI may do with it (each action on or off), its
 * access and confirmation rule, what to ask, and its own recent calls.
 */
export interface AccountPageView {
  account: AccountView;
  createdAt: Date;
  tools: {
    name: string;
    title: string;
    description: string;
    risk: RiskLevel;
    enabled: boolean;
    /** Under the rule in force for this account: not allowed at all, or waits for the user's OK. */
    blocked: boolean;
    asks: boolean;
  }[];
  /** Calls of this account in the last 30 days, and how many of them failed. */
  usage: { calls: number; errors: number };
  rule: { access: AccessLevel | null; confirm: ConfirmLevel | null };
  defaults: { access: AccessLevel; confirm: ConfirmLevel };
  prompts: string[];
  /** Messengers: how long the hub keeps its copy of the messages (null: while connected). */
  keepMessages?: { days: number | null; choices: readonly number[] } | undefined;
  calls: CallView[];
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
}

const ACCESSES: AccessLevel[] = ['full', 'write', 'read', 'none'];
const CONFIRMS: ConfirmLevel[] = ['never', 'dangerous', 'write', 'always'];

const Hidden: FC<{ values: Record<string, string> }> = ({ values }) => (
  <>
    {Object.entries(values).map(([name, value]) => (
      <input type="hidden" name={name} value={value} />
    ))}
  </>
);

export const AccountPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AccountPageView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  const a = view.account;
  const base = `/app/accounts/${encodeURIComponent(a.id)}`;
  const back = { csrf: ctx.csrf, back: base };
  const reconnect = `/connect/${encodeURIComponent(a.connectorId)}?account=${encodeURIComponent(a.id)}&returnTo=${encodeURIComponent(base)}`;
  const on = view.tools.filter((x) => x.enabled).length;
  const broken = a.enabled && a.status !== 'active';
  const reconnectFirst = broken && needsReconnect(classifyProblem(a.statusMessage, a.status));
  return (
    <AppShell ctx={ctx} shell={shell} section="services" title={a.label}>
      <PageHead
        crumbs={
          <>
            <a href="/app/services">{t('app.nav.services')}</a> / {a.service}
          </>
        }
        title={a.label}
        sub={
          <span class="acc-head-sub">
            <AccountStatus t={t} a={a} /> {a.service}
            {a.identity && a.identity !== a.label ? ` · ${a.identity}` : ''}
            {' · '}
            {a.lastUsedAt
              ? t('app.account.lastUsed', { ago: fmtAgo(lang, a.lastUsedAt) })
              : t('app.account.neverUsed')}
            {view.usage.calls
              ? ` · ${t('app.account.calls30', { n: view.usage.calls, errors: view.usage.errors })}`
              : ''}
          </span>
        }
        actions={
          <div class="row">
            <form method="post" action={`${base}/test`} class="inline">
              <Hidden values={back} />
              <button type="submit" class={broken && !reconnectFirst ? 'primary' : undefined}>
                {broken ? t('problem.checkAgain') : t('app.acc.test')}
              </button>
            </form>
            <a class={reconnectFirst ? 'btn primary' : 'btn'} href={reconnect}>
              <Icon name="refresh" /> {t('app.acc.reconnect')}
            </a>
          </div>
        }
      />
      <Flash flash={view.flash} />
      {broken ? (
        <div class="notice bad">
          <strong>
            {t(a.status === 'needs_reauth' ? 'app.account.reauthTitle' : 'app.account.errorTitle')}
          </strong>{' '}
          <ProblemText t={t} message={a.statusMessage} status={a.status} details />
        </div>
      ) : null}
      {!a.enabled ? <div class="notice">{t('app.account.pausedNote')}</div> : null}
      <div class="account-grid">
        <div class="card flush">
          <div class="card-head pad">
            <div>
              <h2>{t('app.account.tools')}</h2>
              <p class="small muted">{t('app.account.toolsSub', { on, n: view.tools.length })}</p>
            </div>
          </div>
          <form method="post" action={`${base}/tools`}>
            <Hidden values={{ csrf: ctx.csrf }} />
            <ul class="tool-toggles">
              {view.tools.map((tool) => (
                <li>
                  <label class="tool-toggle" for={`tool-${tool.name}`}>
                    <input
                      id={`tool-${tool.name}`}
                      type="checkbox"
                      class="switch"
                      name={`on.${tool.name}`}
                      checked={tool.enabled}
                    />
                    <span class="grow">
                      <span class="tool-title">{tool.title}</span>
                      <span class="small muted">{tool.description}</span>
                    </span>
                    <span class="tool-flags">
                      <RiskBadge t={t} risk={tool.risk} />
                      {tool.blocked ? (
                        <span class="badge" title={t('app.account.blockedHint')}>
                          {t('app.account.blocked')}
                        </span>
                      ) : tool.asks ? (
                        <span class="badge accent" title={t('app.account.asksHint')}>
                          <Icon name="lock" /> {t('app.account.asks')}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div class="pad-x form-foot">
              <button type="submit" class="primary">
                {t('app.account.toolsSave')}
              </button>
              <span class="small muted">{t('app.account.toolsHint')}</span>
            </div>
          </form>
        </div>
        <div class="account-side">
          <div class="card">
            <h2>{t('app.account.rules')}</h2>
            <p class="small muted">{t('app.account.rulesSub')}</p>
            <form method="post" action="/app/rules/scoped">
              <Hidden values={{ ...back, kind: 'account', id: a.id }} />
              <label for="acc-access">{t('app.rules.access')}</label>
              <select id="acc-access" name="access">
                <option value="" selected={view.rule.access === null}>
                  {t('app.rules.inheritAs', { value: t(`app.rules.access.${view.defaults.access}` as Key) })}
                </option>
                {ACCESSES.map((x) => (
                  <option value={x} selected={view.rule.access === x}>
                    {t(`app.rules.access.${x}` as Key)}
                  </option>
                ))}
              </select>
              <label for="acc-confirm">{t('app.rules.confirm')}</label>
              <select id="acc-confirm" name="confirm">
                <option value="" selected={view.rule.confirm === null}>
                  {t('app.rules.inheritAs', {
                    value: t(`app.rules.confirmShort.${view.defaults.confirm}` as Key),
                  })}
                </option>
                {CONFIRMS.map((x) => (
                  <option value={x} selected={view.rule.confirm === x}>
                    {t(`app.rules.confirmShort.${x}` as Key)}
                  </option>
                ))}
              </select>
              <div class="actions start">
                <button type="submit">{t('app.rules.save')}</button>
                <a class="btn ghost" href="/app/rules">
                  {t('app.account.allRules')}
                </a>
              </div>
            </form>
          </div>
          {view.prompts.length ? (
            <div class="card">
              <h2>{t('connect.tryAsking')}</h2>
              <PromptList t={t} prompts={view.prompts.slice(0, 3)} idPrefix="ask" />
              <p class="small muted">{t('app.account.askHint', { label: a.label })}</p>
            </div>
          ) : null}
          <div class="card">
            <h2>{t('app.account.details')}</h2>
            <form method="post" action={`${base}/rename`} class="copy">
              <Hidden values={back} />
              <label class="sr-only" for="acc-label">
                {t('app.acc.label')}
              </label>
              <input id="acc-label" type="text" name="label" value={a.label} maxlength={100} required />
              <button type="submit">{t('app.acc.rename')}</button>
            </form>
            <table class="kv small">
              <tbody>
                <tr>
                  <th>{t('app.account.aiName')}</th>
                  <td>
                    <code>{`${a.connectorId}:${a.name}`}</code>
                  </td>
                </tr>
                <tr>
                  <th>{t('app.account.added')}</th>
                  <td>{fmtDate(lang, view.createdAt)}</td>
                </tr>
              </tbody>
            </table>
            {view.keepMessages ? (
              <form method="post" action={`${base}/retention`}>
                <Hidden values={back} />
                <label for="acc-keep">{t('app.account.keep.label')}</label>
                <select id="acc-keep" name="days">
                  {view.keepMessages.choices.map((days) => (
                    <option value={String(days)} selected={view.keepMessages?.days === days}>
                      {t('app.account.keep.days', { n: days })}
                    </option>
                  ))}
                  <option value="" selected={view.keepMessages.days === null}>
                    {t('app.account.keep.forever')}
                  </option>
                </select>
                <p class="small muted">{t('app.account.keep.hint')}</p>
                <div class="actions start">
                  <button type="submit" class="sm">
                    {t('app.account.keep.save')}
                  </button>
                </div>
              </form>
            ) : null}
            <div class="actions start">
              <form method="post" action={`${base}/toggle`} class="inline">
                <Hidden values={back} />
                <button type="submit" class="sm">
                  <Icon name={a.enabled ? 'pause' : 'play'} />{' '}
                  {a.enabled ? t('app.acc.disable') : t('app.acc.enable')}
                </button>
              </form>
              <form
                method="post"
                action={`${base}/delete`}
                class="inline"
                data-confirm={t('app.acc.deleteConfirm', { label: a.label })}
              >
                <Hidden values={{ csrf: ctx.csrf }} />
                <button type="submit" class="sm danger">
                  <Icon name="trash" /> {t('app.acc.delete')}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
      <div class="card flush" id="log">
        <div class="card-head pad">
          <h2>{t('app.account.calls')}</h2>
          <a class="small" href={`/app/activity?account=${encodeURIComponent(a.id)}`}>
            {t('app.account.allCalls')}
          </a>
        </div>
        <CallsTable ctx={ctx} calls={view.calls} empty={t('app.account.noCalls')} withClient oneAccount />
      </div>
    </AppShell>
  );
};
