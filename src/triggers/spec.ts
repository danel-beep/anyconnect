import { z } from 'zod';
import type { TriggerActionKind, TriggerSource } from '../db/schema.js';

/**
 * What a trigger is: "when [an event of the source matches the filter], do [the action]". The
 * definition is stored encrypted (it names people, words and prompts); only the source, the
 * accounts and the kind of action are plain columns for lookups (see `docs/TRIGGERS.md`).
 */

export const TRIGGER_SOURCES = ['message', 'mail'] as const satisfies readonly TriggerSource[];
export const TRIGGER_ACTIONS = [
  'check',
  'notify',
  'tool',
  'ai',
] as const satisfies readonly TriggerActionKind[];

/** The default the user can change: generous enough not to get in the way, low enough to stop a loop. */
export const DEFAULT_DAILY_RUNS = 200;
export const MAX_DAILY_RUNS = 100_000;
/** Tools a woken AI may be given at most (a narrow list is the point). */
export const MAX_AI_TOOLS = 20;

const words = (what: string) =>
  z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe(
      `${what}; several alternatives separated by commas, any of them matches (case does not matter)`,
    );

/** Every field that is set must match; an empty filter matches every event of the source. */
export const TriggerFilter = z.object({
  from: words('Sender name, @username, phone or email contains'),
  chat: words('Chat or group title contains (messages only)'),
  subject: words('Email subject contains (mail only)'),
  text: words('Message text or email subject and preview contains'),
});
export type TriggerFilter = z.output<typeof TriggerFilter>;

/** Tools and arguments named in limits: at most this many of each, and of values per argument. */
export const MAX_LIMIT_VALUES = 50;

/** `{ tool: { argument: [allowed values] } }`; numbers are taken as their text (chat ids). */
export const ArgumentLimitsInput = z.record(
  z.string().trim().min(1).max(100),
  z.record(
    z.string().trim().min(1).max(100),
    z
      .array(z.union([z.string().trim().min(1).max(300), z.number()]).transform(String))
      .min(1)
      .max(MAX_LIMIT_VALUES),
  ),
);

export const CheckAction = z.object({
  kind: z.literal('check'),
  /** What the AI app that checks should do with a match, handed back with each event. */
  task: z.string().trim().max(1000).optional(),
});
export const NotifyAction = z.object({ kind: z.literal('notify') });
export const ToolAction = z.object({
  kind: z.literal('tool'),
  /** A tool of the catalog, e.g. `telegram_send`. */
  tool: z.string().trim().min(1).max(100),
  /** Its arguments; strings may use `{{from}}`, `{{text}}`, `{{chat}}`… (see {@link TEMPLATE_FIELDS}). */
  args: z.record(z.string(), z.unknown()).default({}),
});
export const AiAction = z.object({
  kind: z.literal('ai'),
  /** What the AI should do with the event, in the user's words. */
  instructions: z.string().trim().min(1).max(4000),
  /** The only tools it may call (empty: it can only answer, e.g. for a notification). */
  tools: z.array(z.string().trim().min(1).max(100)).max(MAX_AI_TOOLS).default([]),
  /** Sending, deleting and other risky actions wait for the user's confirmation. */
  confirmRisky: z.boolean().default(true),
  /** Send the AI's final answer to the user (Telegram). */
  notify: z.boolean().default(true),
  /** Only these argument values, checked by the hub (see `ArgumentLimits`). */
  allow: ArgumentLimitsInput.optional(),
});
export const TriggerAction = z.discriminatedUnion('kind', [CheckAction, NotifyAction, ToolAction, AiAction]);
export type TriggerAction = z.output<typeof TriggerAction>;

export const TriggerSpec = z.object({ filter: TriggerFilter, action: TriggerAction });
export type TriggerSpec = z.output<typeof TriggerSpec>;

/** One event as triggers see it: a new incoming message or email. */
export interface TriggerItem {
  source: TriggerSource;
  /** Connector id, e.g. `telegram`. */
  service: string;
  /** The account's name, as the service's tools take it in `account`. */
  account: string;
  /** The item's id for the service's tools (message or email id). */
  id: string;
  /** Chat id (messages), for replying with `<service>_send`. */
  chat?: string;
  chatTitle?: string;
  from?: string;
  subject?: string;
  /** Message text, or the email's preview. */
  text: string;
  /** ISO time it was sent. */
  at: string;
}

/** Placeholders an action can use, with what they become. */
export const TEMPLATE_FIELDS = {
  from: 'who sent it',
  text: 'message text or email preview',
  chat: 'chat id (reply here)',
  chat_title: 'chat title',
  subject: 'email subject',
  id: 'message or email id',
  account: 'the account name, for the service’s tools',
  service: 'the service id',
} as const;

/** Who or what the item came from, as one string (loop protection groups events by it). */
export function counterpartOf(item: TriggerItem): string {
  return `${item.service}:${item.account}|${item.chat ?? item.from ?? ''}`;
}
