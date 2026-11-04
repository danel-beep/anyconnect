import { type ConnectorDefinition, type JsonSchema, toJsonSchema } from '../connectors/sdk.js';

/**
 * The browser form that connects an account of a service without OAuth (an API key, an app
 * password, a server address). Fields come from the connector's `config` and `credentials` zod
 * schemas, so a new connector gets its form for free. Framework-free: `web/connect-form.tsx` renders
 * the fields, `routes/connect.tsx` posts them back through {@link readConnectForm}.
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
  required: boolean;
  options?: string[];
  /** Shown pre-filled (never for credentials). */
  defaultValue?: string;
  inputType?: 'email' | 'url' | 'text';
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

function fieldsOf(schema: JsonSchema, group: FormField['group']): FormField[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([key, property]) => {
    const kind = kindOf(property, group);
    const field: FormField = {
      name: `${group}.${key}`,
      group,
      key,
      kind,
      label: typeof property.title === 'string' ? property.title : humanize(key),
      required: required.has(key),
    };
    if (typeof property.description === 'string') field.description = property.description;
    if (kind === 'select') field.options = (property.enum as unknown[]).map(String);
    if (group === 'config' && property.default !== undefined) {
      field.defaultValue =
        typeof property.default === 'string' ? property.default : JSON.stringify(property.default);
    }
    if (kind === 'text' && property.format === 'email') field.inputType = 'email';
    if (kind === 'text' && property.format === 'uri') field.inputType = 'url';
    return field;
  });
}

/** Form fields for connecting an account: settings first, then secrets. */
export function connectFormFields(connector: ConnectorDefinition): FormField[] {
  return [
    ...fieldsOf(toJsonSchema(connector.config), 'config'),
    ...fieldsOf(toJsonSchema(connector.credentials), 'credentials'),
  ];
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
    if (field.kind === 'number') {
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
