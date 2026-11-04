import airtable from './builtin/airtable.js';
import asana from './builtin/asana.js';
import demo from './builtin/demo.js';
import github from './builtin/github.js';
import gmail from './builtin/gmail.js';
import gcal from './builtin/google-calendar.js';
import gdrive from './builtin/google-drive.js';
import http from './builtin/http.js';
import hubspot from './builtin/hubspot.js';
import imap from './builtin/imap/index.js';
import jira from './builtin/jira.js';
import linear from './builtin/linear.js';
import notion from './builtin/notion/index.js';
import outlook from './builtin/outlook.js';
import slack from './builtin/slack.js';
import stripe from './builtin/stripe.js';
import todoist from './builtin/todoist.js';
import trello from './builtin/trello.js';
import { ConnectorRegistry } from './registry.js';

/** All connectors shipped with the hub. New built-in connectors are added here. */
export function createBuiltinRegistry(): ConnectorRegistry {
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
    .register(hubspot);
}

export type { ConnectorResolver } from './registry.js';
export { ConnectorRegistry } from './registry.js';
