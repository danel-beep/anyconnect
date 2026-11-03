import demo from './builtin/demo.js';
import { ConnectorRegistry } from './registry.js';

/** All connectors shipped with the hub. New built-in connectors are added here. */
export function createBuiltinRegistry(): ConnectorRegistry {
  return new ConnectorRegistry().register(demo);
}

export type { ConnectorResolver } from './registry.js';
export { ConnectorRegistry } from './registry.js';
