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
}
