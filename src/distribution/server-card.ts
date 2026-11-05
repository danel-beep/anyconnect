import { BRAND } from '../brand.js';
import type { ConnectorDefinition } from '../connectors/sdk.js';
import { buildCatalog } from '../hub/catalog.js';
import { LISTING } from './listing.js';

/**
 * The static server card (`/.well-known/mcp/server-card.json`): what scanners of directories
 * (Smithery and others) can read without signing in. The real tool list depends on the services a
 * user connects, so the card lists the tools every workspace has: the hub's own and its setup tools.
 */
export function buildServerCard(input: { version: string; publicUrl: string; setup: ConnectorDefinition }) {
  const { tools } = buildCatalog({ connectors: [], accounts: [], setup: input.setup, listing: 'direct' });
  const url = (path: keyof typeof LISTING.paths) => `${input.publicUrl}${LISTING.paths[path]}`;
  return {
    serverInfo: {
      name: BRAND.slug,
      title: BRAND.name,
      version: input.version,
      description: LISTING.oneLiner,
      websiteUrl: input.publicUrl,
      icons: [{ src: url('icon'), mimeType: 'image/svg+xml', sizes: ['any'] }],
    },
    description: LISTING.description,
    documentationUrl: url('docs'),
    transport: { type: 'streamable-http', endpoint: LISTING.paths.mcp },
    authentication: { required: true, schemes: ['oauth2'] },
    capabilities: { tools: { listChanged: false } },
    instructions:
      'Tools of the services the user connects (Gmail, Slack, Notion, GitHub...) appear after signing in; the tools below are always available.',
    tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      annotations,
    })),
    resources: [],
    prompts: [],
  };
}
