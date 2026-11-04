import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from '../helpers.js';
import { AI_CLIENTS, SimulatedAiClient, serveClientDocuments } from './ai-clients.js';
import { FakeInternet } from './fake-internet.js';
import { decodeSent, FakeGoogle, type GoogleUser } from './fakes/google.js';
import { approveOnWeb, isAppRedirect, mailboxes, signInWithGoogle, textOf } from './journey.js';

/**
 * A new user's first connection, end to end and in order, against fake Google services:
 * Claude adds the hub → the user signs up with Google in the sign-in window → allows access →
 * connects two Gmail mailboxes from the chat → Claude searches them, sends an email that waits for
 * the user's confirmation, and keeps working when Google's access token expires or is revoked.
 *
 * Every step runs production code: the official MCP client, the hub's OAuth server and consent
 * screen, Google sign-in, the provider OAuth flow, the Gmail connector and the executor stages.
 * Only the internet is fake.
 */
describe('first connection: Claude, Google sign-up and Gmail', () => {
  let hub: TestHub;
  let internet: FakeInternet;
  let google: FakeGoogle;
  let browser: TestBrowser;
  let claude: SimulatedAiClient;
  let personal: GoogleUser;
  let work: GoogleUser;

  beforeAll(async () => {
    await resetDatabase();
    internet = new FakeInternet();
    google = new FakeGoogle().install(internet);
    serveClientDocuments(internet);
    personal = google.addUser({
      email: 'alex.morgan@gmail.com',
      name: 'Alex Morgan',
      mailbox: mailboxes.personal,
    });
    work = google.addUser({
      email: 'alex@northwind.example',
      name: 'Alex Morgan',
      hd: 'northwind.example',
      mailbox: mailboxes.work,
    });
    hub = await startTestHub({
      internet,
      seed: false,
      env: { ...google.env, CONFIRMATION_WAIT_SECONDS: '0' },
    });
    browser = new TestBrowser(hub.baseUrl, internet.fetch);
    claude = new SimulatedAiClient(AI_CLIENTS.find((c) => c.id === 'claude')!, hub.mcpUrl);
  });

  afterAll(async () => {
    await claude?.close();
    await hub?.close();
  });

  it('adds the hub to Claude: the user signs up with Google in the sign-in window and allows access', async () => {
    google.signedIn = personal;
    await claude.connect(async (authorizationUrl) => {
      // The hub identifies Claude by its metadata document (claude.ai), not by a registration.
      expect(authorizationUrl.searchParams.get('client_id')).toBe(
        'https://claude.ai/oauth/mcp-oauth-client-metadata',
      );
      const consent = await signInWithGoogle(browser, authorizationUrl);
      const page = await consent.text();
      expect(page).toContain('Claude');
      const hidden = TestBrowser.hiddenInputs(page);
      const allowed = await browser.request('/oauth/authorize', { form: { ...hidden, decision: 'approve' } });
      expect(allowed.status).toBe(303);
      const callback = new URL(allowed.headers.get('location')!);
      expect(isAppRedirect(callback, claude.profile)).toBe(true);
      expect(callback.searchParams.get('iss')).toBe(hub.baseUrl);
      return callback;
    });
    expect(internet.requestsTo('claude.ai', '/oauth/mcp-oauth-client-metadata')).toHaveLength(1);

    // A new user and workspace, signed in through Google; the grant belongs to the AI client "Claude".
    const user = await hub.services.db.query.users.findFirst({
      where: (u, { eq }) => eq(u.email, personal.email),
    });
    expect(user).toBeDefined();
    const [workspace] = await hub.services.users.ownedWorkspaces(user!.id);
    const clients = await hub.services.aiClients.list(workspace!.id);
    expect(clients.map((c) => c.name)).toEqual(['Claude']);
  });

  it('starts with the setup tools only, and tells Claude how to connect a service', async () => {
    const names = await claude.toolNames();
    expect(names.every((n) => n.startsWith('manyplug_'))).toBe(true);
    expect(names).toEqual(expect.arrayContaining(['manyplug_services', 'manyplug_connect_account']));
    expect(claude.mcp.getInstructions()).toContain('manyplug_connect_account');

    const services = await claude.call('manyplug_services');
    expect(services.isError).toBeFalsy();
    expect(services.structuredContent).toMatchObject({
      services: expect.arrayContaining([
        expect.objectContaining({ service: 'gmail', connect: 'oauth', ready: true }),
      ]),
    });
  });

  it('connects a Gmail mailbox from the chat: a link, Google consent, and the account appears', async () => {
    const link = await claude.call('manyplug_connect_account', { service: 'gmail', label: 'Personal' });
    expect(link.isError).toBeFalsy();
    const url = (link.structuredContent as { url: string }).url;
    expect(url).toMatch(new RegExp(`^${hub.baseUrl}/connect/gmail\\?`));

    await connectMailbox(url, personal);
    const names = await claude.toolNames();
    expect(names).toEqual(expect.arrayContaining(['gmail_search', 'gmail_read', 'gmail_send']));
    const search = (await claude.mcp.listTools()).tools.find((t) => t.name === 'gmail_search')!;
    expect(search.annotations?.readOnlyHint).toBe(true);
    // One mailbox: `account` is optional and the description names the mailbox.
    expect(search.inputSchema.required ?? []).not.toContain('account');
    const send = (await claude.mcp.listTools()).tools.find((t) => t.name === 'gmail_send')!;
    expect(send.annotations?.readOnlyHint).toBe(false);
  });

  it('searches the mailbox through Gmail with the account’s own token, marking mail as untrusted', async () => {
    internet.clear();
    const result = await claude.call('gmail_search', { query: 'invoice' });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('Invoice INV-2041');
    expect(text).not.toContain('Team offsite');
    expect(text).toMatch(/⟦untrusted [0-9a-f]{8} source="Gmail · /);

    const calls = internet.requestsTo('gmail.googleapis.com');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((r) => r.headers.get('authorization')?.startsWith('Bearer ya29.'))).toBe(true);
    expect(internet.unrouted).toEqual([]);
  });

  it('adds a second mailbox of another Google account; reads go to both, tagged by account', async () => {
    const link = await claude.call('manyplug_connect_account', {
      service: 'gmail',
      label: 'Work',
      name: 'work',
    });
    await connectMailbox((link.structuredContent as { url: string }).url, work);

    const search = (await claude.mcp.listTools()).tools.find((t) => t.name === 'gmail_search')!;
    const account = (search.inputSchema.properties as Record<string, { enum?: string[] }>).account!;
    expect(account.enum).toEqual(expect.arrayContaining(['work', 'all']));
    expect(account.enum).toHaveLength(3);

    const both = await claude.call('gmail_search', { query: 'invoice' });
    const text = textOf(both);
    expect(text).toContain('INV-2041');
    expect(text).toContain('PO-77');
    const one = await claude.call('gmail_search', { account: 'work', query: 'invoice' });
    expect(textOf(one)).toContain('PO-77');
    expect(textOf(one)).not.toContain('INV-2041');
  });

  it('holds an email until the user confirms it, then sends it exactly once', async () => {
    const args = {
      account: 'work',
      to: ['dana@contoso.example'],
      subject: 'Q3 numbers',
      body: 'Hi Dana, the Q3 numbers are attached.',
    };
    const held = await claude.call('gmail_send', args);
    expect(textOf(held)).toContain('waiting for the user’s confirmation');
    expect(work.sent).toHaveLength(0);

    await approveOnWeb(browser, textOf(held));
    await hub.services.pendingRunner.tick();
    expect(work.sent).toHaveLength(1);
    expect(decodeSent(work.sent[0]!.raw)).toContain('To: dana@contoso.example');
    expect(decodeSent(work.sent[0]!.raw)).toContain('Subject: Q3 numbers');

    // Claude asks again (as instructed) and gets the result; nothing is sent twice.
    const done = await claude.call('gmail_send', args);
    expect(done.isError).toBeFalsy();
    expect(textOf(done)).toContain('sent');
    expect(work.sent).toHaveLength(1);
    expect(personal.sent).toHaveLength(0);
  });

  it('refreshes an expired Google access token without the user noticing', async () => {
    google.expireAccessTokens();
    internet.clear();
    const result = await claude.call('gmail_search', { account: 'work', query: 'PO-77' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('PO-77');
    const refreshed = internet
      .requestsTo('oauth2.googleapis.com', '/token')
      .filter((r) => new URLSearchParams(r.body).get('grant_type') === 'refresh_token');
    expect(refreshed.length).toBeGreaterThanOrEqual(1);
  });

  it('asks the user to reconnect when access was revoked at Google, and the other mailbox keeps working', async () => {
    google.revokeUser(work);
    const failed = await claude.call('gmail_search', { account: 'work', query: 'PO-77' });
    expect(failed.isError).toBe(true);
    // The AI gets a link that repairs this account, to hand to the user.
    const link = /give them this link (\S+)/.exec(textOf(failed))?.[1];
    expect(link, textOf(failed)).toMatch(new RegExp(`^${hub.baseUrl}/connect/gmail\\?account=acc_`));
    expect(textOf(failed)).not.toContain('..');

    const both = await claude.call('gmail_search', { query: 'invoice' });
    expect(both.isError).toBeFalsy();
    expect(textOf(both)).toContain('INV-2041');

    // Reconnecting through the link repairs the same account in place.
    const user = (await hub.services.db.query.users.findFirst({
      where: (u, { eq }) => eq(u.email, personal.email),
    }))!;
    const [workspace] = await hub.services.users.ownedWorkspaces(user.id);
    expect((await hub.services.accounts.list(workspace!.id)).find((a) => a.name === 'work')!.status).toBe(
      'needs_reauth',
    );
    await connectMailbox(link!, work);
    const again = await claude.call('gmail_search', { account: 'work', query: 'PO-77' });
    expect(again.isError).toBeFalsy();
    const accounts = await hub.services.accounts.list(workspace!.id);
    expect(accounts.filter((a) => a.connectorId === 'gmail')).toHaveLength(2);
    expect(accounts.find((a) => a.name === 'work')!.status).toBe('active');
  });

  /** The user opens a connect link in the signed-in browser and approves at Google as `as`. */
  async function connectMailbox(url: string, as: GoogleUser) {
    google.signedIn = as;
    const { response, url: landed } = await browser.walk(url);
    expect(response.status, `${landed} ${await response.clone().text()}`).toBe(200);
    expect(landed.origin).toBe(hub.baseUrl);
    const page = await response.text();
    expect(page).toContain(as.email);
  }
});
