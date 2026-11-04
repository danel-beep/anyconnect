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
  /** Input names of fields the error is about. */
  invalid?: string[];
  /** Shown when the service also supports OAuth. */
  oauthUrl?: string;
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
          {field.required ? null : (
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
      input = (
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
    <div>
      <label for={id}>
        {field.label}
        {required ? ' *' : ''}
      </label>
      {input}
      {field.description ? (
        <p id={hintId} class="muted small">
          {field.description}
        </p>
      ) : null}
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
  return (
    <Layout title={t('connect.formTitle', { service: view.service })} narrow lang={lang}>
      <p class="back-link">
        <a href="/app/services">← {t('connect.back')}</a>
      </p>
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
                value={view.label ?? ''}
                placeholder={t('connect.formLabelPlaceholder')}
                maxlength={100}
              />
            </div>
          )}
          {view.fields.filter((f) => !f.advanced).map(field)}
          {advanced.length > 0 ? (
            <details class="connect-advanced" open={openAdvanced}>
              <summary>{t('connect.formAdvanced')}</summary>
              <section>{advanced.map(field)}</section>
            </details>
          ) : null}
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
};
