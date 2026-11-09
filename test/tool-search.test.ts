import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../src/connectors/index.js';
import type { AccountRow } from '../src/core/accounts.js';
import { buildCatalog } from '../src/hub/catalog.js';
import { searchTools } from '../src/hub/discovery.js';
import { SETUP_CONNECTOR } from '../src/hub/setup-tools.js';

/**
 * Tool search over the real built-in connectors and the hub's own setup tools, with requests the
 * way people phrase them in a chat ("what meetings do I have this week"). In discovery mode this
 * search is how the model finds almost every tool, so a miss costs a wasted call or a wrong one.
 * (`eval/efficiency.test.ts` checks the same ranking on a synthetic catalog.)
 */
const registry = createBuiltinRegistry();

function catalogFor(services: string[]) {
  const now = new Date();
  const accounts: AccountRow[] = services.flatMap((connectorId) =>
    ['personal', 'work'].map((name) => ({
      id: `acc_${connectorId}_${name}`,
      workspaceId: 'wsp_1',
      connectorId,
      name,
      label: `${connectorId} ${name}`,
      description: null,
      config: {},
      dataKeyEncrypted: null,
      credentialsEncrypted: null,
      enabled: true,
      status: 'active' as const,
      statusMessage: null,
      settings: {},
      metadata: {},
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      ownerUserId: null,
      checkedAt: null,
      reauthNotifiedAt: null,
    })),
  );
  return buildCatalog({ connectors: registry.all(), accounts, setup: SETUP_CONNECTOR });
}

type Case = [query: string, accepted: string | string[]];

function expectTop(catalog: ReturnType<typeof catalogFor>, [query, accepted]: Case, top: number) {
  const found = searchTools(catalog.tools, query, { limit: top }).map((t) => t.name);
  const ok = Array.isArray(accepted) ? accepted : [accepted];
  expect(
    found.filter((name) => ok.includes(name)),
    `"${query}" → ${found.join(', ')}`,
  ).not.toHaveLength(0);
}

describe('tool search: one mailbox, one calendar, one messenger', () => {
  // A typical personal setup: no unified tools (each capability has one service), plus setup tools.
  const catalog = catalogFor(['gmail', 'gcal', 'telegram']);

  const firstHit: Case[] = [
    ['what meetings do I have this week', 'gcal_list_events'],
    ["what's on my calendar tomorrow", 'gcal_list_events'],
    ['unread emails', 'gmail_search'],
    ['reply to the last email from John', 'gmail_reply'],
    ['archive the newsletters', 'gmail_modify'],
    ['delete spam emails', 'gmail_trash'],
    ['draft an email to Maria', 'gmail_create_draft'],
    ['forward the invoice to accounting', 'gmail_forward'],
    ['move the call with Anna to 5pm', 'gcal_update_event'],
    ['cancel my dentist appointment', 'gcal_delete_event'],
    ['am I free on Friday afternoon', 'gcal_free_busy'],
    ['send a message to Anna on telegram', 'telegram_send'],
    ['new telegram messages', 'telegram_whats_new'],
    ['connect another gmail account', 'manyplug_connect_account'],
    ['when an email from my boss arrives, ping me on telegram', 'manyplug_create_trigger'],
  ];
  it.each(firstHit)('"%s" → %s first', (query, accepted) => expectTop(catalog, [query, accepted], 1));

  const top3: Case[] = [
    ['who wrote me today', ['telegram_whats_new', 'gmail_search', 'telegram_search']],
    ['download the attachment from that email', ['gmail_read']],
    ['create a meeting with Bob tomorrow at 3pm', ['gcal_create_event', 'gcal_quick_add']],
    ['did Anna answer me', ['telegram_wait_for_reply', 'telegram_read_chat', 'telegram_whats_new']],
    ['ask before sending emails', ['manyplug_set_rule']],
  ];
  it.each(top3)('"%s" → %s in the top 3', (query, accepted) => expectTop(catalog, [query, accepted], 3));

  it('never offers hub setup tools for an everyday task about mail or meetings', () => {
    for (const query of ['what meetings do I have this week', 'who wrote me today', 'unread emails']) {
      const found = searchTools(catalog.tools, query, { limit: 3 }).map((t) => t.name);
      expect(
        found.filter((name) => name.startsWith('manyplug_')),
        `"${query}" → ${found.join(', ')}`,
      ).toEqual([]);
    }
  });
});

describe('tool search: every built-in service connected', () => {
  const catalog = catalogFor(registry.all().map((c) => c.id));

  const top3: Case[] = [
    ['what meetings do I have this week', 'calendar_list_events'],
    ['unread emails', 'mail_search'],
    ['send an email to Maria', 'mail_send'],
    ['who wrote me today', ['messages_search', 'mail_search', 'telegram_whats_new', 'whatsapp_whats_new']],
    ['post in the slack channel', ['slack_send_message', 'messages_send']],
    ['open pull requests', 'github_list_pull_requests'],
    ['failed vercel deployments', 'vercel_list_deployments'],
    ['refund the last payment', 'stripe_create_refund'],
    ['add a row to the spreadsheet', 'gsheets_append_rows'],
    ['schedule a zoom call', 'zoom_create_meeting'],
    ['open support tickets', ['zendesk_search_tickets', 'freshdesk_list_tickets']],
    ['mark the todoist task done', 'todoist_complete_task'],
    ['deals in the pipeline', ['hubspot_search_deals', 'pipedrive_search_deals', 'pipedrive_list_deals']],
    ['find a file in google drive', ['gdrive_search', 'files_search']],
    ['my open PRs', 'github_list_pull_requests'],
    ['assign the bug to Bob', 'github_update_issue'],
    ['customers who paid this month', 'stripe_search_payments'],
    ['how much money do we have', 'stripe_get_balance'],
    ['new lead in the crm', ['hubspot_create_contact', 'hubspot_search_contacts', 'contacts_search', 'hubspot_search_deals']],
  ];
  it.each(top3)('"%s" → %s in the top 3', (query, accepted) => expectTop(catalog, [query, accepted], 3));
});

describe('discovery listing of a new workspace', () => {
  it("lists each service's entry read before hub setup tools, so a first task needs no search", () => {
    const catalog = catalogFor(['gmail', 'gcal', 'telegram']);
    expect(catalog.listing).toBe('discovery');
    const names = catalog.listed.map((t) => t.name);
    for (const name of ['gmail_search', 'gcal_list_events', 'telegram_list_chats'])
      expect(names).toContain(name);
    const firstSetup = names.findIndex(
      (n) => catalog.tools.find((t) => t.name === n)?.target.kind === 'workspace',
    );
    expect(firstSetup).toBeGreaterThan(names.indexOf('gcal_list_events'));
    expect(catalog.stats.listedTokens).toBeLessThanOrEqual(catalog.stats.budget);
  });

  it('skips a service entry read when a unified tool already covers it', () => {
    const catalog = catalogFor(['gmail', 'outlook', 'gcal']);
    const names = catalog.listed.map((t) => t.name);
    expect(names).toContain('mail_search');
    expect(names).not.toContain('gmail_search');
    expect(names).not.toContain('outlook_search');
  });
});
