import type {
  AccountContext,
  ActionResult,
  ConnectorDefinition,
  FetchLike,
  NetworkAccess,
  OAuthAccess,
} from '../../src/connectors/sdk.js';
import { isRawResult } from '../../src/connectors/sdk.js';
import { createNetworkPolicy } from '../../src/lib/network.js';

/**
 * Contract-test harness: runs connector actions directly, without the hub, database or MCP. The
 * account context is built from plain config/credentials validated by the connector's own schemas,
 * like the hub does. HTTP goes to a fake service (`fakeHttp`), never to the internet; raw sockets
 * may reach local test servers.
 */
export interface TestAccount {
  connector: ConnectorDefinition;
  ctx: AccountContext<unknown, unknown>;
  /** Credentials saved through ctx.updateCredentials (e.g. refreshed tokens). */
  savedCredentials: unknown[];
  run(action: string, input?: Record<string, unknown>): Promise<ActionResult>;
}

const localNetwork = createNetworkPolicy({ allowPrivateNetwork: true });

const noInternet: FetchLike = async (input) => {
  throw new Error(
    `Contract tests must not reach the network (${String(input instanceof Request ? input.url : input)})`,
  );
};

export function testAccount(
  connector: ConnectorDefinition,
  options: {
    config?: Record<string, unknown>;
    credentials?: Record<string, unknown>;
    id?: string;
    name?: string;
    fetch?: FetchLike;
    /** Defaults to a policy that allows local test servers. */
    network?: NetworkAccess;
    oauth?: Partial<OAuthAccess>;
  } = {},
): TestAccount {
  const config = connector.config.parse(options.config ?? {});
  const credentials = connector.credentials.parse(options.credentials ?? {});
  const savedCredentials: unknown[] = [];
  const name = options.name ?? 'main';
  const ctx: AccountContext<unknown, unknown> = {
    account: { id: options.id ?? `acc_${name}`, name, label: name },
    config,
    credentials,
    updateCredentials: async (next) => {
      savedCredentials.push(connector.credentials.parse(next));
    },
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetch: options.fetch ?? noInternet,
    network: options.network ?? {
      lookup: localNetwork.lookup,
      assertHostAllowed: localNetwork.assertHostAllowed,
    },
    ...(options.oauth
      ? {
          oauth: {
            accessToken: 'test-access-token',
            tokenType: 'Bearer',
            scopes: [],
            extra: {},
            refresh: async () => 'test-access-token-2',
            ...options.oauth,
          },
        }
      : {}),
  };
  return {
    connector,
    ctx,
    savedCredentials,
    async run(actionName, input = {}) {
      const action = connector.actions.find((a) => a.name === actionName);
      if (!action) throw new Error(`No action ${connector.id}.${actionName}`);
      const result = await action.run(action.input.parse(input), ctx);
      return isRawResult(result) ? result : JSON.parse(JSON.stringify(result));
    },
  };
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
}

/**
 * A fake remote service for contract tests: `handler` answers each request (usually from recorded
 * fixtures) and every request is kept in `calls` for assertions.
 */
export function fakeHttp(handler: (req: RecordedRequest) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const body = init?.body;
    const req: RecordedRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: new URL(input instanceof Request ? input.url : input.toString()),
      headers: new Headers(init?.headers),
      body:
        typeof body === 'string'
          ? body
          : body instanceof Uint8Array
            ? Buffer.from(body).toString()
            : undefined,
    };
    calls.push(req);
    return handler(req);
  };
  return { fetch, calls };
}

export const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });

type Route = (req: RecordedRequest) => Response | Promise<Response>;

/**
 * Fake service from a route table: keys are "METHOD /path" (path relative to the origin, without
 * the query). Unknown routes answer 404 so a wrong URL fails the test loudly.
 */
export function fakeRoutes(routes: Record<string, Route | object | string>) {
  return fakeHttp((req) => {
    const route = routes[`${req.method} ${req.url.pathname}`];
    if (route === undefined)
      return json({ message: `No fixture for ${req.method} ${req.url.pathname}` }, { status: 404 });
    return typeof route === 'function' ? (route as Route)(req) : json(route);
  });
}
