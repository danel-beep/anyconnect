import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import imap from '../../src/connectors/builtin/imap/index.js';
import { createBuiltinRegistry } from '../../src/connectors/index.js';
import { actionText, connectorText, defineConnector, toJsonSchema } from '../../src/connectors/sdk.js';
import { connectFormFields, fieldForIssue } from '../../src/core/connect-form.js';

const LANGUAGES = ['ru', 'en'] as const;

/** Schema properties of the connect form: key, and the select values if it is a select. */
function formKeys(schema: z.ZodType): Array<{ key: string; options?: string[] }> {
  const json = toJsonSchema(schema) as { properties?: Record<string, { enum?: unknown[] }> };
  return Object.entries(json.properties ?? {}).map(([key, p]) => ({
    key,
    ...(Array.isArray(p.enum) ? { options: p.enum.map(String) } : {}),
  }));
}

describe('website texts of the built-in connectors', () => {
  for (const connector of createBuiltinRegistry().all()) {
    describe(connector.id, () => {
      const fields = [...formKeys(connector.config), ...formKeys(connector.credentials)];
      const keys = new Set(fields.map((f) => f.key));

      for (const language of LANGUAGES) {
        it(`has ${language} labels for every field and option`, () => {
          const locale = connector.ui?.locales?.[language];
          expect(locale, `${connector.id} has no ${language} texts`).toBeDefined();
          for (const { key, options } of fields) {
            const entry = locale?.fields?.[key];
            expect(entry?.label, `${connector.id}.${key} (${language})`).toBeTruthy();
            for (const option of options ?? []) {
              expect(entry?.options?.[option], `${connector.id}.${key}=${option} (${language})`).toBeTruthy();
            }
            for (const option of Object.keys(entry?.options ?? {})) expect(options).toContain(option);
          }
          // No texts for fields that do not exist (renamed or misspelled keys).
          for (const key of Object.keys(locale?.fields ?? {})) expect(keys).toContain(key);
        });

        it(`has ${language} titles and descriptions for every action`, () => {
          const texts = connector.ui?.locales?.[language]?.actions ?? {};
          for (const action of connector.actions) {
            expect(texts[action.name]?.title, `${connector.id}.${action.name} (${language})`).toBeTruthy();
            expect(
              texts[action.name]?.description,
              `${connector.id}.${action.name} (${language})`,
            ).toBeTruthy();
          }
          const names = new Set(connector.actions.map((a) => a.name));
          for (const name of Object.keys(texts)) expect(names).toContain(name);
        });
      }

      it('has setup guides that match in both languages, with https links and real variants', () => {
        const guides = LANGUAGES.map((language) => connector.ui?.locales?.[language]?.setup ?? {});
        const ways = ['oauth', 'form'] as const;
        // The same ways to connect are explained in every language, with the same variants.
        for (const way of ways) {
          const [ru, en] = guides.map((g) => g[way]);
          expect(Boolean(ru), `${connector.id} ${way} guide in ru and en`).toBe(Boolean(en));
          expect(Object.keys(ru?.variants ?? {}).sort()).toEqual(Object.keys(en?.variants ?? {}).sort());
        }
        if (guides.some((g) => g.oauth)) expect(connector.oauth, `${connector.id} oauth guide`).toBeDefined();
        const variants = connector.ui?.setupVariants;
        if (variants) {
          // Variant keys are values of the field they follow (or "custom" for an unknown domain).
          const field = fields.find((f) => f.key === variants.field);
          expect(field?.options, `${connector.id}.${variants.field} is a select`).toBeDefined();
          for (const key of Object.keys(variants.domains ?? {})) expect(field?.options).toContain(key);
          for (const g of guides)
            for (const key of Object.keys(g.form?.variants ?? {})) expect(field?.options).toContain(key);
          if (variants.emailField) expect(keys).toContain(variants.emailField);
        }
        for (const g of guides)
          for (const guide of [g.oauth, g.form]) {
            const steps = [
              ...(guide?.steps ?? []),
              ...Object.values(guide?.variants ?? {}).flatMap((v) => v.steps),
            ];
            for (const step of steps) {
              expect(step.text.trim()).not.toBe('');
              if (step.link) expect(new URL(step.link.url).protocol, step.link.url).toBe('https:');
            }
          }
      });

      it('suggests prompts to try in both languages, or in none', () => {
        const [ru = [], en = []] = LANGUAGES.map(
          (language) => connector.ui?.locales?.[language]?.prompts ?? [],
        );
        expect(ru.length > 0, connector.id).toBe(en.length > 0);
      });

      it('lists only existing fields as primary', () => {
        for (const key of connector.ui?.primaryFields ?? []) expect(keys).toContain(key);
      });

      it('keeps the AI-facing texts in English', () => {
        // Locales are for people only; the catalog keeps the connector's own descriptions.
        for (const action of connector.actions) expect(action.description).not.toMatch(/[а-яё]/i);
      });
    });
  }
});

describe('connect form texts', () => {
  it('labels fields, hints and select options in the page language', () => {
    const fields = connectFormFields(imap, 'ru');
    const provider = fields.find((f) => f.key === 'provider')!;
    expect(provider).toMatchObject({ label: 'Почтовый сервис', placeholder: 'Определить по адресу' });
    expect(provider.options).toContainEqual({ value: 'yandex', label: 'Яндекс Почта' });
    expect(fields.find((f) => f.key === 'password')!.label).toBe('Пароль приложения');
    expect(fields.find((f) => f.key === 'imapSecurity')!.options).toEqual([
      { value: 'tls', label: 'SSL/TLS' },
      { value: 'starttls', label: 'STARTTLS' },
    ]);
    expect(connectFormFields(imap, 'en').find((f) => f.key === 'password')!.label).toBe('App password');
    expect(connectorText(imap, 'ru').name).toBe('Почта (IMAP/SMTP)');
  });

  it('shows required and primary fields up front and the rest under "Advanced"', () => {
    const fields = connectFormFields(imap, 'ru');
    expect(fields.filter((f) => !f.advanced).map((f) => f.key)).toEqual(['email', 'provider', 'password']);
    expect(fields.find((f) => f.key === 'imapHost')!.advanced).toBe(true);
    expect(fields.find((f) => f.key === 'smtpPassword')!.advanced).toBe(true);
  });

  it('falls back to English, then to the schema, then to the key', () => {
    const service = defineConnector({
      id: 'partly',
      name: 'Partly',
      description: 'Partly translated',
      version: '1.0.0',
      config: z.object({
        region: z.enum(['eu', 'us']).describe('Data region'),
        plan: z.string().optional().describe('Plan name'),
        maxItems: z.number().optional(),
        note: z.string().optional().describe('Schema hint'),
      }),
      ui: {
        primaryFields: ['region'],
        locales: {
          ru: {
            fields: { region: { label: 'Регион', options: { eu: 'Европа' } }, note: { label: 'Заметка' } },
          },
          en: {
            fields: {
              region: { label: 'Region', options: { us: 'United States' } },
              plan: { label: 'Plan' },
            },
          },
        },
      },
      actions: (action) => [
        action({
          name: 'ping',
          title: 'Ping',
          description: 'Checks the service',
          input: z.object({}),
          run: () => 'ok',
        }),
      ],
    });
    const fields = connectFormFields(service, 'ru');
    const byKey = (key: string) => fields.find((f) => f.key === key)!;
    expect(byKey('region')).toMatchObject({ label: 'Регион', required: true, advanced: false });
    // A translated field without a hint has none (no English hint on a Russian page).
    expect(byKey('region').description).toBeUndefined();
    expect(byKey('region').options).toEqual([
      { value: 'eu', label: 'Европа' },
      { value: 'us', label: 'United States' },
    ]);
    expect(byKey('plan')).toMatchObject({ label: 'Plan', advanced: true });
    expect(byKey('maxItems').label).toBe('Max Items');
    expect(byKey('note')).toMatchObject({ label: 'Заметка', advanced: true });
    expect(byKey('note').description).toBeUndefined();
    expect(actionText(service, service.actions[0]!, 'ru')).toEqual({
      title: 'Ping',
      description: 'Checks the service',
    });
  });

  it('keeps the current form when the connector has no ui', () => {
    const plain = defineConnector({
      id: 'plain',
      name: 'Plain',
      description: 'No texts',
      version: '1.0.0',
      config: z.object({ apiBase: z.string().optional().describe('Where the API lives') }),
      credentials: z.object({ apiKey: z.string() }),
      actions: () => [],
    });
    const fields = connectFormFields(plain, 'ru');
    expect(fields.map((f) => [f.label, f.description, f.advanced])).toEqual([
      ['Api Base', 'Where the API lives', false],
      ['Api Key', undefined, false],
    ]);
    expect(connectorText(plain, 'ru')).toEqual({ name: 'Plain', description: 'No texts' });
  });

  it('finds the field a validation issue is about', () => {
    const fields = connectFormFields(imap, 'ru');
    expect(fieldForIssue(fields, 'imapHost')?.label).toBe('Адрес сервера IMAP');
    expect(fieldForIssue(fields, 'unknown')).toBeUndefined();
    expect(fieldForIssue(fields, undefined)).toBeUndefined();
  });
});
