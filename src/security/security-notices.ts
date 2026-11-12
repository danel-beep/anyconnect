import type { OwnerNotifier, SecurityEvent } from '../core/owner-notices.js';
import type { Logger } from '../logger.js';

/** Where the user reviews or undoes each event. */
const PAGE: Record<SecurityEvent, string> = {
  sign_in: '/app/settings',
  app_connected: '/app/apps',
  token_created: '/app/apps',
  totp_removed: '/security',
  passkey_removed: '/security',
};

/**
 * Tells a user about changes to who can get into their account (a sign-in from a new browser, a new
 * AI app or token, a sign-in protection turned off), so a change they did not make is noticed while
 * it can still be undone. Goes through the owner notices: Telegram when linked, email otherwise.
 */
export class SecurityNotices {
  constructor(private readonly deps: { notifier: OwnerNotifier; publicUrl: string; logger: Logger }) {}

  /**
   * Never throws: a notice must not fail the action it reports. Routes do not wait for it (`void`),
   * so a slow channel does not slow the page down.
   */
  async report(userId: string, event: SecurityEvent, subject = ''): Promise<void> {
    try {
      await this.deps.notifier.notify(userId, {
        kind: 'security',
        event,
        subject: subject.slice(0, 200),
        url: `${this.deps.publicUrl}${PAGE[event]}`,
      });
    } catch (error) {
      this.deps.logger.warn({ err: error, event }, 'security notice not sent');
    }
  }
}
