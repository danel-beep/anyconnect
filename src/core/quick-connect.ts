import type { AccountOwnerInput, AccountRow } from './accounts.js';

/**
 * Quick connect: the person connects an account by confirming in the service's own app instead of
 * filling in the connect form (Telegram Chat Automation today, WhatsApp Embedded Signup next). The
 * hub creates the account once the service reports it. Each flow lives with its subsystem and
 * registers here; the connect page (`/connect/<service>`) and the setup tools offer the flow of a
 * service whenever the hub can run it, and the form stays one link away (`?via=form`).
 */

/** Where the account goes and what it is called: what the connect link carried. */
export interface QuickConnectStart {
  workspaceId: string;
  /** The signed-in user who opened the link: the account is theirs (or, in a team, `owner`'s). */
  userId: string;
  /** In a team: a member's own account or the team's. */
  owner?: AccountOwnerInput;
  name?: string;
  label?: string;
  /** The account to connect again (one the flow made, see {@link QuickConnectFlow.reconnects}). */
  reconnect?: AccountRow;
  /** Hub-relative path to go to afterwards. */
  returnTo?: string;
  /** Language of the page, for what the service's app shows (a bot's messages). */
  locale: string;
}

export interface QuickConnectFlow {
  /** The connector whose accounts it makes. */
  readonly connectorId: string;
  /** Whether the hub can run it now (configured, and allowed by the service). */
  available(): Promise<boolean>;
  /** Whether it can connect this existing account again (accounts it made itself). */
  reconnects(account: AccountRow): boolean;
  /** Starts it for the user; resolves to the hub path of its page. */
  start(input: QuickConnectStart): Promise<string>;
}

/** The quick connect flows of the hub, by service. */
export class QuickConnects {
  private readonly flows = new Map<string, QuickConnectFlow>();

  constructor(flows: QuickConnectFlow[] = []) {
    for (const flow of flows) this.flows.set(flow.connectorId, flow);
  }

  /**
   * The flow that connects an account of this service now, if any. With `reconnect`, only a flow
   * that can connect that account again (an account made with the form goes back to the form).
   */
  async for(connectorId: string, reconnect?: AccountRow): Promise<QuickConnectFlow | undefined> {
    const flow = this.flows.get(connectorId);
    if (!flow || (reconnect && !flow.reconnects(reconnect))) return undefined;
    return (await flow.available().catch(() => false)) ? flow : undefined;
  }
}
