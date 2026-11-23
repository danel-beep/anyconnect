import type { OAuthClientMetadata, OAuthClientProvider } from '@modelcontextprotocol/client';

type Stored = Parameters<NonNullable<OAuthClientProvider['saveClientInformation']>>[0];
export type Tokens = Parameters<OAuthClientProvider['saveTokens']>[0];

/** In-memory OAuth client, the way Claude Code or another MCP client would behave. */
export class MemoryOAuthProvider implements OAuthClientProvider {
  client?: Stored;
  savedTokens?: Tokens;
  verifier = '';
  authorizationUrl?: URL;
  clientMetadataUrl?: string;

  constructor(
    readonly redirectUrl = 'http://localhost:7777/callback',
    private readonly options: { clientMetadataUrl?: string; clientName?: string } = {},
  ) {
    if (options.clientMetadataUrl) this.clientMetadataUrl = options.clientMetadataUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.options.clientName ?? 'Test MCP Client',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(info: Stored) {
    this.client = info;
  }
  tokens() {
    return this.savedTokens;
  }
  saveTokens(tokens: Tokens) {
    this.savedTokens = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  discovery?: unknown;
  saveDiscoveryState(state: unknown) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery as never;
  }
}
