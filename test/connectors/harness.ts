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
