import {
  type ConnectorDefinition,
  type FieldLocale,
  type JsonSchema,
  toJsonSchema,
  type UiLanguage,
  uiLocales,
} from '../connectors/sdk.js';

/**
 * The browser form that connects an account of a service without OAuth (an API key, an app
 * password, a server address). Fields come from the connector's `config` and `credentials` zod
 * schemas, so a new connector gets its form for free; its optional `ui` adds texts in the page's
 * language and picks the fields shown up front. Framework-free: `web/connect-form.tsx` renders the
 * fields, `routes/connect.tsx` posts them back through {@link readConnectForm}.
 */

export type FormFieldKind = 'text' | 'secret' | 'number' | 'boolean' | 'select' | 'json';

export interface FormField {
  /** Form input name: `config.<key>` or `credentials.<key>`. */
  name: string;
  group: 'config' | 'credentials';
  key: string;
  kind: FormFieldKind;
  label: string;
  description?: string;
  /** Example value in an empty input; for a select, the label of the empty choice. */
  placeholder?: string;
  required: boolean;
  /** Collapsed under "Advanced": the connector lists its primary fields and this is neither one nor required. */
  advanced: boolean;
  /** A select whose values are booleans (`true`/`false`; empty = the connector decides). */
  valueType?: 'boolean';
  options?: FormOption[];
  /** Shown pre-filled (never for credentials). */
  defaultValue?: string;
  inputType?: 'email' | 'url' | 'text';
}

export interface FormOption {
  value: string;
  label: string;
}

function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function kindOf(schema: JsonSchema, group: FormField['group']): FormFieldKind {
  if (Array.isArray(schema.enum)) return 'select';
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (type === 'boolean') return 'boolean';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'string' || type === undefined) return group === 'credentials' ? 'secret' : 'text';
  return 'json'; // objects and arrays: rare, entered as JSON
}

interface FieldTexts {
  /** Locale entries for the field, page language first, then English. */
  entries: FieldLocale[];
  /** Keys shown up front, when the connector chose them. */
  primary: Set<string> | undefined;
}

function fieldsOf(
  schema: JsonSchema,
  group: FormField['group'],
  texts: (key: string) => FieldTexts,
): FormField[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([key, property]) => {
    let kind = kindOf(property, group);
    // An optional yes/no setting without a default means "let the connector decide" (e.g. a mail
    // provider preset): a checkbox could only say yes or no, so it becomes a three-way choice.
    const tristate = kind === 'boolean' && !required.has(key) && property.default === undefined;
    if (tristate) kind = 'select';
    const { entries, primary } = texts(key);
    // A locale entry replaces the schema texts as a whole: a translated field without a hint has none.
    const [entry] = entries;
    const field: FormField = {
      name: `${group}.${key}`,
      group,
      key,
      kind,
      label: entry?.label ?? (typeof property.title === 'string' ? property.title : humanize(key)),
      required: required.has(key),
      advanced: primary !== undefined && !required.has(key) && !primary.has(key),
    };
    const description = entry ? entry.hint : property.description;
    if (typeof description === 'string' && description) field.description = description;
    if (entry?.placeholder) field.placeholder = entry.placeholder;
    if (tristate) {
      field.valueType = 'boolean';
      field.options = ['true', 'false'].map((value) => ({
        value,
        label: entries.find((e) => e.options?.[value])?.options?.[value] ?? '',
      }));
    } else if (kind === 'select') {
      field.options = (property.enum as unknown[]).map((raw) => {
        const value = String(raw);
        return { value, label: entries.find((e) => e.options?.[value])?.options?.[value] ?? value };
      });
    }
    if (group === 'config' && property.default !== undefined) {
      field.defaultValue =
        typeof property.default === 'string' ? property.default : JSON.stringify(property.default);
    }
    if (kind === 'text' && property.format === 'email') field.inputType = 'email';
    if (kind === 'text' && property.format === 'uri') field.inputType = 'url';
    return field;
  });
}

/**
 * Form fields for connecting an account: settings first, then secrets. Labels, hints and select
 * options come from the connector's `ui` texts in `language`, then English, then the schemas.
 */
export function connectFormFields(connector: ConnectorDefinition, language: UiLanguage = 'en'): FormField[] {
  const locales = uiLocales(connector, language);
  const primaryFields = connector.ui?.primaryFields;
  const primary = primaryFields ? new Set(primaryFields) : undefined;
  const texts = (key: string): FieldTexts => ({
    entries: locales.flatMap((locale) => locale.fields?.[key] ?? []),
    primary,
  });
  return [
    ...fieldsOf(toJsonSchema(connector.config), 'config', texts),
    ...fieldsOf(toJsonSchema(connector.credentials), 'credentials', texts),
  ];
}

/**
 * The form field a validation issue of the account schemas is about: the issue path starts with the
 * field key. Config fields come first, so they win if a credentials field has the same key.
 */
export function fieldForIssue(fields: FormField[], path: string | undefined): FormField | undefined {
  const key = path?.split('.')[0];
  return key ? fields.find((f) => f.key === key) : undefined;
}

export interface ConnectFormValues {
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
  /** Fields that could not be read (e.g. invalid JSON), by input name. */
  problems: Record<string, string>;
}

/**
 * Turns posted form values into `config` and `credentials` objects. Empty inputs are left out, so
 * schema defaults apply and, on a reconnect, stored secrets stay as they are. The connector's zod
 * schemas validate the result when the account is saved.
 */
export function readConnectForm(
  fields: FormField[],
  form: Record<string, string | undefined>,
): ConnectFormValues {
  const values: ConnectFormValues = { config: {}, credentials: {}, problems: {} };
  for (const field of fields) {
    const raw = form[field.name];
    if (field.kind === 'boolean') {
      values[field.group][field.key] = raw === 'on' || raw === 'true';
      continue;
    }
    const text = raw?.trim() ?? '';
    if (text === '') continue;
    if (field.valueType === 'boolean') {
      values[field.group][field.key] = text === 'true';
    } else if (field.kind === 'number') {
      const number = Number(text);
      if (Number.isFinite(number)) values[field.group][field.key] = number;
      else values.problems[field.name] = 'not a number';
    } else if (field.kind === 'json') {
      try {
        values[field.group][field.key] = JSON.parse(text);
      } catch {
        values.problems[field.name] = 'not valid JSON';
      }
    } else {
      // Secrets are kept exactly as typed (a key may legitimately end with a space-like character).
      values[field.group][field.key] = field.kind === 'secret' ? (raw ?? '') : text;
    }
  }
  return values;
}
