import demo from './builtin/demo.js';
import github from './builtin/github.js';
import gmail from './builtin/gmail.js';
import gcal from './builtin/google-calendar.js';
import gdrive from './builtin/google-drive.js';
import http from './builtin/http.js';
import imap from './builtin/imap/index.js';
import notion from './builtin/notion/index.js';
import outlook from './builtin/outlook.js';
import slack from './builtin/slack.js';
import stripe from './builtin/stripe.js';
import { createTelegramConnector } from './builtin/telegram.js';
import todoist from './builtin/todoist.js';
import { createWhatsAppConnector } from './builtin/whatsapp.js';
import type { MessagingPort } from './messaging.js';
import { ConnectorRegistry } from './registry.js';
import { ConnectorError } from './sdk.js';

/** What built-in connectors get from the hub (ports to its subsystems; no app imports here). */
export interface BuiltinDeps {
  messaging: MessagingPort;
}

/**
 * For processes that only list or inspect connectors (catalog checks, docs, tests): messenger
 * tools are defined but fail with a clear error if one is actually run.
 */
export const NO_MESSAGING: MessagingPort = {
  forAccount: () => {
    throw new ConnectorError('upstream', 'Messaging is not available in this process.');
  },
};

/** All connectors shipped with the hub. New built-in connectors are added here. */
export function createBuiltinRegistry(deps: BuiltinDeps = { messaging: NO_MESSAGING }): ConnectorRegistry {
  return new ConnectorRegistry()
    .register(demo)
    .register(imap)
    .register(http)
    .register(github)
    .register(todoist)
    .register(stripe)
    .register(slack)
    .register(notion)
    .register(gmail)
    .register(gcal)
    .register(gdrive)
    .register(outlook)
    .register(createTelegramConnector(deps.messaging))
    .register(createWhatsAppConnector(deps.messaging));
}

export type { ConnectorResolver } from './registry.js';
export { ConnectorRegistry } from './registry.js';
