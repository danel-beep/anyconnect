import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { OAuthServer } from '../oauth/server.js';
import type { ApiTokenService } from './api-tokens.js';
import type { Principal } from './principal.js';

const PRINCIPAL = 'manyplug.principal';

/**
 * Accepts both kinds of bearer tokens the hub issues: OAuth access tokens (AI apps such as
 * Claude/ChatGPT) and personal access tokens (CLI, scripts, MCP clients with static headers).
 */
export class HubTokenVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly oauth: OAuthServer,
    private readonly apiTokens: ApiTokenService,
    private readonly resource: string,
    /**
     * The MCP URL a personal token works on: its persona's or its team's (undefined when that is
     * gone). Tokens of a personal workspace without a persona work on `resource`.
     */
    private readonly tokenResource: (token: {
      workspaceId: string;
      personaId: string | null;
    }) => Promise<string | undefined> = async () => this.resource,
    /**
     * Whether the caller may still act: not suspended, still a member of the token's workspace.
     * Suspending a user or removing them from a team revokes their tokens already; this keeps a
     * token issued in a race with that from working.
     */
    private readonly active: (principal: Principal) => Promise<boolean> = async () => true,
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = await this.verify(token);
    const principal = info.extra?.[PRINCIPAL] as Principal;
    if (!(await this.active(principal)))
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
    return info;
  }

  private async verify(token: string): Promise<AuthInfo> {
    const oauth = await this.oauth.verifyAccessToken(token);
    if (oauth) {
      const principal: Principal = {
        kind: 'oauth',
        userId: oauth.userId,
        workspaceId: oauth.workspaceId,
        scopes: oauth.scopes,
        clientId: oauth.clientId,
        credentialId: oauth.grantId,
        ...(oauth.aiClientId ? { aiClientId: oauth.aiClientId } : {}),
        ...(oauth.personaId ? { personaId: oauth.personaId } : {}),
      };
      return {
        token,
        clientId: oauth.clientId,
        scopes: oauth.scopes,
        expiresAt: Math.floor(oauth.expiresAt.getTime() / 1000),
        resource: new URL(oauth.resource),
        extra: { [PRINCIPAL]: principal },
      };
    }
    const pat = await this.apiTokens.verify(token);
    if (pat) {
      const principal: Principal = {
        kind: 'api_token',
        userId: pat.userId,
        workspaceId: pat.workspaceId,
        scopes: pat.scopes,
        credentialId: pat.id,
        ...(pat.aiClientId ? { aiClientId: pat.aiClientId } : {}),
        ...(pat.personaId ? { personaId: pat.personaId } : {}),
        ...(pat.shared ? { shared: true } : {}),
      };
      const resource = await this.tokenResource(pat);
      if (!resource) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
      return {
        token,
        clientId: `pat:${pat.id}`,
        scopes: pat.scopes,
        expiresAt: Math.floor(pat.effectiveExpiresAt.getTime() / 1000),
        resource: new URL(resource),
        extra: { [PRINCIPAL]: principal },
      };
    }
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
  }
}

export function principalFromAuthInfo(authInfo: AuthInfo | undefined): Principal {
  const principal = authInfo?.extra?.[PRINCIPAL] as Principal | undefined;
  if (!principal) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Missing authentication');
  return principal;
}
