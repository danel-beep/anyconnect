import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startTestHub, TestBrowser, type TestHub } from '../helpers.js';
import { type LoggedQuery, recordQueries } from './query-log.js';

/**
 * What the performance tests put the hub through: every signed-in page (found by following links
 * from the dashboard, so a new page is covered without touching the tests) and the MCP requests an
 * AI app makes. Each request is measured on its second run, with caches warm.
 */

/** Links that are not pages (as in the visual test), plus downloads. */
const SKIP =
  /^\/(assets|auth|logout|prefs|oauth|billing|mcp|api|\.well-known)\b|\.(xml|txt|json|png|svg|ico)$|^\/connect\/callback|\/(export|download)\b/;
const WITHIN = /^\/(app|security|confirm)\b/;
/** REST API reads that list what grows with use (the API itself has no links to follow). */
const REST_READS = ['/me', '/accounts', '/services', '/usage', '/tools', '/tool-calls', '/grants', '/tokens'];

/** One page per URL shape (`/app/accounts/<id>` once), as in the visual test. */
function shape(url: string): string {
  const [path = '', query = ''] = url.split('?');
  const parts = path.split('/').filter(Boolean);
  const fixed = parts[0] === 'app' ? 2 : 1;
  const tab = new URLSearchParams(query).get('tab');
  return `/${parts.map((p, i) => (i < fixed ? p : '*')).join('/')}${tab ? `?tab=${tab}` : ''}`;
}

export interface Workload {
  hub: TestHub;
  browser: TestBrowser;
  mcp: Client;
  /** A personal token of the owner (REST API and MCP). */
  token: string;
  /** Statements of a request on its second run. */
  measure(request: () => Promise<unknown>): Promise<LoggedQuery[]>;
  /** Every signed-in page by URL shape, with the statements it sent. */
  pages(): Promise<Map<string, LoggedQuery[]>>;
  /** The MCP requests of an AI app and the REST API reads, with the statements each sent. */
  apiRequests(): Promise<Map<string, LoggedQuery[]>>;
  close(): Promise<void>;
}

/** A test hub with its owner signed in on the site and an AI app connected over MCP. */
export async function startWorkload(): Promise<Workload> {
  const hub = await startTestHub();
  const workspace = (await hub.services.db.query.workspaces.findFirst())!;
  const user = (await hub.services.db.query.users.findFirst())!;
  const { token } = await hub.services.apiTokens.create({
    workspaceId: workspace.id,
    userId: user.id,
    name: 'perf',
    scopes: ['mcp', 'api'],
  });
  const browser = new TestBrowser(hub.baseUrl);
  await browser.login();
  const mcp = new Client({ name: 'perf', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(hub.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  await mcp.callTool({ name: 'demo_echo', arguments: { text: 'warm up' } });

  const measure = async (request: () => Promise<unknown>): Promise<LoggedQuery[]> => {
    await request();
    return (await recordQueries(hub.services.database, request)).queries;
  };

  return {
    hub,
    browser,
    mcp,
    token,
    measure,
    async pages() {
      const found = new Map<string, LoggedQuery[]>();
      const queue = ['/app', '/security', '/confirm'];
      while (queue.length > 0 && found.size < 80) {
        const path = queue.shift()!;
        const key = shape(path);
        if (found.has(key)) continue;
        let html = '';
        const queries = await measure(async () => {
          const response = await browser.request(path);
          const page = response.status < 300 && response.headers.get('content-type')?.includes('text/html');
          html = page ? await response.text() : '';
        });
        if (!html) continue;
        found.set(key, queries);
        for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
          const clean = href!.replaceAll('&amp;', '&').split('#')[0]!;
          if (!clean.startsWith('/') || clean.startsWith('//') || SKIP.test(clean) || !WITHIN.test(clean))
            continue;
          if (!found.has(shape(clean))) queue.push(clean);
        }
      }
      return found;
    },
    async apiRequests() {
      const requests = new Map<string, LoggedQuery[]>();
      for (const path of REST_READS) {
        requests.set(
          `GET /api/v1${path}`,
          await measure(async () => {
            const response = await fetch(`${hub.baseUrl}/api/v1${path}`, {
              headers: { authorization: `Bearer ${token}` },
            });
            await response.arrayBuffer();
          }),
        );
      }
      return new Map([
        ...requests,
        ['tools/list', await measure(() => mcp.listTools())],
        [
          'tools/call',
          await measure(() =>
            mcp.callTool({ name: 'demo_echo', arguments: { account: 'main', text: 'hi' } }),
          ),
        ],
        [
          'tools/call on every account',
          await measure(() => mcp.callTool({ name: 'demo_echo', arguments: { text: 'hi' } })),
        ],
      ]);
    },
    async close() {
      await mcp.close();
      await hub.close();
    },
  };
}
