import type { FC } from 'hono/jsx';
import type { AccessLevel, ConfirmLevel } from '../db/schema.js';
import { AppShell, Flash, PageHead, type ShellInfo } from './app.js';
import { serviceMeta } from './catalog.js';
import type { Key } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { Hidden, ServiceLogo } from './ui.js';

/**
 * "Rules" in the dashboard: when the AI must ask before acting, and per AI app / per account
 * limits. The full rule model (persona × app × service × account) stays available in the API; this
 * page edits the common cases: the workspace defaults and one rule per app or per account.
 */

export interface ScopedRuleView {
  id: string;
  name: string;
  detail?: string | undefined;
  /** Accounts: their service (logo and grouping) and their own page. */
  connectorId?: string | undefined;
  group?: string | undefined;
  href?: string | undefined;
  access: AccessLevel | null;
  confirm: ConfirmLevel | null;
}

export interface RulesView {
  defaultAccess: AccessLevel;
  defaultConfirm: ConfirmLevel;
  undoWindowSeconds: number;
  apps: ScopedRuleView[];
  accounts: ScopedRuleView[];
  /** Rules this page does not edit (persona or service scoped), managed in the API. */
  otherRules: number;
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
}

const CONFIRMS: ConfirmLevel[] = ['never', 'dangerous', 'write', 'always'];
const ACCESSES: AccessLevel[] = ['full', 'write', 'read', 'none'];
const UNDO = [0, 10, 30, 60];

const ScopedTable: FC<{
  ctx: PageCtx;
  rows: ScopedRuleView[];
  kind: 'app' | 'account';
  empty: string;
  defaults: { access: AccessLevel; confirm: ConfirmLevel };
}> = ({ ctx, rows, kind, empty, defaults }) => {
  const { t } = ctx;
  // "Default" names the value it stands for, so the user sees what they would inherit.
  const inheritAccess = t('app.rules.inheritAs', { value: t(`app.rules.access.${defaults.access}` as Key) });
  const inheritConfirm = t('app.rules.inheritAs', {
    value: t(`app.rules.confirmShort.${defaults.confirm}` as Key),
  });
  if (!rows.length) return <p class="muted">{empty}</p>;
  return (
    <div class="rule-list">
      {rows.map((r, i) => (
        <>
          {r.group && r.group !== rows[i - 1]?.group ? <div class="acc-group">{r.group}</div> : null}
          <form method="post" action="/app/rules/scoped" class="rule-row">
            <Hidden values={{ csrf: ctx.csrf, kind, id: r.id }} />
            <div class="grow rule-who">
              {r.connectorId ? (
                <ServiceLogo
                  icon={serviceMeta(r.connectorId)?.icon}
                  glyph={serviceMeta(r.connectorId)?.glyph}
                  name={r.name}
                  size="sm"
                />
              ) : null}
              <span>
                {r.href ? (
                  <a class="acc-link" href={r.href}>
                    <strong>{r.name}</strong>
                  </a>
                ) : (
                  <strong>{r.name}</strong>
                )}
                {r.detail ? <span class="small muted">{r.detail}</span> : null}
              </span>
            </div>
            <div>
              <label class="small muted" for={`access-${r.id}`}>
                {t('app.rules.access')}
              </label>
              <select id={`access-${r.id}`} name="access">
                <option value="" selected={r.access === null}>
                  {inheritAccess}
                </option>
                {ACCESSES.map((a) => (
                  <option value={a} selected={r.access === a}>
                    {t(`app.rules.access.${a}` as Key)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label class="small muted" for={`confirm-${r.id}`}>
                {t('app.rules.confirm')}
              </label>
              <select id={`confirm-${r.id}`} name="confirm">
                <option value="" selected={r.confirm === null}>
                  {inheritConfirm}
                </option>
                {CONFIRMS.map((c) => (
                  <option value={c} selected={r.confirm === c}>
                    {t(`app.rules.confirmShort.${c}` as Key)}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" class="sm">
              {t('app.rules.save')}
            </button>
          </form>
        </>
      ))}
    </div>
  );
};

export const RulesPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: RulesView }> = ({ ctx, shell, view }) => {
  const { t } = ctx;
  const defaults = { access: view.defaultAccess, confirm: view.defaultConfirm };
  return (
    <AppShell ctx={ctx} shell={shell} section="rules" title={t('app.nav.rules')}>
      <PageHead title={t('app.nav.rules')} sub={t('app.rules.sub')} />
      <Flash flash={view.flash} />
      <div class="card">
        <h2>{t('app.rules.when')}</h2>
        <p class="muted">{t('app.rules.whenText')}</p>
        <form method="post" action="/app/rules/defaults">
          <Hidden values={{ csrf: ctx.csrf }} />
          <fieldset class="choice-list">
            <legend class="sr-only">{t('app.rules.when')}</legend>
            {CONFIRMS.map((c) => (
              <label class="choice">
                <input type="radio" name="confirm" value={c} checked={view.defaultConfirm === c} />
                <span>
                  <strong>{t(`app.rules.confirm.${c}` as Key)}</strong>
                  <span class="small muted">{t(`app.rules.confirmHint.${c}` as Key)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label for="undo">{t('app.rules.undo')}</label>
          <select id="undo" name="undo">
            {UNDO.map((n) => (
              <option value={String(n)} selected={view.undoWindowSeconds === n}>
                {n === 0
                  ? t('app.rules.undoOff')
                  : n % 60 === 0
                    ? t('app.rules.undoMinutes', { n: n / 60 })
                    : t('app.rules.undoSeconds', { n })}
              </option>
            ))}
          </select>
          <p class="hint">{t('app.rules.undoHint')}</p>
          <div class="actions start">
            <button type="submit" class="primary">
              {t('app.rules.save')}
            </button>
          </div>
        </form>
      </div>
      <div class="card">
        <h2>{t('app.rules.byApp')}</h2>
        <p class="muted">{t('app.rules.byAppText')}</p>
        <ScopedTable
          ctx={ctx}
          rows={view.apps}
          kind="app"
          empty={t('app.rules.noApps')}
          defaults={defaults}
        />
      </div>
      <div class="card">
        <h2>{t('app.rules.byAccount')}</h2>
        <p class="muted">{t('app.rules.byAccountText')}</p>
        <ScopedTable
          ctx={ctx}
          rows={view.accounts}
          kind="account"
          empty={t('app.rules.noAccounts')}
          defaults={defaults}
        />
      </div>
      <p class="hint">
        {view.otherRules ? `${t('app.rules.api', { n: view.otherRules })} ` : `${t('app.rules.apiNone')} `}
        <a href="/docs#api">{t('app.rules.apiLink')}</a>
      </p>
    </AppShell>
  );
};
