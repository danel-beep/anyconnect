import { z } from 'zod';
import type { ActionDefinition, AnyObjectSchema } from '../connectors/sdk.js';
import type { Principal } from '../core/principal.js';
import { AppError } from '../lib/errors.js';
import type { SetupActionSpec, SetupContext } from './setup-tools.js';

/**
 * Triggers from the chat (`manyplug_triggers`, `manyplug_create_trigger`, `manyplug_update_trigger`,
 * `manyplug_delete_trigger`) and the cheap "anything new?" check (`manyplug_check_triggers`) that a
 * scheduled task in Claude or ChatGPT calls: it answers `{"new":0}` in a few tokens when nothing
 * matched, so the AI only reads mail or chats when there is something to read.
 *
 * A trigger that makes the hub act on its own (call a tool, wake the user's AI on their API key)
 * adds a new way for data to leave, so creating one, turning one back on or letting its AI act
 * without asking always waits for the user's confirmation. API keys are never set from the chat:
 * the tools point to the AI API page.
 */

export type TriggerWhen = 'message' | 'mail';
export type TriggerDo = 'check' | 'notify' | 'tool' | 'ai';

/** A trigger as the tools show it. */
export interface TriggerInfo {
  id: string;
  name: string;
  enabled: boolean;
  /** Why it stopped on its own (daily limit), null while it runs. */
  paused: string | null;
  when: TriggerWhen;
  /** "all mail", "telegram", "gmail:work"… */
  accounts: string;
  filter: Record<string, string>;
  do: TriggerDo;
  /** Short description of the action, e.g. "telegram_send" or "AI (OpenAI, 3 tools)". */
  action: string;
  task?: string;
  askBeforeRisky?: boolean;
  dailyLimit: number | null;
  runsToday: number;
}

export interface TriggerChange {
  name?: string;
  when?: TriggerWhen;
  account?: string;
  filter?: { from?: string; chat?: string; subject?: string; text?: string };
  do?: TriggerDo;
  task?: string;
  tool?: string;
  args?: Record<string, unknown>;
  instructions?: string;
  tools?: string[];
  aiKey?: string;
  askBeforeRisky?: boolean;
  notify?: boolean;
  dailyLimit?: number | null;
  enabled?: boolean;
}

export interface CheckedEvent {
  trigger: string;
  service: string;
  account: string;
  id: string;
  chat?: string;
  from?: string;
  title?: string;
  preview: string;
  at: string;
  /** What the user asked the AI to do with matches of this trigger. */
  task?: string;
}

/**
 * What the trigger tools need. Defined here, implemented by `TriggerService` (`src/triggers/`), so
 * the hub does not depend on the trigger engine.
 */
export interface WorkspaceTriggers {
  list(workspaceId: string): Promise<TriggerInfo[]>;
  find(workspaceId: string, ref: string): Promise<TriggerInfo>;
  create(
    principal: Principal,
    input: TriggerChange & { name: string; when: TriggerWhen; do: TriggerDo },
  ): Promise<TriggerInfo>;
  update(principal: Principal, ref: string, change: TriggerChange): Promise<TriggerInfo>;
  delete(workspaceId: string, ref: string): Promise<void>;
  /** Hands over the events waiting for an AI check (and reads mailboxes first, inside this request). */
  check(
    principal: Principal,
    options: { trigger?: string; limit: number; signal: AbortSignal },
  ): Promise<{ events: CheckedEvent[]; more: boolean }>;
  /** The user's AI keys by label, for `ai_key`. */
  aiKeys(workspaceId: string): Promise<Array<{ label: string; provider: string; model: string }>>;
  pageUrl: string;
  aiPageUrl: string;
}

const triggerRef = z.string().trim().min(1).max(100).describe('Trigger name or id (see manyplug_triggers)');

const FilterInput = z
  .object({
    from: z.string().trim().max(300).optional(),
    chat: z.string().trim().max(300).optional(),
    subject: z.string().trim().max(300).optional(),
    text: z.string().trim().max(300).optional(),
  })
  .describe(
    'Every field set must match (case-insensitive "contains"; commas separate alternatives): from = sender name, @username, phone or email; chat = chat title (messages); subject = email subject (mail); text = words in the message or the email subject and preview. Empty: every new item.',
  );

const ChangeFields = {
  account: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe('Only this account ("service:name") or service ("gmail"); default every account of the kind'),
  filter: FilterInput.optional(),
  task: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .describe('do=check: what you (the AI app) should do with a match when you check, e.g. "draft a reply"'),
  tool: z.string().trim().max(100).optional().describe('do=tool: the tool the hub calls, e.g. telegram_send'),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'do=tool: its arguments; strings may contain {{from}}, {{text}}, {{chat}} (chat id), {{chat_title}}, {{subject}}, {{id}}, {{account}}',
    ),
  instructions: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .describe('do=ai: what the user’s AI should do with each event, in the user’s words'),
  tools: z
    .array(z.string().trim().min(1).max(100))
    .max(20)
    .optional()
    .describe(
      'do=ai: the only tools it may call (as few as the task needs); none: it only reports to the user',
    ),
  ai_key: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe('do=ai: which AI key (label); default the first one'),
  ask_before_risky: z
    .boolean()
    .optional()
    .describe('do=ai: risky actions (sending, deleting) wait for the user’s confirmation (default true)'),
  notify: z
    .boolean()
    .optional()
    .describe('do=ai: send the AI’s summary to the user in Telegram (default true)'),
  daily_limit: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .nullable()
    .optional()
    .describe('Runs a day before the trigger pauses (the user’s choice; default 200, null: no limit)'),
};

const DO = z
  .enum(['check', 'notify', 'tool', 'ai'])
  .describe(
    'check: keep matches for you to fetch with manyplug_check_triggers (from a scheduled task; costs ~no tokens when nothing matched) · notify: message the user in Telegram · tool: the hub calls one tool with the args · ai: wake the user’s own AI (their API key) with only the listed tools',
  );

const toChange = (input: Record<string, unknown>): TriggerChange => {
  const {
    ai_key: aiKey,
    ask_before_risky: askBeforeRisky,
    daily_limit: dailyLimit,
    do: kind,
    ...rest
  } = input as Record<string, unknown> & { do?: TriggerDo };
  return {
    ...(rest as TriggerChange),
    ...(kind ? { do: kind } : {}),
    ...(aiKey !== undefined ? { aiKey: aiKey as string } : {}),
    ...(askBeforeRisky !== undefined ? { askBeforeRisky: askBeforeRisky as boolean } : {}),
    ...(dailyLimit !== undefined ? { dailyLimit: dailyLimit as number | null } : {}),
  };
};

/** A ready prompt for the user's scheduled task: check, and only read on when something matched. */
const scheduleFor = (name?: string) => ({
  every: 'hour (or as often as the app allows)',
  prompt: `Call manyplug_check_triggers${name ? ` with trigger "${name}"` : ''}. If it returns new: 0, stop and say nothing else. Otherwise handle each event as its "task" says, reading more only where needed.`,
  how: 'Offer the user to create this as a scheduled task in their AI app (Claude: scheduled tasks; ChatGPT: Tasks; Claude Code: /loop). Only with their consent.',
});

export function triggerActions(
  define: <T extends AnyObjectSchema>(spec: SetupActionSpec<T>) => ActionDefinition,
): ActionDefinition[] {
  const service = (ctx: SetupContext): WorkspaceTriggers => {
    if (!ctx.triggers) throw new AppError(501, 'no_triggers', 'Triggers are not available here');
    return ctx.triggers;
  };
  const view = (t: TriggerInfo) => ({
    name: t.name,
    id: t.id,
    on: t.enabled && !t.paused,
    ...(t.paused ? { paused: t.paused } : {}),
    ...(!t.enabled ? { disabled: true } : {}),
    when: t.when,
    accounts: t.accounts,
    ...(Object.keys(t.filter).length ? { filter: t.filter } : {}),
    do: t.do,
    action: t.action,
    ...(t.task ? { task: t.task } : {}),
    daily_limit: t.dailyLimit,
    runs_today: t.runsToday,
  });
  /** Whether a change lets the hub act on its own where it did not before. */
  const widens = (before: TriggerInfo | undefined, change: TriggerChange): string | undefined => {
    const kind = change.do ?? before?.do;
    const acts = kind === 'tool' || kind === 'ai';
    if (!acts) return undefined;
    if (!before) return 'A new trigger lets the hub act on its own when an event matches';
    if (change.do && change.do !== before.do) return 'The trigger will act on its own when an event matches';
    if (change.enabled === true && (!before.enabled || before.paused))
      return 'Turns on a trigger that acts on its own';
    if (change.tool || change.tools || change.args || change.instructions)
      return 'Changes what the trigger does on its own';
    if (change.askBeforeRisky === false && before.askBeforeRisky !== false)
      return 'The trigger’s AI will send and delete without asking';
    if (change.account !== undefined || change.filter) return 'Changes which events make the trigger act';
    return undefined;
  };
  return [
    define({
      name: 'check_triggers',
      title: 'Check triggers for anything new',
      description:
        'Cheap check for a scheduled task: returns the new events the user’s "check" triggers matched since the last check (each handed out once), or {"new":0}. Read the full message or email with the service’s own tools only when something is new.',
      input: z.object({
        trigger: triggerRef.optional().describe('Only this trigger (name or id); default all'),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      risk: 'read',
      // Previews are other people's text: marked as untrusted data.
      hints: { readOnly: true },
      async run({ trigger, limit }, ctx) {
        const { events, more } = await service(ctx).check(ctx.principal, {
          ...(trigger ? { trigger } : {}),
          limit,
          signal: ctx.signal,
        });
        if (!events.length) return { new: 0 };
        return { new: events.length, ...(more ? { more: true } : {}), events };
      },
    }),
    define({
      name: 'triggers',
      title: 'Show triggers',
      description:
        'Lists the user’s triggers ("when a message or email matches, do something"): what each watches, what it does, whether it is on, runs today and the daily limit.',
      input: z.object({}),
      risk: 'read',
      hints: { readOnly: true, idempotent: true, openWorld: false },
      async run(_input, ctx) {
        const s = service(ctx);
        const [list, keys] = await Promise.all([
          s.list(ctx.principal.workspaceId),
          s.aiKeys(ctx.principal.workspaceId),
        ]);
        return {
          triggers: list.map(view),
          ai_keys: keys.map((k) => `${k.label} (${k.provider}, ${k.model})`),
          page: s.pageUrl,
          ...(keys.length
            ? {}
            : { hint: `No AI API key yet: do=ai needs one, added by the user on ${s.aiPageUrl}.` }),
        };
      },
    }),
    define({
      name: 'create_trigger',
      title: 'Create a trigger',
      description:
        'Creates a trigger: when a new message or email matches the filter, the hub does something. Prefer do=check for things the AI should handle (no cost until something matches) or do=notify; do=tool and do=ai make the hub act on its own and wait for the user’s confirmation. Returns a ready scheduled-task prompt for do=check.',
      input: z.object({
        name: z.string().trim().min(1).max(80).describe('Short name, e.g. "Invoices from Acme"'),
        when: z.enum(['message', 'mail']).describe('message: messengers (Telegram, WhatsApp…) · mail: email'),
        do: DO,
        ...ChangeFields,
      }),
      risk: 'write',
      hints: { openWorld: false },
      async assessRisk(input) {
        const reason = widens(undefined, toChange(input));
        return reason ? { risk: 'dangerous', reason, confirm: true } : undefined;
      },
      async run(input, ctx) {
        await ctx.admin.authorize(ctx.principal, 'admin');
        const s = service(ctx);
        const created = await s.create(ctx.principal, {
          ...toChange(input),
          name: input.name,
          when: input.when,
          do: input.do,
        });
        return {
          created: view(created),
          ...(created.do === 'check' ? { schedule: scheduleFor(created.name) } : {}),
          page: s.pageUrl,
        };
      },
    }),
    define({
      name: 'update_trigger',
      title: 'Change a trigger',
      description:
        'Changes a trigger: name, filter, accounts, action, daily limit, or turns it off and on (turning on also lifts a pause after the daily limit). Changes that let it act on its own wait for the user’s confirmation.',
      input: z.object({
        trigger: triggerRef,
        name: z.string().trim().min(1).max(80).optional(),
        when: z.enum(['message', 'mail']).optional(),
        do: DO.optional(),
        enabled: z.boolean().optional(),
        ...ChangeFields,
      }),
      risk: 'write',
      hints: { idempotent: true, openWorld: false },
      async assessRisk({ trigger, ...input }, ctx) {
        const before = await service(ctx)
          .find(ctx.principal.workspaceId, trigger)
          .catch(() => undefined);
        const reason = before ? widens(before, toChange(input)) : undefined;
        return reason ? { risk: 'dangerous', reason, confirm: true } : undefined;
      },
      async run({ trigger, ...input }, ctx) {
        await ctx.admin.authorize(ctx.principal, 'admin');
        const updated = await service(ctx).update(ctx.principal, trigger, toChange(input));
        return { updated: view(updated) };
      },
    }),
    define({
      name: 'delete_trigger',
      title: 'Delete a trigger',
      description:
        'Deletes a trigger and its history. To pause it instead, use manyplug_update_trigger with enabled false.',
      input: z.object({ trigger: triggerRef }),
      risk: 'write',
      hints: { destructive: true, idempotent: true, openWorld: false },
      async run({ trigger }, ctx) {
        await ctx.admin.authorize(ctx.principal, 'admin');
        const s = service(ctx);
        const found = await s.find(ctx.principal.workspaceId, trigger);
        await s.delete(ctx.principal.workspaceId, found.id);
        return { deleted: found.name };
      },
    }),
  ];
}
