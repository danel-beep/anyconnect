import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { createBuiltinRegistry } from '../../src/connectors/index.js';
import {
  type ConnectorDefinition,
  type SetupGuide,
  type SetupStep,
  toJsonSchema,
} from '../../src/connectors/sdk.js';

/**
 * The writing standard for setup guides (docs/CONNECTORS.md, "Стандарт инструкции"), enforced for
 * every built-in connector: a guide that is vague, too long, skips a form field or differs between
 * languages fails CI. When a rule here is wrong for a real case, change the standard in the doc
 * and here together, never per connector.
 */

const LANGUAGES = ['en', 'ru'] as const;
/** Sample accounts, not a real service: nothing to explain. */
const EXEMPT = new Set(['demo']);

const LIMITS = {
  summary: 160,
  need: 140,
  notice: 240,
  step: 260,
  sentencesPerStep: 2,
  tip: 220,
  problem: 160,
  fix: 300,
  minutes: [1, 60],
  needs: [1, 5],
  steps: { oauth: [2, 6], form: [2, 8], app: [2, 6] },
  variantSteps: [1, 6],
  tips: 4,
  problems: { oauth: [1, 6], form: [2, 6], app: [1, 6] },
  prompts: [3, 5],
} as const;

/** Words that make a guide vaguer or talk down to people, and internal names they do not know. */
const BANNED: Record<(typeof LANGUAGES)[number], RegExp> = {
  en: /\b(simply|just|easy|easily|obviously|etc|e\.g\.|i\.e\.|the hub)\b/i,
  ru: /(?<![а-яё])(просто|всего лишь|и т\. ?д\.|т\. ?е\.|т\. ?к\.|хаб\S*)(?![а-яё])/i,
};

interface FormField {
  key: string;
  required: boolean;
}

function formFields(connector: ConnectorDefinition): FormField[] {
  return [connector.config, connector.credentials].flatMap((schema) => {
    const json = toJsonSchema(schema as z.ZodType) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const required = new Set(json.required ?? []);
    return Object.keys(json.properties ?? {}).map((key) => ({ key, required: required.has(key) }));
  });
}

/**
 * The ways an account of this connector is connected, each of which needs a guide. Quick connect
 * (`app`: confirming in the service's own app) is the hub's flow, so a connector that has one
 * declares its guide and it is held to the same standard.
 */
function ways(connector: ConnectorDefinition): Array<'oauth' | 'form' | 'app'> {
  const secrets = toJsonSchema(connector.credentials as z.ZodType) as { properties?: object };
  const hasForm = !connector.oauth || Object.keys(secrets.properties ?? {}).length > 0;
  const hasApp = LANGUAGES.some((language) => connector.ui?.locales?.[language]?.setup?.app);
  return [
    ...(connector.oauth ? (['oauth'] as const) : []),
    ...(hasForm ? (['form'] as const) : []),
    ...(hasApp ? (['app'] as const) : []),
  ];
}

function allSteps(guide: SetupGuide): SetupStep[] {
  return [...guide.steps, ...Object.values(guide.variants ?? {}).flatMap((v) => v.steps)];
}

function sentences(text: string): number {
  return text.split(/(?<=[.!?])\s+(?=\S)/).filter((s) => s.trim()).length;
}

/** Every person-facing string of a guide, labelled for error messages. */
function texts(guide: SetupGuide): Array<[string, string]> {
  return [
    ['summary', guide.summary],
    ...guide.needs.map((n, i): [string, string] => [`needs[${i}]`, n]),
    ...(guide.notice ? [['notice', guide.notice] as [string, string]] : []),
    ...allSteps(guide).map((s, i): [string, string] => [`step ${i + 1}`, s.text]),
    ...(guide.tips ?? []).map((t, i): [string, string] => [`tips[${i}]`, t]),
    ...guide.problems.flatMap(
      (p, i): Array<[string, string]> => [
        [`problems[${i}].problem`, p.problem],
        [`problems[${i}].fix`, p.fix],
      ],
    ),
  ];
}

function between(value: number, [min, max]: readonly [number, number]): boolean {
  return value >= min && value <= max;
}

describe('setup guides follow the standard', () => {
  for (const connector of createBuiltinRegistry().all()) {
    if (EXEMPT.has(connector.id)) continue;
    const fields = formFields(connector);
    const keys = new Set(fields.map((f) => f.key));

    describe(connector.id, () => {
      for (const way of ways(connector)) {
        const guides = LANGUAGES.map((language) => connector.ui?.locales?.[language]?.setup?.[way]);

        it(`has a ${way} guide in every language`, () => {
          for (const [i, guide] of guides.entries())
            expect(guide, `${connector.id}: no ${way} guide in ${LANGUAGES[i]}`).toBeDefined();
        });

        for (const [index, language] of LANGUAGES.entries()) {
          const where = `${connector.id} ${way} (${language})`;

          it(`${way} guide (${language}) is short, concrete and complete`, () => {
            const guide = guides[index];
            if (!guide) return;
            // Summary: one sentence on what you do. Time has its own field.
            expect(guide.summary.length, `${where} summary`).toBeLessThanOrEqual(LIMITS.summary);
            expect(sentences(guide.summary), `${where} summary is one sentence`).toBe(1);
            expect(guide.summary, `${where} summary: time goes into minutes`).not.toMatch(/minute|минут/i);
            expect(Number.isInteger(guide.minutes) && between(guide.minutes, LIMITS.minutes), where).toBe(
              true,
            );
            expect(between(guide.needs.length, LIMITS.needs), `${where} needs: 1–5 items`).toBe(true);
            for (const need of guide.needs)
              expect(need.length, `${where} need "${need}"`).toBeLessThanOrEqual(LIMITS.need);
            if (guide.notice)
              expect(guide.notice.length, `${where} notice`).toBeLessThanOrEqual(LIMITS.notice);

            // Steps: few, one action each.
            expect(
              between(guide.steps.length, LIMITS.steps[way]),
              `${where}: ${guide.steps.length} steps`,
            ).toBe(true);
            for (const variant of Object.values(guide.variants ?? {}))
              expect(
                between(variant.steps.length, LIMITS.variantSteps),
                `${where} variant ${variant.title}`,
              ).toBe(true);
            for (const step of allSteps(guide)) {
              expect(step.text.length, `${where} step too long: "${step.text}"`).toBeLessThanOrEqual(
                LIMITS.step,
              );
              expect(
                sentences(step.text),
                `${where} step has more than one action: "${step.text}"`,
              ).toBeLessThanOrEqual(LIMITS.sentencesPerStep);
              if (step.link) expect(new URL(step.link.url).protocol, step.link.url).toBe('https:');
              for (const key of step.fills ?? [])
                expect(keys, `${where}: fills unknown field ${key}`).toContain(key);
            }

            expect((guide.tips ?? []).length, `${where} tips`).toBeLessThanOrEqual(LIMITS.tips);
            for (const tip of guide.tips ?? [])
              expect(tip.length, `${where} tip "${tip}"`).toBeLessThanOrEqual(LIMITS.tip);
            expect(between(guide.problems.length, LIMITS.problems[way]), `${where}: problems`).toBe(true);
            for (const p of guide.problems) {
              expect(p.problem.length, `${where} problem "${p.problem}"`).toBeLessThanOrEqual(LIMITS.problem);
              expect(p.fix.length, `${where} fix "${p.fix}"`).toBeLessThanOrEqual(LIMITS.fix);
            }

            for (const [label, text] of texts(guide)) {
              expect(text.trim(), `${where} ${label} is empty`).not.toBe('');
              expect(text, `${where} ${label}: avoid "${text.match(BANNED[language])?.[0]}"`).not.toMatch(
                BANNED[language],
              );
              expect((text.match(/\*\*/g) ?? []).length % 2, `${where} ${label}: unbalanced **`).toBe(0);
            }
          });
        }

        it(`${way} guide says where every form value comes from`, () => {
          if (way !== 'form') return;
          const guide = guides[0];
          if (!guide) return;
          const filled = new Set(allSteps(guide).flatMap((s) => s.fills ?? []));
          const needed = fields
            .filter((f) => f.required || connector.ui?.primaryFields?.includes(f.key))
            .map((f) => f.key);
          for (const key of needed) expect(filled, `${connector.id}: no step fills "${key}"`).toContain(key);
        });

        it(`${way} guide has the same structure in every language`, () => {
          const [en, ru] = guides;
          if (!en || !ru) return;
          const shape = (g: SetupGuide) => ({
            minutes: g.minutes,
            needs: g.needs.length,
            notice: Boolean(g.notice),
            steps: g.steps.map((s) => ({ fills: s.fills ?? [], link: s.link?.url })),
            variants: Object.fromEntries(
              Object.entries(g.variants ?? {}).map(([k, v]) => [
                k,
                v.steps.map((s) => ({ fills: s.fills ?? [], link: s.link?.url })),
              ]),
            ),
            tips: (g.tips ?? []).length,
            problems: g.problems.length,
          });
          expect(shape(ru), `${connector.id} ${way}: ru differs from en`).toEqual(shape(en));
        });
      }

      it('has an oauth guide only if it signs in through the service', () => {
        for (const language of LANGUAGES)
          if (connector.ui?.locales?.[language]?.setup?.oauth) expect(connector.oauth).toBeDefined();
      });

      it('has the setup variants its form picks from', () => {
        const variants = connector.ui?.setupVariants;
        if (!variants) return;
        const json = toJsonSchema(connector.config as z.ZodType) as {
          properties?: Record<string, { enum?: unknown[] }>;
        };
        const options = (json.properties?.[variants.field]?.enum ?? []).map(String);
        expect(options.length, `${connector.id}.${variants.field} is a select`).toBeGreaterThan(0);
        for (const key of Object.keys(variants.domains ?? {})) expect(options).toContain(key);
        for (const language of LANGUAGES)
          for (const key of Object.keys(connector.ui?.locales?.[language]?.setup?.form?.variants ?? {}))
            expect(options).toContain(key);
        if (variants.emailField) expect(keys).toContain(variants.emailField);
      });

      it('suggests 3–5 requests to try in every language', () => {
        for (const language of LANGUAGES) {
          const prompts = connector.ui?.locales?.[language]?.prompts ?? [];
          expect(between(prompts.length, LIMITS.prompts), `${connector.id} prompts (${language})`).toBe(true);
        }
      });
    });
  }
});
