import type { ConnectorDefinition } from '../connectors/sdk.js';
import type { WorkspaceAdmin } from '../core/workspace-admin.js';
import { buildCatalog } from './catalog.js';
import type { CatalogTool } from './catalog-types.js';
import { dataResult, errorResult, type ToolCallResult, toTransport } from './result.js';
import { SETUP_CONNECTOR_ID } from './setup-tools.js';

/**
 * What an AI app sees on /mcp before the user has signed in (`MCP_ANONYMOUS`): the services the hub
 * can connect, and the tool that connects an account. Calling anything that needs an account makes
 * the route answer 401 with `WWW-Authenticate`, and the app opens the hub's sign-in page (OAuth).
 *
 * A visitor has no workspace, so these calls do not go through the executor (no audit row, no
 * usage): they only read the hub's static list of built-in services. The route rate-limits them
 * per IP address.
 */

const SERVICES = `${SETUP_CONNECTOR_ID}_services`;
const CONNECT = `${SETUP_CONNECTOR_ID}_connect_account`;

/** Tools a visitor may call; every other tool call needs sign-in. */
export const VISITOR_CALLABLE: ReadonlySet<string> = new Set([SERVICES]);

const VISITOR_LISTED = new Set([SERVICES, CONNECT]);

export interface VisitorCatalog {
  tools: CatalogTool[];
  instructions: string;
}

export function buildVisitorCatalog(setup: ConnectorDefinition): VisitorCatalog {
  const { tools } = buildCatalog({ connectors: [], accounts: [], setup, listing: 'direct' });
  return {
    tools: tools.filter((t) => VISITOR_LISTED.has(t.name)),
    instructions: [
      'AnyConnect is a hub that connects the user’s services and accounts (mail, messengers, calendars, files, tasks and more, several accounts per service) so this assistant can use them.',
      `The user has not signed in yet. ${SERVICES} shows what can be connected. To connect an account, call ${CONNECT}: the app then asks the user to sign in to AnyConnect (or create an account) and connects. If it does not, ask the user to reconnect the AnyConnect connector in the app settings.`,
      'Never ask for passwords or keys in the chat.',
    ].join('\n'),
  };
}

export async function callVisitorTool(
  admin: WorkspaceAdmin,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (name !== SERVICES) {
    // The route answers 401 before this; kept so the handler is safe on its own.
    return toTransport(
      errorResult('Sign in to AnyConnect first: reconnect the AnyConnect connector.', 'auth'),
    );
  }
  const query = typeof args.query === 'string' ? args.query : undefined;
  const services = await admin.services(undefined, query);
  return toTransport(
    dataResult({
      services: services.map(({ accounts: _accounts, custom: _custom, ...service }) => service),
      next: `Call ${CONNECT} with a service to connect an account; the user signs in to AnyConnect first.`,
    }),
  );
}
