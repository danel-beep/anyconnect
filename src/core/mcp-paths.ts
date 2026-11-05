import { PERSONA_SLUG } from '../security/personas.js';
import { TEAM_SLUG } from './teams.js';

/**
 * The MCP URLs below `/mcp`: `/mcp/<persona>` and `/mcp/team/<slug>`. Each is its own OAuth
 * protected resource, so the OAuth server, the token verifier and the routes agree on one list.
 */
export function isMcpSubPath(path: string): boolean {
  if (path.startsWith('team/')) return TEAM_SLUG.test(path.slice('team/'.length));
  return PERSONA_SLUG.test(path);
}
