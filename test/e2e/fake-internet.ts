import type { FetchLike } from '../../src/connectors/sdk.js';
import { createNetworkPolicy, type NetworkPolicy } from '../../src/lib/network.js';
import type { SafeFetchResponse, safeFetch } from '../../src/lib/safe-fetch.js';

/** Anything that answers a Fetch API request: a Hono app's `fetch`, or a plain function. */
export type Handler = (request: Request) => Response | Promise<Response>;

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

/**
 * The internet as the hub sees it in end-to-end tests: requests to real service hosts
 * (`gmail.googleapis.com`, `claude.ai`, ...) are answered by fake services registered with
 * `serve()`, and every request is recorded. Nothing reaches the real network; a request to a
 * host nobody serves fails like an unreachable host and is listed in `unrouted`, so a test can
 * assert that a flow touched only what it expected.
 *
 * It plugs into the hub where the real network does (`createServices({ network, fetchDocument })`),
 * so connectors, provider OAuth, "Sign in with Google" and Client ID Metadata Documents all run
 * their production code. Raw sockets (`ctx.network`) still reach local test servers.
 */
export class FakeInternet {
  private readonly hosts = new Map<string, Handler>();
  readonly requests: RecordedRequest[] = [];
  readonly unrouted: string[] = [];

  /** Answers requests to `host` (e.g. `gmail.googleapis.com`). Later registrations win. */
  serve(host: string, handler: Handler): this {
    this.hosts.set(host.toLowerCase(), handler);
    return this;
  }

  /** Recorded requests to one host, optionally under a path prefix. */
  requestsTo(host: string, pathPrefix = '/'): RecordedRequest[] {
    return this.requests.filter((r) => r.url.host === host && r.url.pathname.startsWith(pathPrefix));
  }

  /** Forgets recorded requests (between steps of a journey). */
  clear(): void {
    this.requests.length = 0;
    this.unrouted.length = 0;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
    this.requests.push({ method: request.method, url, headers: new Headers(request.headers), body });
    const handler = this.hosts.get(url.host.toLowerCase());
    if (!handler) {
      this.unrouted.push(`${request.method} ${url.origin}${url.pathname}`);
      throw new TypeError(`fetch failed: ${url.host} is not served by the fake internet`);
    }
    return handler(request);
  };

  /** A drop-in for the hub's `NetworkPolicy` (one per hub: closing a hub closes its sockets). */
  network(): NetworkPolicy {
    const sockets = createNetworkPolicy({ allowPrivateNetwork: true });
    return {
      fetch: this.fetch,
      lookup: sockets.lookup,
      assertHostAllowed: sockets.assertHostAllowed,
      close: () => sockets.close(),
    };
  }

  /** A drop-in for `safeFetch` (how the hub fetches Client ID Metadata Documents). */
  readonly fetchDocument: typeof safeFetch = async (url, options = {}) => {
    const response = await this.fetch(url, {
      method: options.method ?? 'GET',
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
    const headers: SafeFetchResponse['headers'] = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  };
}
