import type { FC } from 'hono/jsx';
import type { ResolvedSetupGuide, RiskLevel } from '../connectors/sdk.js';
import type { FormField } from '../core/connect-form.js';
import { serviceMeta } from './catalog.js';
import type { Translate } from './i18n.js';
import { Layout } from './pages.js';
import { ProblemText } from './problems.js';
import {
  GuideSummary,
  GuideText,
  type GuideVariantPicker,
  PromptList,
  RiskBadge,
  SetupGuideView,
} from './setup-guide.js';
import { Icon, ServiceLogo } from './ui.js';

export interface ConnectFormView {
  connectorId: string;
  service: string;
  description: string;
  fields: FormField[];
  /** Hidden values carried through the post: label, name, account (reconnect), returnTo. */
  hidden: Record<string, string>;
  /** Label of the account being reconnected; then empty secret fields keep the stored values. */
  reconnecting?: string;
  /** Non-secret values to show again after an error. */
  values?: Record<string, string>;
  label?: string;
  error?: string;
  /** Input names of fields the error is about. */
  invalid?: string[];
  /** Shown when the service also supports OAuth. */
  oauthUrl?: string;
  /** Where to get the key or password, step by step. */
  guide?: ResolvedSetupGuide | undefined;
  /** Picks the guide's variant from the form (e.g. the mail provider). */
  picker?: GuideVariantPicker | undefined;
  /** What the AI can do with the account: action titles and risk. */
  actions: { title: string; risk: RiskLevel }[];
  /** The connection check failed: offer to keep the account anyway. */
  offerKeep?: boolean;
}

/** Whether the value differs from what the field starts with (then its "Advanced" block opens). */
function isCustomValue(field: FormField, value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  if (field.kind === 'boolean') return (value === 'true') !== (field.defaultValue === 'true');
  return value !== (field.defaultValue ?? '');
}

const Field: FC<{
  t: Translate;
  field: FormField;
  value?: string;
  reconnecting: boolean;
  invalid: boolean;
}> = ({ t, field, value, reconnecting, invalid }) => {
  const id = `f-${field.name.replace('.', '-')}`;
  // On a reconnect an empty secret keeps the stored one, so it is never required there.
  const required = field.required && !(reconnecting && field.group === 'credentials');
  const shown = value ?? field.defaultValue ?? '';
  const hintId = field.description ? `${id}-hint` : undefined;
  const common = {
    id,
    name: field.name,
    'aria-describedby': hintId,
    'aria-invalid': invalid ? 'true' : undefined,
  };
  let input: unknown;
  switch (field.kind) {
    case 'select':
      input = (
        <select {...common} required={required}>
          {/* A setting with a default always has a value: no blank choice next to "None". */}
          {field.required || field.defaultValue !== undefined ? null : (
            <option value="">
              {field.placeholder ?? (field.valueType === 'boolean' ? t('connect.formAuto') : '—')}
            </option>
          )}
          {field.options!.map((option) => (
            <option value={option.value} selected={option.value === shown}>
              {option.label ||
                (field.valueType === 'boolean'
                  ? t(option.value === 'true' ? 'connect.formYes' : 'connect.formNo')
                  : option.value)}
            </option>
          ))}
        </select>
      );
      break;
    case 'boolean':
      input = <input {...common} type="checkbox" checked={shown === 'true'} />;
      break;
    case 'json':
      input = (
        <textarea {...common} rows={3} required={required} placeholder={field.placeholder}>
          {shown}
        </textarea>
      );
      break;
    case 'secret':
      input = (
        <input
          {...common}
          type="password"
          autocomplete="off"
          spellcheck={false}
          required={required}
          placeholder={field.placeholder}
        />
      );
      break;
    case 'number':
      input = (
        <input
          {...common}
          type="number"
          value={shown}
          required={required}
          step="any"
          placeholder={field.placeholder}
        />
      );
      break;
    default:
      // Addresses are typed as text: "api.example.com" is accepted and gets https:// on the server,
      // where the browser's own URL check would refuse it.
      input =
        field.inputType === 'url' ? (
          <input
            {...common}
            type="text"
            inputmode="url"
            autocapitalize="off"
            spellcheck={false}
            value={shown}
            required={required}
            placeholder={field.placeholder}
          />
        ) : (
          <input
            {...common}
            type={field.inputType ?? 'text'}
            value={shown}
            required={required}
            placeholder={field.placeholder}
          />
        );
  }
  return (
    <div class={field.kind === 'boolean' ? 'field field-check' : 'field'}>
      <label for={id}>
        {field.label}
        {required ? (
          <span class="req" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      {input}
      {field.description ? (
        <p id={hintId} class="hint">
          {field.description}
        </p>
      ) : null}
    </div>
  );
};

/** What the AI will be able to do once the account is connected: counts by risk and the actions. */
export const AiCanDo: FC<{
  t: Translate;
  connectorId: string;
  actions: { title: string; risk: RiskLevel }[];
}> = ({ t, connectorId, actions }) => {
  if (!actions.length) return null;
  const count = (risk: RiskLevel) => actions.filter((a) => a.risk === risk).length;
  const changes = count('write') + count('dangerous');
  return (
    <div class="card ai-can-do">
      <h2>{t('connect.canDo')}</h2>
      <p class="small muted">
        {changes
          ? t('connect.canDoSummary', { n: actions.length, read: count('read'), write: changes })
          : t('connect.canDoReadOnly', { n: actions.length })}
      </p>
      <ul class="can-do-list">
        {actions.map((a) => (
          <li>
            <span>{a.title}</span>
            <RiskBadge t={t} risk={a.risk} />
          </li>
        ))}
      </ul>
      {changes ? (
        <p class="small muted">
          {t('connect.canDoRules')} <a href="/app/rules">{t('connect.rulesLink')}</a>
        </p>
      ) : null}
      <p class="small">
        <a href={`/services/${encodeURIComponent(connectorId)}`}>{t('connect.aboutService')}</a>
      </p>
    </div>
  );
};

/** The form that connects (or reconnects) an account of a service without OAuth. */
export const ConnectFormPage: FC<{ t: Translate; lang: string; csrf: string; view: ConnectFormView }> = ({
  t,
  lang,
  csrf,
  view,
}) => {
  const invalid = new Set(view.invalid);
  const field = (f: FormField) => (
    <Field
      t={t}
      field={f}
      value={view.values?.[f.name]}
      reconnecting={Boolean(view.reconnecting)}
      invalid={invalid.has(f.name)}
    />
  );
  const advanced = view.fields.filter((f) => f.advanced);
  // Open the block when it holds something the user set or got wrong, so nothing is hidden from them.
  const openAdvanced = advanced.some((f) => invalid.has(f.name) || isCustomValue(f, view.values?.[f.name]));
  const meta = serviceMeta(view.connectorId);
  const title = view.reconnecting
    ? t('connect.reconnectTitle', { label: view.reconnecting })
    : t('connect.formTitle', { service: view.service });
  return (
    <Layout title={title} lang={lang}>
      <div class="page-head connect-head">
        <div class="row nowrap-row">
          <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={view.service} size="lg" />
          <div>
            <p class="crumbs">
              <a href="/app/services">{t('app.nav.services')}</a> / {view.service}
            </p>
            <h1>{title}</h1>
            <p>{view.description}</p>
          </div>
        </div>
      </div>
      <div class="connect-grid">
        <div class="card connect-form-card">
          {view.reconnecting ? (
            <div class="notice info small">{t('connect.formReconnect', { label: view.reconnecting })}</div>
          ) : null}
          {view.guide?.summary ? (
            <p class="guide-summary">
              <GuideSummary t={t} guide={view.guide} />
              {/* On narrow screens the form comes first and the guide below it: a way down to the steps. */}
              <a class="to-guide" href="#connect-guide">
                {t('connect.seeSteps')}
              </a>
            </p>
          ) : null}
          {view.guide?.notice ? (
            <p class="notice info guide-notice">
              <GuideText text={view.guide.notice} />
            </p>
          ) : null}
          {view.error ? (
            <div class="notice bad" role="alert">
              {view.error}
            </div>
          ) : null}
          <form method="post" action={`/connect/${encodeURIComponent(view.connectorId)}`} autocomplete="off">
            <input type="hidden" name="csrf" value={csrf} />
            {Object.entries(view.hidden).map(([name, value]) => (
              <input type="hidden" name={name} value={value} />
            ))}
            {view.fields.filter((f) => !f.advanced).map(field)}
            {view.reconnecting ? null : (
              <div class="field">
                <label for="f-label">
                  {t('connect.formLabel')} <span class="muted small">{t('connect.optional')}</span>
                </label>
                <input
                  id="f-label"
                  type="text"
                  name="label"
                  value={view.label ?? ''}
                  placeholder={t('connect.formLabelPlaceholder')}
                  maxlength={100}
                  aria-describedby="f-label-hint"
                />
                <p class="hint" id="f-label-hint">
                  {t('connect.formLabelHint')}
                </p>
              </div>
            )}
            {advanced.length > 0 ? (
              <details class="connect-advanced" open={openAdvanced}>
                <summary>{t('connect.formAdvanced')}</summary>
                <section>{advanced.map(field)}</section>
              </details>
            ) : null}
            {view.offerKeep ? (
              <label class="check">
                <input type="checkbox" name="keep" value="1" /> {t('connect.keepAnyway')}
              </label>
            ) : null}
            <div class="actions">
              <button class="primary lg" type="submit">
                {t(view.reconnecting ? 'connect.formReconnectSubmit' : 'connect.formSubmit')}
              </button>
            </div>
            <p class="secure-note">
              <Icon name="lock" /> {t('connect.formSecrets')}
            </p>
          </form>
          {view.oauthUrl ? (
            <p class="small">
              <a href={view.oauthUrl}>{t('connect.formUseOAuth')}</a>
            </p>
          ) : null}
        </div>
        <aside class="connect-aside">
          {view.guide ? (
            <div class="card guide-card" id="connect-guide">
              <h2>{t('connect.howTo')}</h2>
              <SetupGuideView t={t} guide={view.guide} picker={view.picker} bare />
            </div>
          ) : null}
          <AiCanDo t={t} connectorId={view.connectorId} actions={view.actions} />
        </aside>
      </div>
    </Layout>
  );
};

export interface ConnectedView {
  connectorId: string;
  service: string;
  label: string;
  created: boolean;
  identity?: string | undefined;
  /** Set when the connection test failed. */
  problem?: string | undefined;
  returnTo: string;
  /** Requests to try with the AI. */
  prompts: string[];
  /** No AI app is connected yet: point to the MCP address next. */
  needsAi: boolean;
  /** The new account's page. */
  accountUrl?: string | undefined;
}

/** After connecting: what happened, what to ask the AI, and the next step. */
export const ConnectedPage: FC<{ t: Translate; lang: string; view: ConnectedView }> = ({ t, lang, view }) => {
  const meta = serviceMeta(view.connectorId);
  return (
    <Layout title={t('connect.doneTitle')} lang={lang}>
      <div class="connected">
        <div class="card connected-card">
          <div class="connected-logos" aria-hidden="true">
            <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={view.service} size="lg" />
            <span class={`result-icon ${view.problem ? 'warn' : 'ok'}`}>
              <Icon name={view.problem ? 'alert' : 'check'} />
            </span>
          </div>
          <h1>{view.problem ? t('connect.doneWithProblem') : t('connect.doneTitle')}</h1>
          <p>
            {t(view.created ? 'connect.created' : 'connect.reconnected', {
              service: view.service,
              label: view.label,
            })}{' '}
            {view.identity ? t('connect.identity', { identity: view.identity }) : null}
          </p>
          {view.problem ? (
            <div class="notice">
              <ProblemText t={t} message={view.problem} details /> {t('connect.testFailed')}
            </div>
          ) : null}
          {view.prompts.length && !view.problem ? (
            <div class="try-it">
              <h2>{t('connect.tryAsking')}</h2>
              <PromptList t={t} prompts={view.prompts.slice(0, 3)} idPrefix="try" />
              <p class="small muted">{view.needsAi ? t('connect.aiFirst') : t('connect.aiHint')}</p>
            </div>
          ) : null}
          <div class="actions start">
            {view.needsAi ? (
              <a class="btn primary" href="/app#connect-ai">
                {t('connect.connectAi')} <Icon name="arrow" />
              </a>
            ) : (
              <a class="btn primary" href={view.returnTo}>
                {t('connect.continue')}
              </a>
            )}
            {view.accountUrl ? (
              <a class="btn" href={view.accountUrl}>
                {t('connect.accountSettings')}
              </a>
            ) : null}
            <a class="btn ghost" href="/app/services#add">
              {t('connect.addMore')}
            </a>
          </div>
        </div>
      </div>
    </Layout>
  );
};

export interface ServiceUnavailableView {
  connectorId: string;
  service: string;
  /** The viewer runs this server: point them to where the sign-in app is set up. */
  isAdmin: boolean;
  /**
   * `oauth`: the service signs in through OAuth and this server has no OAuth app for it yet.
   * `setup`: the server lacks something else the service needs (`env` names it), e.g. the
   * messenger gateway's Telegram API keys.
   */
  reason: 'oauth' | 'setup';
  env?: string[] | undefined;
  /** Another way to connect the same data, e.g. Gmail over IMAP. */
  alternative?: { service: string; url: string; note?: string | undefined } | undefined;
}

/** The service cannot be connected on this server yet (see `reason`). */
export const ServiceUnavailablePage: FC<{ t: Translate; lang: string; view: ServiceUnavailableView }> = ({
  t,
  lang,
  view,
}) => {
  const meta = serviceMeta(view.connectorId);
  return (
    <Layout title={t('connect.unavailableTitle', { service: view.service })} lang={lang}>
      <div class="connected">
        <div class="card connected-card">
          <div class="connected-logos" aria-hidden="true">
            <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={view.service} size="lg" />
            <span class="result-icon warn">
              <Icon name="alert" />
            </span>
          </div>
          <h1>{t('connect.unavailableTitle', { service: view.service })}</h1>
          <p>
            {view.reason === 'setup'
              ? t(view.isAdmin ? 'connect.unavailableSetupAdmin' : 'connect.unavailableSetupText', {
                  service: view.service,
                  env: (view.env ?? []).join(', '),
                })
              : t(view.isAdmin ? 'connect.unavailableAdmin' : 'connect.unavailableText', {
                  service: view.service,
                })}
          </p>
          {view.alternative ? (
            <div class="notice info">
              <strong>{t('connect.unavailableAltTitle')}</strong>{' '}
              {view.alternative.note ??
                t('connect.unavailableAlt', { service: view.service, alternative: view.alternative.service })}
            </div>
          ) : null}
          <div class="actions start">
            {view.alternative ? (
              <a class="btn primary" href={view.alternative.url}>
                {t('connect.unavailableAltButton', { alternative: view.alternative.service })}{' '}
                <Icon name="arrow" />
              </a>
            ) : null}
            {view.isAdmin && view.reason === 'oauth' ? (
              <a class={view.alternative ? 'btn' : 'btn primary'} href="/admin/system#apps">
                {t('connect.unavailableSetup')}
              </a>
            ) : null}
            <a class="btn ghost" href="/app/services#add">
              {t('connect.unavailableBack')}
            </a>
          </div>
        </div>
      </div>
    </Layout>
  );
};
