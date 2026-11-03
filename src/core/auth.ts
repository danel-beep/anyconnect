import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { OAuthServer } from '../oauth/server.js';
import type { ApiTokenService } from './api-tokens.js';
import type { Principal } from './principal.js';

const PRINCIPAL = 'anyconnect.principal';

/**
 * Accepts both kinds of bearer tokens the hub issues: OAuth access tokens (AI apps such as
 * Claude/ChatGPT) and personal access tokens (CLI, scripts, MCP clients with static headers).
 */
export class HubTokenVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly oauth: OAuthServer,
    private readonly apiTokens: ApiTokenService,
    private readonly resource: string,
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const oauth = await this.oauth.verifyAccessToken(token);
    if (oauth) {
      const principal: Principal = {
        kind: 'oauth',
        userId: oauth.userId,
        workspaceId: oauth.workspaceId,
        scopes: oauth.scopes,
        clientId: oauth.clientId,
        credentialId: oauth.grantId,
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
      };
      return {
        token,
        clientId: `pat:${pat.id}`,
        scopes: pat.scopes,
        expiresAt: Math.floor(pat.effectiveExpiresAt.getTime() / 1000),
        resource: new URL(this.resource),
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
