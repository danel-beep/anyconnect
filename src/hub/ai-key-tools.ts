import { z } from 'zod';
import type { ActionDefinition, AnyObjectSchema } from '../connectors/sdk.js';
import { AppError } from '../lib/errors.js';
import type { SetupActionSpec, SetupContext } from './setup-tools.js';
import type { AiKeyInfo, WorkspaceTriggers } from './trigger-tools.js';

/**
 * The user's own AI API keys from the chat (`manyplug_ai_keys`, `manyplug_update_ai_key`,
 * `manyplug_remove_ai_key`): which model each runs and how often triggers may wake it a day. The
 * key itself never passes through a chat: the user pastes it on the AI API page (the one step on
 * the site), and these tools point there. Lowering a limit applies at once; raising or removing
 * one lets triggers spend more of the user's money, so it waits for their confirmation.
 */

const aiKeyRef = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe('The key’s name, provider (openai, anthropic, openrouter) or id (see manyplug_ai_keys)');

export function aiKeyActions(
  define: <T extends AnyObjectSchema>(spec: SetupActionSpec<T>) => ActionDefinition,
): ActionDefinition[] {
  const service = (ctx: SetupContext): WorkspaceTriggers => {
    if (!ctx.triggers) throw new AppError(501, 'no_triggers', 'AI keys are not available here');
    return ctx.triggers;
  };
  return [
    define({
      name: 'ai_keys',
      title: 'Show AI API keys',
      description:
        'Lists the user’s own AI API keys that do=ai triggers (automations) run on: provider, model, daily run limit, runs and tokens today, last error. The key itself is never shown and is added only by the user on the AI API page (returned as add_key); never ask for a key in the chat.',
      input: z.object({}),
      risk: 'read',
      hints: { readOnly: true, idempotent: true, openWorld: false },
      async run(_input, ctx) {
        const s = service(ctx);
        const keys = await s.aiKeys(ctx.principal.workspaceId);
        return {
          keys: keys.map(keyView),
          providers: s.aiProviders.map((p) => ({ id: p.id, name: p.name, default_model: p.defaultModel })),
          add_key: s.aiPageUrl,
          ...(keys.length
            ? {}
            : {
                hint: `No key yet. Send the user this link to paste one (the only step on the site): ${s.aiPageUrl}. Then set up the model, limit and triggers here.`,
              }),
        };
      },
    }),
    define({
      name: 'update_ai_key',
      title: 'Change an AI API key',
      description:
        'Changes one of the user’s AI keys: the model it runs (any model id the provider accepts, e.g. gpt-5-mini, claude-haiku-5-5, openai/gpt-5-mini), its name, or how many times a day triggers may wake it. Lowering the limit applies at once; raising or removing it waits for the user’s confirmation.',
      input: z.object({
        key: aiKeyRef,
        model: z.string().trim().min(1).max(100).optional().describe('Model id as the provider names it'),
        name: z.string().trim().min(1).max(60).optional().describe('New name for the key'),
        daily_runs: z
          .number()
          .int()
          .min(1)
          .max(100_000)
          .nullable()
          .optional()
          .describe('Runs a day on this key, across its triggers (null: no limit)'),
      }),
      risk: 'write',
      hints: { idempotent: true, openWorld: false },
      async assessRisk({ key, daily_runs: dailyRuns }, ctx) {
        if (dailyRuns === undefined) return undefined;
        const before = await service(ctx).findAiKey(ctx.principal.workspaceId, key);
        if (!before) return undefined;
        const raises = before.dailyRuns !== null && (dailyRuns === null || dailyRuns > before.dailyRuns);
        return raises
          ? {
              risk: 'dangerous',
              confirm: true,
              reason: 'Lets triggers spend more on your AI key each day',
            }
          : undefined;
      },
      async run({ key, model, name, daily_runs: dailyRuns }, ctx) {
        await ctx.admin.authorize(ctx.principal, 'admin');
        const updated = await service(ctx).updateAiKey(ctx.principal.workspaceId, key, {
          ...(model ? { model } : {}),
          ...(name ? { label: name } : {}),
          ...(dailyRuns !== undefined ? { dailyRuns } : {}),
        });
        return { updated: keyView(updated) };
      },
    }),
    define({
      name: 'remove_ai_key',
      title: 'Remove an AI API key',
      description:
        'Deletes one of the user’s AI keys from the hub. Triggers that used it stop waking the AI until another key is picked (manyplug_update_trigger with ai_key). It does not revoke the key at the provider.',
      input: z.object({ key: aiKeyRef }),
      risk: 'write',
      hints: { destructive: true, idempotent: true, openWorld: false },
      async run({ key }, ctx) {
        await ctx.admin.authorize(ctx.principal, 'admin');
        const removed = await service(ctx).deleteAiKey(ctx.principal.workspaceId, key);
        return { removed: removed.label };
      },
    }),
  ];
}

const keyView = (k: AiKeyInfo) => ({
  name: k.label,
  id: k.id,
  provider: k.provider,
  model: k.model,
  daily_runs: k.dailyRuns,
  runs_today: k.runsToday,
  tokens_today: k.tokensToday,
  ...(k.lastUsedAt ? { last_used: k.lastUsedAt.toISOString() } : {}),
  ...(k.lastError ? { last_error: k.lastError } : {}),
});
