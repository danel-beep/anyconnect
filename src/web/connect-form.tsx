import type { FC } from 'hono/jsx';
import type { FormField } from '../core/connect-form.js';
import type { Translate } from './i18n.js';
import { Layout } from './pages.js';

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
  /** Shown when the service also supports OAuth. */
  oauthUrl?: string;
}

const Field: FC<{ field: FormField; value?: string; reconnecting: boolean }> = ({
  field,
  value,
  reconnecting,
}) => {
  const id = `f-${field.name.replace('.', '-')}`;
  // On a reconnect an empty secret keeps the stored one, so it is never required there.
  const required = field.required && !(reconnecting && field.group === 'credentials');
  const shown = value ?? field.defaultValue ?? '';
  let input: unknown;
  switch (field.kind) {
    case 'select':
      input = (
        <select id={id} name={field.name} required={required}>
          {field.required ? null : <option value="">—</option>}
          {field.options!.map((option) => (
            <option value={option} selected={option === shown}>
              {option}
            </option>
          ))}
        </select>
      );
      break;
    case 'boolean':
      input = <input id={id} type="checkbox" name={field.name} checked={shown === 'true'} />;
      break;
    case 'json':
      input = (
        <textarea id={id} name={field.name} rows={3} required={required}>
          {shown}
        </textarea>
      );
      break;
    case 'secret':
      input = (
        <input
          id={id}
          type="password"
          name={field.name}
          autocomplete="off"
          spellcheck={false}
          required={required}
        />
      );
      break;
    case 'number':
      input = <input id={id} type="number" name={field.name} value={shown} required={required} step="any" />;
      break;
    default:
      input = (
        <input id={id} type={field.inputType ?? 'text'} name={field.name} value={shown} required={required} />
      );
  }
  return (
    <div>
      <label for={id}>
        {field.label}
        {required ? ' *' : ''}
      </label>
      {input}
      {field.description ? <p class="muted small">{field.description}</p> : null}
    </div>
  );
};

/** The form that connects (or reconnects) an account of a service without OAuth. */
export const ConnectFormPage: FC<{ t: Translate; lang: string; csrf: string; view: ConnectFormView }> = ({
  t,
  lang,
  csrf,
  view,
}) => (
  <Layout title={t('connect.formTitle', { service: view.service })} narrow lang={lang}>
    <div class="card">
      <h1>{t('connect.formTitle', { service: view.service })}</h1>
      <p class="muted">{view.description}</p>
      {view.reconnecting ? <p>{t('connect.formReconnect', { label: view.reconnecting })}</p> : null}
      <form method="post" action={`/connect/${encodeURIComponent(view.connectorId)}`} autocomplete="off">
        <input type="hidden" name="csrf" value={csrf} />
        {Object.entries(view.hidden).map(([name, value]) => (
          <input type="hidden" name={name} value={value} />
        ))}
        {view.reconnecting ? null : (
          <div>
            <label for="f-label">{t('connect.formLabel')}</label>
            <input
              id="f-label"
              type="text"
              name="label"
              value={view.label ?? view.service}
              required
              maxlength={100}
            />
          </div>
        )}
        {view.fields.map((field) => (
          <Field field={field} value={view.values?.[field.name]} reconnecting={Boolean(view.reconnecting)} />
        ))}
        <p class="muted small">{t('connect.formSecrets')}</p>
        {view.error ? <p class="error">{view.error}</p> : null}
        <div class="actions">
          <button class="primary" type="submit">
            {t(view.reconnecting ? 'connect.formReconnectSubmit' : 'connect.formSubmit')}
          </button>
        </div>
      </form>
      {view.oauthUrl ? (
        <p class="small">
          <a href={view.oauthUrl}>{t('connect.formUseOAuth')}</a>
        </p>
      ) : null}
    </div>
  </Layout>
);
