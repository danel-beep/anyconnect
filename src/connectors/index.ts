import airtable from './builtin/airtable.js';
import asana from './builtin/asana.js';
import calendly from './builtin/calendly.js';
import clickup from './builtin/clickup.js';
import confluence from './builtin/confluence.js';
import demo from './builtin/demo.js';
import github from './builtin/github.js';
import gitlab from './builtin/gitlab.js';
import gmail from './builtin/gmail.js';
import gcal from './builtin/google-calendar.js';
import gdrive from './builtin/google-drive.js';
import gsheets from './builtin/google-sheets.js';
import http from './builtin/http.js';
import hubspot from './builtin/hubspot.js';
import imap from './builtin/imap/index.js';
import intercom from './builtin/intercom.js';
import jira from './builtin/jira.js';
import linear from './builtin/linear.js';
import notion from './builtin/notion/index.js';
import outlook from './builtin/outlook.js';
import pipedrive from './builtin/pipedrive.js';
import slack from './builtin/slack.js';
import stripe from './builtin/stripe.js';
import { createTelegramConnector } from './builtin/telegram.js';
import todoist from './builtin/todoist.js';
import trello from './builtin/trello.js';
import { createWhatsAppConnector } from './builtin/whatsapp.js';
import zendesk from './builtin/zendesk.js';
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
    .register(jira)
    .register(linear)
    .register(asana)
    .register(trello)
    .register(airtable)
    .register(hubspot)
    .register(confluence)
    .register(gitlab)
    .register(clickup)
    .register(calendly)
    .register(zendesk)
    .register(intercom)
    .register(pipedrive)
    .register(gsheets)
    .register(createTelegramConnector(deps.messaging))
    .register(createWhatsAppConnector(deps.messaging));
}

export type { ConnectorResolver } from './registry.js';
export { ConnectorRegistry } from './registry.js';
