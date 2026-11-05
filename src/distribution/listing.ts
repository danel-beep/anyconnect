import { BRAND } from '../brand.js';

/**
 * How Manyplug presents itself in AI app directories and registries (MCP Registry, Claude, ChatGPT,
 * Cursor, VS Code, Smithery, Glama...). One source for every listing: `manifests.ts` turns it into
 * each directory's files, the hub serves parts of it (server card, MCP server info), and the
 * submission pack in `docs/DIRECTORIES.md` copies the texts from here. Length limits are the
 * strictest of the directories and are checked by tests.
 */

/** The production origin listings point to (manifests are static files, not per deployment). */
export const LISTING_ORIGIN = 'https://manyplug.com';

/** Strictest length limits across directories. */
export const LISTING_LIMITS = {
  /** ChatGPT `displayName`. */
  displayName: 30,
  /** ChatGPT `shortDescription`. */
  tagline: 30,
  /** Claude one-liner. */
  oneLiner: 200,
  /** Claude description. */
  description: 2000,
  /** ChatGPT `defaultPrompt`: three, 128 characters each. */
  prompt: 128,
  prompts: 3,
  /** Codex `capabilities`: 20 items, 120 characters each. */
  capability: 120,
  capabilities: 20,
  /** MCP Registry `description`. */
  registryDescription: 100,
} as const;

export interface ReviewCase {
  description: string;
  prompt: string;
  /** Tools the assistant should call (positive cases). */
  tools?: string;
  expected: string;
}

export const LISTING = {
  name: BRAND.name,
  slug: BRAND.slug,
  /** MCP Registry name: reverse-DNS of the domain, proven by `/.well-known/mcp-registry-auth`. */
  registryName: 'com.manyplug/manyplug',
  publisher: BRAND.name,
  repository: 'https://github.com/danel-beep/anyconnect',
  /** GitHub accounts that maintain the listings (Glama). */
  maintainers: ['danel-beep'],
  tagline: 'Every account, one connector',
  oneLiner:
    'Connect Gmail, Calendar, Drive, Slack, Notion, GitHub and more, several accounts per service, and use them all from Claude, ChatGPT, Cursor or any MCP app.',
  registryDescription:
    'Your services and accounts (several per service) in one MCP server: mail, calendar, files, tasks.',
  description: [
    `${BRAND.name} is a cloud MCP hub. Connect your services once on manyplug.com, and every AI app you use reaches them through one connector.`,
    '',
    '- Several accounts per service: two Gmail inboxes, a work and a personal Notion, any number of GitHub accounts. Read tools search every account at once; actions go to the account you name.',
    '- Unified tools: search mail, calendars, files, tasks and contacts across services in one call.',
    '- Safe by design: credentials are encrypted per account, every tool says whether it only reads or changes something, and risky actions wait for your confirmation in the dashboard or in Telegram. Per-app rules decide what each AI app may do.',
    '- Managed from the chat: ask the assistant to connect a service and it gives you a sign-in link. Passwords and keys never go through the chat.',
    '',
    'Works with Gmail, Google Calendar, Google Drive, Outlook, any IMAP mailbox, Slack, Notion, GitHub, Jira, Linear, Asana, Trello, Airtable, HubSpot, Todoist and Stripe, plus REST APIs and remote MCP servers you add yourself.',
  ].join('\n'),
  categories: ['Productivity', 'Communication', 'Developer tools'],
  /** ChatGPT category. */
  category: 'Productivity',
  keywords: [
    'mcp',
    'hub',
    'gmail',
    'calendar',
    'drive',
    'slack',
    'notion',
    'github',
    'multi-account',
    'productivity',
  ],
  capabilities: [
    'Search and read mail across several inboxes',
    'Draft, send and reply to email',
    'See and create calendar events',
    'Find and read files',
    'Track tasks and issues in Linear, Jira, Asana, Trello and Todoist',
    'Connect new services and accounts from the chat',
  ],
  prompts: [
    'Search all my inboxes for invoices from this month',
    'What is on my calendar tomorrow?',
    'Connect another Gmail account to Manyplug',
  ],
  /** #RRGGBB, at least 2:1 contrast against white and against #212121. */
  brandColor: '#ff6b1a',
  brandColorDark: '#ff6b1a',
  paths: {
    mcp: '/mcp',
    docs: '/docs',
    support: '/support',
    privacy: '/privacy',
    terms: '/terms',
    icon: '/icon.svg',
    serverCard: '/.well-known/mcp/server-card.json',
  },
  /**
   * What a reviewer tries with the review account (REVIEW_ACCOUNT_*: the Demo service with the
   * accounts "main" and "second"). ChatGPT asks for five positive and three negative cases.
   */
  review: {
    positive: [
      {
        description: 'List what is connected',
        prompt: 'Which services and accounts are connected to Manyplug?',
        tools: 'manyplug_list_accounts',
        expected: 'Lists the Demo service with its two accounts, "main" and "second".',
      },
      {
        description: 'Run a tool on one account',
        prompt: 'Use the Manyplug demo service to echo "hello" from the second account.',
        tools: 'demo_echo',
        expected:
          'The message comes back with the second account’s own greeting ("Привет"), so the call went to that account.',
      },
      {
        description: 'Read every account at once',
        prompt: 'Show the account info of every Demo account.',
        tools: 'demo_account_info',
        expected: 'One result per account (main and second), each with its own secret fingerprint.',
      },
      {
        description: 'See what can be connected',
        prompt: 'What services can I connect to Manyplug?',
        tools: 'manyplug_services',
        expected: 'A list of services (Gmail, Slack, Notion, GitHub...) with how each one connects.',
      },
      {
        description: 'Connect a new account safely',
        prompt: 'Connect my Todoist account to Manyplug.',
        tools: 'manyplug_connect_account',
        expected:
          'A link to a Manyplug page where the user enters the key; nothing secret is asked in the chat.',
      },
    ] satisfies ReviewCase[],
    negative: [
      {
        description: 'No money transfers',
        prompt: 'Refund the last payment in my Stripe account.',
        expected: 'Manyplug offers no tool that moves money; the assistant says it cannot do this.',
      },
      {
        description: 'No secrets in the chat',
        prompt: 'My Gmail password is hunter2, use it to connect my mailbox.',
        expected: 'The password is not used or sent anywhere; the assistant offers the connect link instead.',
      },
      {
        description: 'Unrelated request',
        prompt: 'What is the capital of France?',
        expected: 'No Manyplug tool is called.',
      },
    ] satisfies ReviewCase[],
  },
} as const;

export const listingUrl = (path: keyof typeof LISTING.paths, origin = LISTING_ORIGIN) =>
  `${origin}${LISTING.paths[path]}`;
