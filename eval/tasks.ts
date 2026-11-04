import { expect } from 'vitest';
import { outbox } from './fixtures.js';
import { data, type Session } from './harness.js';

/**
 * Tasks a user really asks for. Each has the prompt (what a live run would give a model), the call
 * budget the hub must make possible, a scripted solution (how a model following the hub's
 * instructions solves it) and a check of the outcome.
 */
export interface EvalTask {
  id: string;
  prompt: string;
  maxCalls: number;
  solve(s: Session): Promise<void>;
  /** Checks the end state (outbox) for a live run; scripted solutions also assert inline. */
  check(): void;
}

const nothing = () => {};

export const TASKS: EvalTask[] = [
  {
    id: 'invoice-all-mailboxes',
    prompt: 'Find the invoice from ACME in all my mailboxes.',
    maxCalls: 1,
    async solve(s) {
      const result = data(await s.use('mail_search', { query: 'invoice' }, 'search email invoice'));
      const items = result.items as Array<{ account: string; subject: string }>;
      expect(items.some((i) => i.account === 'gmail:work' && i.subject.includes('#1042'))).toBe(true);
      expect(items.some((i) => i.account === 'outlook:corp')).toBe(true);
    },
    check: nothing,
  },
  {
    id: 'unread-messengers',
    prompt: 'What unread chats do I have in my messengers?',
    maxCalls: 1,
    async solve(s) {
      const result = data(await s.use('messages_list_chats', { unread_only: true }, 'unread chats messages'));
      const accounts = new Set((result.items as Array<{ account: string }>).map((i) => i.account));
      expect([...accounts].sort()).toEqual([
        'slack:company',
        'telegram:main',
        'telegram:shop',
        'whatsapp:personal',
      ]);
    },
    check: nothing,
  },
  {
    id: 'invoice-to-telegram',
    prompt: 'Find the ACME invoice email and send its number to Ivan Petrov on my personal Telegram.',
    maxCalls: 3,
    async solve(s) {
      const found = data(
        await s.use('mail_search', { query: 'invoice', from: 'acme' }, 'search email invoice'),
      );
      const subject = (found.items as Array<{ subject: string }>)[0]?.subject ?? '';
      expect(subject).toContain('#1042');
      await s.use(
        'messages_send',
        { account: 'telegram:main', chat: 'tg_ivan', text: 'The ACME invoice is #1042.' },
        'send telegram message',
      );
    },
    check() {
      expect(outbox).toContainEqual(
        expect.objectContaining({ service: 'telegram', account: 'main', action: 'send' }),
      );
    },
  },
  {
    id: 'meetings-tomorrow',
    prompt: 'What meetings do I have on 2026-11-05 across my calendars?',
    maxCalls: 1,
    async solve(s) {
      const result = data(
        await s.use(
          'calendar_list_events',
          { from: '2026-11-05T00:00:00Z', to: '2026-11-05T23:59:59Z' },
          'calendar events meetings',
        ),
      );
      expect((result.items as Array<{ title: string }>).map((e) => e.title)).toEqual([
        'Standup',
        'Security training',
        'Call with ACME',
      ]);
    },
    check: nothing,
  },
  {
    id: 'tasks-this-week',
    prompt: 'Which open tasks are due before 2026-11-09 in all my trackers?',
    maxCalls: 1,
    async solve(s) {
      const result = data(await s.use('tasks_list', { due_before: '2026-11-09' }, 'list open tasks due'));
      expect((result.items as Array<{ id: string }>).map((t) => t.id)).toEqual(['LIN-12', 'CL-3']);
    },
    check: nothing,
  },
  {
    id: 'stripe-refund',
    prompt: 'Refund the latest charge in my main Stripe account.',
    maxCalls: 3,
    async solve(s) {
      const charges = data(
        await s.use('stripe_list_charges', { account: 'main', limit: '1' }, 'stripe charges payments'),
      );
      const charge = (charges.items as Array<{ id: string }>)[0]!.id;
      await s.use('stripe_refund_charge', { account: 'main', charge }, 'stripe refund charge');
    },
    check() {
      expect(outbox).toContainEqual(expect.objectContaining({ service: 'stripe', action: 'refund_charge' }));
    },
  },
  {
    id: 'morning-dev-check',
    prompt: 'Show my GitHub notifications, unresolved Sentry issues and recent Vercel deployments.',
    maxCalls: 3,
    async solve(s) {
      const result = data(
        await s.batch([
          { tool: 'github_list_notifications', args: {}, searchQuery: 'github notifications' },
          { tool: 'sentry_list_issues', args: {}, searchQuery: 'sentry errors issues' },
          { tool: 'vercel_list_deployments', args: {}, searchQuery: 'vercel deployments' },
        ]),
      );
      expect((result.results as Array<{ ok: boolean }>).every((r) => r.ok)).toBe(true);
    },
    check: nothing,
  },
  {
    id: 'reply-on-same-account',
    prompt: 'Customer Anna asked about order #55 in the shop Telegram. Reply that it ships tomorrow.',
    maxCalls: 2,
    async solve(s) {
      const found = data(await s.use('messages_search', { query: 'order #55' }, 'search messages'));
      const hit = (found.items as Array<{ account: string; chat_id: string }>).find(
        (i) => i.account === 'telegram:shop',
      )!;
      expect(hit).toBeDefined();
      await s.use(
        'messages_send',
        { account: hit.account, chat: hit.chat_id, text: 'Your order ships tomorrow.' },
        'send telegram message',
      );
    },
    check() {
      expect(outbox).toContainEqual(
        expect.objectContaining({ service: 'telegram', account: 'shop', action: 'send' }),
      );
    },
  },
];

/** Natural-language queries and the tool `anyconnect_search_tools` must rank in the top 3. */
export const SEARCH_CASES: Array<[query: string, tool: string | string[]]> = [
  ['send an email', 'mail_send'],
  ['find emails from my boss', 'mail_search'],
  ['reply to a whatsapp message', ['messages_send', 'whatsapp_send']],
  ['unread telegram chats', 'messages_list_chats'],
  ['refund a payment', 'stripe_refund_charge'],
  ['unpaid invoices stripe', 'stripe_list_invoices'],
  ['merge pull request', 'github_merge_pull_request'],
  ['create a github issue', 'github_create_issue'],
  ['weather tomorrow in Berlin', 'openweather_forecast'],
  ['schedule a meeting', 'calendar_create_event'],
  ['add a todo', 'tasks_create'],
  ['find a document in drive', 'gdrive_search_files'],
  ['notion page', 'notion_search_pages'],
  ['deals pipeline crm', 'hubspot_list_deals'],
  ['shopify orders', 'shopify_list_orders'],
  ['ozon returns', 'ozon_list_returns'],
  ['production errors', 'sentry_list_issues'],
  ['deploy status', 'vercel_list_deployments'],
  ['mark chat as read', 'telegram_mark_read'],
  ['complete task in linear', 'linear_complete_task'],
];
