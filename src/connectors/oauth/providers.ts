import type { OAuthProviderSpec, OAuthRequirement } from '../sdk.js';

/**
 * Built-in OAuth 2 providers. A provider describes an authorization server (endpoints and quirks);
 * connectors and manifests reference it by id with their own scopes, so one OAuth app (client id +
 * secret, configured once per provider) serves every connector of that provider.
 *
 * Adding a provider = one entry here. Keep it plain data: manifests and user-defined services
 * (stored as JSON) use the same shape.
 */
export const BUILTIN_PROVIDERS: Record<string, OAuthProviderSpec> = {
  google: {
    id: 'google',
    name: 'Google',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revocationUrl: 'https://oauth2.googleapis.com/revoke',
    pkce: true,
    clientAuth: 'client_secret_post',
    baseScopes: ['openid', 'email'],
    // offline + consent: Google only returns a refresh token on the first consent otherwise.
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    appSetupUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  microsoft: {
    id: 'microsoft',
    name: 'Microsoft',
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    pkce: true,
    clientAuth: 'client_secret_post',
    baseScopes: ['offline_access', 'openid', 'email', 'User.Read'],
    authorizeParams: { prompt: 'select_account' },
    appSetupUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    revocationUrl: 'https://slack.com/api/auth.revoke',
    pkce: false,
    clientAuth: 'client_secret_post',
    scopeSeparator: ',',
    // The hub acts as the user (reads and writes as them), so it asks for user-token scopes.
    scopeParam: 'user_scope',
    tokenPath: 'authed_user',
    appSetupUrl: 'https://api.slack.com/apps',
  },
  notion: {
    id: 'notion',
    name: 'Notion',
    authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    pkce: false,
    clientAuth: 'client_secret_basic',
    tokenRequestFormat: 'json',
    authorizeParams: { owner: 'user' },
    appSetupUrl: 'https://www.notion.so/profile/integrations',
  },
  github: {
    id: 'github',
    name: 'GitHub',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    pkce: true,
    clientAuth: 'client_secret_post',
    authorizeParams: { allow_signup: 'false' },
    appSetupUrl: 'https://github.com/settings/developers',
  },
  todoist: {
    id: 'todoist',
    name: 'Todoist',
    authorizationUrl: 'https://todoist.com/oauth/authorize',
    tokenUrl: 'https://todoist.com/oauth/access_token',
    pkce: false,
    clientAuth: 'client_secret_post',
    scopeSeparator: ',',
    appSetupUrl: 'https://developer.todoist.com/appconsole.html',
  },
};

const PROVIDER_ID = /^[a-z][a-z0-9_]{1,39}$/;

/** Resolves the provider of an OAuth requirement (built-in id or inline spec). */
export function resolveProvider(requirement: OAuthRequirement): OAuthProviderSpec {
  if (typeof requirement.provider !== 'string') return requirement.provider;
  const provider = BUILTIN_PROVIDERS[requirement.provider];
  if (!provider) throw new Error(`Unknown OAuth provider "${requirement.provider}"`);
  return provider;
}

/** Throws a descriptive error when a provider spec is unusable. Used when registering connectors. */
export function validateProvider(provider: OAuthProviderSpec): void {
  if (!PROVIDER_ID.test(provider.id)) throw new Error(`Invalid OAuth provider id "${provider.id}"`);
  for (const [field, value] of [
    ['authorizationUrl', provider.authorizationUrl],
    ['tokenUrl', provider.tokenUrl],
    ...(provider.revocationUrl ? [['revocationUrl', provider.revocationUrl]] : []),
  ] as const) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`OAuth provider "${provider.id}": ${field} is not a valid URL`);
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error(`OAuth provider "${provider.id}": ${field} must use https`);
    }
  }
}

/** All scopes requested for a connector: provider base scopes + connector scopes, de-duplicated. */
export function requestedScopes(provider: OAuthProviderSpec, requirement: OAuthRequirement): string[] {
  return [...new Set([...(provider.baseScopes ?? []), ...requirement.scopes])];
}
