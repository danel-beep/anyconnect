/** Who is calling the hub, resolved from an OAuth token, a personal access token or a browser session. */
export interface Principal {
  kind: 'oauth' | 'api_token' | 'session';
  userId: string;
  workspaceId: string;
  scopes: string[];
  /** OAuth client id (AI app) for OAuth tokens. */
  clientId?: string;
  /** OAuth grant id or personal access token id. */
  credentialId?: string;
  /** The AI client (Claude, ChatGPT, a script) access rules apply to. */
  aiClientId?: string;
  /** Set when the caller is bound to a persona's MCP URL: it only sees that persona's accounts. */
  personaId?: string;
}
