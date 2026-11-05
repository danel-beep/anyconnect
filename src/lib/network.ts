import dns from 'node:dns';
import net from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import {
  ConnectorError,
  type FetchLike,
  type LookupFunction,
  type NetworkAccess,
} from '../connectors/sdk.js';
import { guardedLookup, isPublicAddress } from './safe-fetch.js';

/**
 * Outbound network access handed to connectors (`ctx.fetch`, `ctx.network`).
 *
 * In production every connection is checked at connect time against the public-address policy of
 * `safe-fetch.ts`, so neither a user-supplied URL, a redirect nor DNS rebinding can reach private
 * networks (cloud metadata, the database, other services). Local development and tests may allow
 * private addresses.
 */
export interface NetworkPolicy extends NetworkAccess {
  fetch: FetchLike;
  close(): Promise<void>;
}

export function createNetworkPolicy(options: { allowPrivateNetwork: boolean }): NetworkPolicy {
  const allowPrivate = options.allowPrivateNetwork;
  const lookup: LookupFunction = allowPrivate
    ? (hostname, lookupOptions, callback) => dns.lookup(hostname, lookupOptions, callback as never)
    : (guardedLookup as unknown as LookupFunction);
  const assertHostAllowed = (host: string) => {
    const bare = host.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(bare) && !isPublicAddress(bare)) {
      throw new ConnectorError('permission', `Connections to the private address ${bare} are not allowed`);
    }
  };
  // The check runs before every connection, including redirects and IP-literal hosts (which never
  // reach `lookup`).
  const baseConnector = buildConnector({ lookup: lookup as never, timeout: 10_000 });
  const agent = new Agent({
    connect: (connectOptions, callback) => {
      try {
        assertHostAllowed(connectOptions.hostname);
      } catch (error) {
        callback(error as Error, null);
        return;
      }
      baseConnector(connectOptions, callback);
    },
    headersTimeout: 60_000,
    bodyTimeout: 120_000,
  });
  const fetch: FetchLike = async (input, init) => {
    // undici's fetch has its own Request class: pass plain url + init instead of a global Request.
    let url: string;
    let requestInit: RequestInit = init ?? {};
    if (input instanceof Request) {
      url = input.url;
      requestInit = {
        method: input.method,
        headers: input.headers,
        ...(input.body ? { body: input.body, duplex: 'half' } : {}),
        signal: input.signal,
        redirect: input.redirect,
        ...init,
      } as RequestInit;
    } else {
      url = input.toString();
    }
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      throw new ConnectorError('invalid_input', 'URLs with embedded credentials are not allowed');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ConnectorError('invalid_input', `Unsupported URL scheme ${parsed.protocol}`);
    }
    if (requestInit.body instanceof FormData) {
      // undici's own fetch does not recognise the global FormData (it would send "[object
      // FormData]"): encode the multipart body here, with its boundary header.
      const encoded = new Response(requestInit.body);
      const headers = new Headers(requestInit.headers);
      headers.set('content-type', encoded.headers.get('content-type')!);
      requestInit = { ...requestInit, headers, body: new Uint8Array(await encoded.arrayBuffer()) };
    }
    const response = await undiciFetch(url, { ...requestInit, dispatcher: agent } as never);
    return response as unknown as Response;
  };
  return { lookup, assertHostAllowed, fetch, close: () => agent.close() };
}
