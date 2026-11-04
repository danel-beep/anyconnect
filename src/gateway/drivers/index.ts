import type { SessionDriver } from './types.js';

/**
 * Session drivers shipped with the gateway. Each serves the `session` transport of one
 * connector; Telegram (MTProto) and WhatsApp are added here.
 */
export function createDrivers(): SessionDriver[] {
  return [];
}
