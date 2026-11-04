import demo from './builtin/demo.js';
import { createTelegramConnector } from './builtin/telegram.js';
import { createWhatsAppConnector } from './builtin/whatsapp.js';
import type { MessagingPort } from './messaging.js';
import { ConnectorRegistry } from './registry.js';

/** What built-in connectors get from the hub (ports to its subsystems; no app imports here). */
export interface BuiltinDeps {
  messaging: MessagingPort;
}

/** All connectors shipped with the hub. New built-in connectors are added here. */
export function createBuiltinRegistry(deps: BuiltinDeps): ConnectorRegistry {
  return new ConnectorRegistry()
    .register(demo)
    .register(createTelegramConnector(deps.messaging))
    .register(createWhatsAppConnector(deps.messaging));
}

export type { ConnectorResolver } from './registry.js';
export { ConnectorRegistry } from './registry.js';
