import type { ConnectorDefinition } from '../connectors/sdk.js';
import type { DriverStatus, GatewayApi } from './gateway-client.js';

/** Why a service cannot be connected on this server, for the catalog and the connect page. */
export interface ServiceSetupGap {
  /** Words for the server owner. */
  problem: string;
  /** The environment variables that close the gap. */
  env: string[];
}

/**
 * Whether messengers that run as gateway sessions (Telegram as a personal account) can be connected
 * here: the gateway must be configured and its driver for the connector set up (its API keys). The
 * gateway's answer is cached briefly; when the gateway does not answer, the service counts as
 * available and the login page reports the outage, so a short blip never hides a service.
 */
export class SessionAvailability {
  private cached: { at: number; drivers: DriverStatus[] } | undefined;

  constructor(
    private readonly deps: {
      gateway: GatewayApi | undefined;
      ttlMs?: number;
      now?: () => number;
    },
  ) {}

  /** The setup gap of the connector, or undefined when it can be connected (or is no session messenger). */
  async check(connector: ConnectorDefinition): Promise<ServiceSetupGap | undefined> {
    if (!isSessionMessenger(connector)) return undefined;
    if (!this.deps.gateway) {
      return {
        problem: `${connector.name} runs in the messenger gateway, which is not configured on this server (GATEWAY_EMBEDDED=true or GATEWAY_URL).`,
        env: ['GATEWAY_EMBEDDED'],
      };
    }
    const drivers = await this.drivers();
    if (!drivers) return undefined;
    const driver = drivers.find((d) => d.connectorId === connector.id);
    if (!driver) {
      return {
        problem: `The messenger gateway of this server has no driver for ${connector.name}.`,
        env: [],
      };
    }
    return driver.ready || !driver.missing
      ? undefined
      : { problem: driver.missing.message, env: driver.missing.env };
  }

  private async drivers(): Promise<DriverStatus[] | undefined> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cached && now - this.cached.at < (this.deps.ttlMs ?? 30_000)) return this.cached.drivers;
    try {
      const drivers = await this.deps.gateway!.drivers();
      this.cached = { at: now, drivers };
      return drivers;
    } catch {
      return undefined;
    }
  }
}

/** A messenger whose accounts are always gateway sessions, whatever their config. */
function isSessionMessenger(connector: ConnectorDefinition): boolean {
  if (!connector.messenger) return false;
  try {
    return connector.messenger.transport(connector.config.parse({})).kind === 'session';
  } catch {
    // A connector that needs config to pick its transport is not always a session.
    return false;
  }
}
