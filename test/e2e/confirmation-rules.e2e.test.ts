import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from '../helpers.js';
import { AI_CLIENTS, type AiClientProfile, SimulatedAiClient, serveClientDocuments } from './ai-clients.js';
import { FakeInternet } from './fake-internet.js';
import { FakeGoogle, type GoogleUser } from './fakes/google.js';
import { allow, approveOnWeb, mailboxes, textOf } from './journey.js';

/**
 * The confirmation rules, end to end: the user sets them on the dashboard's Rules page, the AI
 * client calls Gmail (read: search, write: draft, dangerous: send), and the outcome is what the
 * rules say — it runs, asks first (in the chat for clients that can be asked, through a link for
 * the rest), waits out an undo window, or is not offered at all. Only the fake Google sees the
 * calls that ran.
 *
 * One row per rule combination; a new rule is a new row.
 */

type Tool = 'search' | 'draft' | 'send';
type Outcome = 'runs' | 'asks' | 'hidden' | 'undo';

type Setting =
  | { defaults: { confirm: 'never' | 'dangerous' | 'write' | 'always'; undo?: number } }
  | { app: 'self' | 'other'; access?: 'none' | 'read' | 'write' | 'full'; confirm?: Confirm }
  | { account: true; access?: 'none' | 'read' | 'write' | 'full'; confirm?: Confirm };
type Confirm = 'never' | 'dangerous' | 'write' | 'always';

interface Row {
  rules: string;
  set: Setting[];
  expect: Partial<Record<Tool, Outcome>>;
}

const ROWS: Row[] = [
  {
    rules: 'the defaults (ask before dangerous actions)',
    set: [],
    expect: { search: 'runs', draft: 'runs', send: 'asks' },
  },
  {
    rules: 'defaults: ask before any change',
    set: [{ defaults: { confirm: 'write' } }],
    expect: { search: 'runs', draft: 'asks', send: 'asks' },
  },
  { rules: 'defaults: always ask', set: [{ defaults: { confirm: 'always' } }], expect: { search: 'asks' } },
  { rules: 'defaults: never ask', set: [{ defaults: { confirm: 'never' } }], expect: { send: 'runs' } },
  {
    rules: 'defaults: never ask, with a 30 s undo window',
    set: [{ defaults: { confirm: 'never', undo: 30 } }],
    expect: { search: 'runs', draft: 'undo', send: 'undo' },
  },
  {
    rules: 'this app may only read',
    set: [{ app: 'self', access: 'read' }],
    expect: { search: 'runs', draft: 'hidden', send: 'hidden' },
  },
  {
    rules: 'this app may write but not do dangerous things',
    set: [{ app: 'self', access: 'write' }],
    expect: { draft: 'runs', send: 'hidden' },
  },
  {
    rules: 'another app may only read (this one is not affected)',
    set: [{ app: 'other', access: 'read' }],
    expect: { draft: 'runs', send: 'asks' },
  },
  {
    rules: 'this app always asks',
    set: [{ app: 'self', confirm: 'always' }],
    expect: { search: 'asks' },
  },
  {
    rules: 'the account never asks, over defaults that always ask',
    set: [{ defaults: { confirm: 'always' } }, { account: true, confirm: 'never' }],
    expect: { search: 'runs', send: 'runs' },
  },
  {
    rules: 'the account never asks, over this app always asking (the account rule is more specific)',
    set: [
      { app: 'self', confirm: 'always' },
      { account: true, confirm: 'never' },
    ],
    expect: { send: 'runs' },
  },
  {
    rules: 'the account is off limits',
    set: [{ account: true, access: 'none' }],
    expect: { search: 'hidden', send: 'hidden' },
  },
];

let serial = 0;
/** Arguments for a call; writes differ every time so duplicate protection does not merge them. */
const argsFor = (tool: Tool): Record<string, unknown> => {
  serial += 1;
  if (tool === 'search') return { query: 'PO-77' };
  if (tool === 'draft')
    return { to: ['dana@contoso.example'], subject: `Draft ${serial}`, body: 'Draft text' };
  return { to: ['dana@contoso.example'], subject: `Hello ${serial}`, body: 'Hello Dana' };
};
const TOOL_NAMES: Record<Tool, string> = {
  search: 'gmail_search',
  draft: 'gmail_create_draft',
  send: 'gmail_send',
};

describe.each(
  ['claude', 'claude-code'].map((id) => {
    const profile = AI_CLIENTS.find((c) => c.id === id)!;
    return [
      profile.elicitation ? `${id} (asks in the chat)` : `${id} (asks through a link)`,
      profile,
    ] as const;
  }),
)('confirmation rules from the dashboard: %s', (_name, profile: AiClientProfile) => {
  let hub: TestHub;
  let internet: FakeInternet;
  let google: FakeGoogle;
  let mailbox: GoogleUser;
  let browser: TestBrowser;
  let client: SimulatedAiClient;
  let workspaceId: string;
  let ids: { self: string; other: string; account: string };

  beforeAll(async () => {
    await resetDatabase();
    internet = new FakeInternet();
    google = new FakeGoogle().install(internet);
    serveClientDocuments(internet);
    mailbox = google.addUser({
      email: 'owner@northwind.example',
      hd: 'northwind.example',
      mailbox: mailboxes.work,
    });
    hub = await startTestHub({
      internet,
      seed: false,
      env: { ...google.env, CONFIRMATION_WAIT_SECONDS: '0' },
    });
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;

    browser = new TestBrowser(hub.baseUrl, internet.fetch);
    expect((await browser.login()).status).toBe(303);
    google.signedIn = mailbox;
    expect((await browser.walk('/connect/gmail?label=Work&name=work')).response.status).toBe(200);

    client = new SimulatedAiClient(profile, hub.mcpUrl);
    await client.connect(async (url) => {
      const { response } = await browser.walk(url);
      return allow(browser, response, profile);
    });
    const verified = await hub.services.oauth.verifyAccessToken(client.oauth.savedTokens!.access_token);
    const other = await hub.services.aiClients.ensure(workspaceId, {
      matchKey: 'app:chatgpt',
      name: 'ChatGPT',
      kind: 'oauth',
    });
    const account = (await hub.services.accounts.list(workspaceId)).find((a) => a.connectorId === 'gmail')!;
    ids = { self: verified!.aiClientId!, other: other.id, account: account.id };
  });

  beforeEach(async () => {
    // Back to the defaults between rows.
    await hub.services.database.pool.query('DELETE FROM access_rules');
    await hub.services.admin.updateSecurity(workspaceId, {
      defaultConfirm: 'dangerous',
      undoWindowSeconds: 0,
    });
    await hub.services.database.pool.query('DELETE FROM pending_calls');
  });

  afterAll(async () => {
    await client?.close();
    await hub?.close();
  });

  /** Sets one rule the way the user does: the Rules page and its forms. */
  async function apply(setting: Setting) {
    const page = await browser.request('/app/rules');
    expect(page.status).toBe(200);
    const { csrf } = TestBrowser.hiddenInputs(await page.text());
    let response: Response;
    if ('defaults' in setting) {
      response = await browser.request('/app/rules/defaults', {
        form: { csrf: csrf!, confirm: setting.defaults.confirm, undo: String(setting.defaults.undo ?? 0) },
      });
    } else {
      const target =
        'app' in setting ? { kind: 'app', id: ids[setting.app] } : { kind: 'account', id: ids.account };
      response = await browser.request('/app/rules/scoped', {
        form: { csrf: csrf!, ...target, access: setting.access ?? '', confirm: setting.confirm ?? '' },
      });
    }
    expect(response.status, await response.clone().text()).toBe(303);
  }

  /** What happened when the AI called the tool, judged from the result and from Gmail's side. */
  async function outcomeOf(tool: Tool): Promise<Outcome> {
    const name = TOOL_NAMES[tool];
    const args = argsFor(tool);
    const listed = (await client.mcp.listTools()).tools.some((t) => t.name === name);
    if (!listed) {
      // Not offered, and refused when called anyway (a stale tool list).
      const stale = await client.call(name, args).catch((error: Error) => ({ isError: true, error }));
      expect(stale.isError).toBe(true);
      return 'hidden';
    }
    const before = internet.requestsTo('gmail.googleapis.com').length;
    const asked = client.questions.length;
    // In the chat the user declines, so an action that asks never runs.
    if (profile.elicitation) client.answers.push('decline');
    const result = await client.call(name, args);
    client.answers.length = 0;
    const text = textOf(result);
    const reachedGmail = internet.requestsTo('gmail.googleapis.com').length > before;
    if (client.questions.length > asked) {
      expect(text).toContain('declined');
      expect(reachedGmail).toBe(false);
      return 'asks';
    }
    if (text.includes('/confirm/pcl_') && text.includes('confirmation')) {
      expect(reachedGmail).toBe(false);
      return 'asks';
    }
    if (/will run in \d+ s/.test(text)) {
      expect(reachedGmail).toBe(false);
      return 'undo';
    }
    expect(result.isError, text).toBeFalsy();
    expect(reachedGmail, text).toBe(true);
    return 'runs';
  }

  it.each(ROWS.map((row) => [row.rules, row] as const))('%s', async (_rules, row) => {
    for (const setting of row.set) await apply(setting);
    const actual: Partial<Record<Tool, Outcome>> = {};
    for (const tool of Object.keys(row.expect) as Tool[]) actual[tool] = await outcomeOf(tool);
    expect(actual).toEqual(row.expect);
  });

  it('runs an action the user approved on the web page exactly once, also for a client that can ask', async () => {
    await apply({ defaults: { confirm: 'always' } });
    const sentBefore = mailbox.sent.length;
    if (profile.elicitation) client.answers.push('cancel');
    const args = argsFor('send');
    const first = await client.call('gmail_send', args);
    client.answers.length = 0;
    if (profile.elicitation) {
      // Dismissed in the chat: the action is not run, and nothing is left waiting.
      expect(textOf(first)).toMatch(/declined|cancel/);
      expect(mailbox.sent).toHaveLength(sentBefore);
      return;
    }
    await approveOnWeb(browser, textOf(first));
    await hub.services.pendingRunner.tick();
    expect(mailbox.sent).toHaveLength(sentBefore + 1);
    const result = await client.call('gmail_send', args);
    expect(result.isError).toBeFalsy();
    expect(mailbox.sent).toHaveLength(sentBefore + 1);
  });
});
