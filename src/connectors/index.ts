import demo from './builtin/demo.js';
import imap from './builtin/imap/index.js';
import { ConnectorRegistry } from './registry.js';

/** All connectors shipped with the hub. New built-in connectors are added here. */
export function createBuiltinRegistry(): ConnectorRegistry {
  return new ConnectorRegistry().register(demo).register(imap);
}

export type { ConnectorResolver } from './registry.js';
export { ConnectorRegistry } from './registry.js';
