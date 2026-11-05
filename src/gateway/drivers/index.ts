import { type TelegramApp, telegramUserDriver } from './telegram/driver.js';
import type { SessionDriver } from './types.js';

export interface DriverConfig {
  /** Telegram app from my.telegram.org; without it Telegram accounts report what is missing. */
  telegram?: TelegramApp | undefined;
}

/**
 * Session drivers shipped with the gateway. Each serves the `session` transport of one
 * connector: Telegram as a personal account (MTProto); the WhatsApp device agent comes next.
 */
export function createDrivers(config: DriverConfig = {}): SessionDriver[] {
  return [telegramUserDriver({ app: config.telegram })];
}
