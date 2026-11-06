import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../../src/connectors/index.js';
import type { AccountRow } from '../../src/core/accounts.js';
import { buildCatalog } from '../../src/hub/catalog.js';
import { estimateTokens } from '../../src/hub/tokens.js';

/**
 * Token budget of every built-in connector: what its tools cost in the model's context with one
 * connected account (grouped mode). A connector that grows past its budget fails CI, so new
 * actions and long descriptions are a deliberate choice, not an accident.
 */

/**
 * Tokens for all tools of a connector and for its largest tool, about 15% above the current size.
 * Raise a budget only together with the change that needs it.
 */
const BUDGET: Record<string, { total: number; tool: number }> = {
  demo: { total: 600, tool: 250 },
  imap: { total: 2800, tool: 750 },
  http: { total: 900, tool: 500 },
  github: { total: 2500, tool: 400 },
  todoist: { total: 1700, tool: 400 },
  stripe: { total: 1400, tool: 300 },
  slack: { total: 1300, tool: 350 },
  notion: { total: 1700, tool: 400 },
  gmail: { total: 2500, tool: 400 },
  gcal: { total: 2800, tool: 650 },
  gdrive: { total: 1200, tool: 400 },
  outlook: { total: 4200, tool: 450 },
  jira: { total: 2000, tool: 300 },
  linear: { total: 1650, tool: 380 },
  asana: { total: 1600, tool: 320 },
  trello: { total: 1800, tool: 300 },
  airtable: { total: 1800, tool: 370 },
  hubspot: { total: 1700, tool: 270 },
  confluence: { total: 1250, tool: 270 },
  gitlab: { total: 2300, tool: 350 },
  clickup: { total: 1620, tool: 340 },
  calendly: { total: 920, tool: 260 },
  zendesk: { total: 1430, tool: 290 },
  intercom: { total: 1130, tool: 220 },
  pipedrive: { total: 1950, tool: 290 },
  gsheets: { total: 1910, tool: 300 },
  monday: { total: 1970, tool: 370 },
  freshdesk: { total: 1710, tool: 320 },
  sentry: { total: 1260, tool: 330 },
  figma: { total: 1610, tool: 260 },
  wordpress: { total: 2020, tool: 300 },
  mailchimp: { total: 1710, tool: 280 },
  typeform: { total: 950, tool: 320 },
  vercel: { total: 1430, tool: 270 },
  cloudflare: { total: 1940, tool: 420 },
  bitbucket: { total: 2220, tool: 300 },
  brevo: { total: 1280, tool: 280 },
  calcom: { total: 960, tool: 295 },
  webflow: { total: 1660, tool: 270 },
  zoom: { total: 1690, tool: 410 },
  miro: { total: 1400, tool: 280 },
  sendgrid: { total: 1450, tool: 300 },
  smartsheet: { total: 1380, tool: 335 },
  twilio: { total: 1110, tool: 295 },
  postmark: { total: 1630, tool: 390 },
  pagerduty: { total: 1630, tool: 305 },
  netlify: { total: 1400, tool: 235 },
  harvest: { total: 1510, tool: 300 },
  toggl: { total: 1860, tool: 280 },
  telegram: { total: 2700, tool: 400 },
  telegram_bot: { total: 2750, tool: 410 },
  // Two more tools than Telegram: message templates (list_templates, send_template).
  whatsapp: { total: 3250, tool: 400 },
};

function account(connectorId: string): AccountRow {
  const now = new Date();
  return {
    id: `acc_${connectorId}`,
    workspaceId: 'wsp_1',
    connectorId,
    name: 'main',
    label: 'Main',
    description: null,
    config: {},
    credentialsEncrypted: null,
    dataKeyEncrypted: null,
    enabled: true,
    status: 'active',
    statusMessage: null,
    settings: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    ownerUserId: null,
    checkedAt: null,
    reauthNotifiedAt: null,
  };
}

describe('connector token budget', () => {
  const connectors = createBuiltinRegistry().all();
  const catalog = buildCatalog({ connectors, accounts: connectors.map((c) => account(c.id)) });
  const usage = connectors.map((connector) => {
    const tools = catalog.tools
      .filter((t) => t.target.kind === 'action' && t.target.connectorId === connector.id)
      .map(({ name, title, description, inputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        annotations,
      }));
    return {
      id: connector.id,
      tools: tools.length,
      total: estimateTokens(tools),
      largest: Math.max(0, ...tools.map(estimateTokens)),
      instructions: estimateTokens(connector.instructions ?? ''),
    };
  });

  it('has a budget for every built-in connector', () => {
    expect(connectors.map((c) => c.id).filter((id) => !BUDGET[id])).toEqual([]);
  });

  it.each(usage.map((u) => [u.id, u] as const))('%s stays within its budget', (id, u) => {
    const budget = BUDGET[id]!;
    expect(u.total, `${id}: ${u.tools} tools`).toBeLessThanOrEqual(budget.total);
    expect(u.largest, `${id}: largest tool`).toBeLessThanOrEqual(budget.tool);
    expect(u.instructions, `${id}: instructions`).toBeLessThanOrEqual(150);
  });

  it('prints the usage table', () => {
    if (process.env.BUDGET_REPORT) console.table(usage);
  });
});
