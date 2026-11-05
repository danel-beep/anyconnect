import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requestedScopes, resolveProvider } from '../connectors/oauth/providers.js';
import type { ConnectorResolver } from '../connectors/registry.js';
import type { ConnectorDefinition, FetchLike } from '../connectors/sdk.js';
import type { Db } from '../db/client.js';
import { oauthConnectStates } from '../db/schema.js';
import { hashToken, type SecretBox } from '../lib/crypto.js';
import { AppError, badRequest, forbidden } from '../lib/errors.js';
import type { Logger } from '../logger.js';
import { ACCOUNT_NAME, type AccountOwnerInput, type AccountRow, type AccountService } from './accounts.js';
import type { OAuthAppService } from './oauth-apps.js';
import { buildAuthorizationUrl, exchangeCode, OAuthProtocolError, pkcePair } from './oauth-client.js';
import type { TokenManager } from './oauth-tokens.js';

/**
 * "Connect an account" through OAuth: the hub is the OAuth client of the service.
 *
 * start → the user is sent to the provider with a single-use `state` (bound to the user, 15 min)
 * and a PKCE challenge → the provider redirects to `/connect/callback` → the code is exchanged,
 * a new account is created (or an existing one re-connected) with the tokens stored apart from the
 * connector credentials, and the connection test fills in the identity (e.g. the email address).
 */

const STATE_TTL_MS = 15 * 60_000;
const stateContext = (stateHash: string) => `oauth_connect:${stateHash}`;

export const StartConnectInput = z.object({
  connectorId: z.string().min(1),
  /** Re-connect this account instead of creating a new one. */
  accountId: z.string().min(1).optional(),
  name: z.string().regex(ACCOUNT_NAME, 'use 1-32 lowercase letters, digits, "-" or "_"').optional(),
  label: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** `env:<provider>` or a workspace OAuth app id; default: the workspace app, else the hub app. */
  appId: z.string().min(1).optional(),
  /** Hub page to show afterwards. */
  returnTo: z
    .string()
    .regex(/^\/(?!\/)[^\\]*$/, 'must be a local path')
    .optional(),
});
export type StartConnectInput = z.infer<typeof StartConnectInput>;

/**
 * Who may connect accounts where. In a team a member connects their own accounts, admins also the
 * team's, and only who manages an account reconnects it (`TeamService`); a personal workspace has
 * one person, so anything goes.
 */
export interface ConnectPermissions {
  /** Throws when `userId` may not add an account with this owner to the workspace. */
  assertCanConnect(workspaceId: string, userId: string, owner: AccountOwnerInput | undefined): Promise<void>;
  /** Throws when `userId` may not reconnect or change this account. */
  assertCanManage(workspaceId: string, userId: string, account: AccountRow): Promise<void>;
}

export interface ConnectResult {
  account: AccountRow;
  created: boolean;
  identity: string | undefined;
  returnTo: string | null;
}

export class ConnectService {
  constructor(
    private readonly deps: {
      db: Db;
      secrets: SecretBox;
      connectors: ConnectorResolver;
      accounts: AccountService;
      apps: OAuthAppService;
      tokens: TokenManager;
      fetch: FetchLike;
      /** `https://<hub>/connect/callback`, registered once at every provider. */
      redirectUri: string;
      /** Called after an account was connected (e.g. to list the tools of a remote MCP server). */
      onConnected?: (account: AccountRow) => Promise<void>;
      permissions?: ConnectPermissions;
      logger: Logger;
    },
  ) {}

  get redirectUri(): string {
    return this.deps.redirectUri;
  }

  private async oauthConnector(workspaceId: string, connectorId: string): Promise<ConnectorDefinition> {
    const connector = await this.deps.connectors.get(workspaceId, connectorId);
    if (!connector) throw badRequest(`Unknown service "${connectorId}"`);
    if (!connector.oauth) throw badRequest(`${connector.name} is not connected through OAuth`);
    return connector;
  }

  /** `who.owner`: in a team, whose the new account will be (see `AccountService.create`). */
  async start(
    who: { workspaceId: string; userId: string; owner?: AccountOwnerInput },
    raw: StartConnectInput,
  ): Promise<{ authorizationUrl: string; expiresAt: string }> {
    const parsed = StartConnectInput.safeParse(raw);
    if (!parsed.success) {
      throw badRequest(
        'Invalid request',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const input = parsed.data;
    const connector = await this.oauthConnector(who.workspaceId, input.connectorId);
    const provider = resolveProvider(connector.oauth!);

    if (input.accountId) {
      const account = await this.deps.accounts.get(who.workspaceId, input.accountId);
      if (account.connectorId !== connector.id) throw badRequest('The account belongs to another service');
      await this.deps.permissions?.assertCanManage(who.workspaceId, who.userId, account);
    } else {
      await this.deps.permissions?.assertCanConnect(who.workspaceId, who.userId, who.owner);
      // Fail now rather than after the user went through the provider's consent screen.
      const config = connector.config.safeParse(input.config ?? {});
      if (!config.success)
        throw badRequest(`Invalid config: ${config.error.issues.map((i) => i.message).join('; ')}`);
      if (input.name && (await this.deps.accounts.findByName(who.workspaceId, connector.id, input.name))) {
        throw badRequest(`An account named "${input.name}" already exists for ${connector.name}`);
      }
      // A team account (owner null) counts against the team's payer, a member's own maybe theirs.
      await this.deps.accounts.assertCanCreate(who.workspaceId, who.owner ? who.owner.userId : who.userId);
    }

    const app = await this.deps.apps.pick(who.workspaceId, connector, input.appId);
    if (!app) {
      throw new AppError(
        400,
        'oauth_app_missing',
        `No OAuth app is configured for ${provider.name}. Register one at ${provider.appSetupUrl ?? 'the provider'} with the redirect URI ${this.deps.redirectUri} and add it in Manyplug.`,
      );
    }

    const state = randomBytes(32).toString('base64url');
    const stateHash = hashToken(state);
    const pkce = provider.pkce === false ? undefined : pkcePair(randomBytes(32).toString('base64url'));
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);
    await this.deps.db.insert(oauthConnectStates).values({
      stateHash,
      workspaceId: who.workspaceId,
      userId: who.userId,
      connectorId: connector.id,
      accountId: input.accountId ?? null,
      draft: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.config ? { config: input.config } : {}),
        ...(who.owner && !input.accountId ? { owner: who.owner } : {}),
      },
      appRef: app.ref,
      codeVerifierEncrypted: pkce
        ? this.deps.secrets.encryptJson(pkce.verifier, stateContext(stateHash))
        : null,
      redirectUri: this.deps.redirectUri,
      returnTo: input.returnTo ?? null,
      expiresAt,
    });
    const authorizationUrl = buildAuthorizationUrl({
      provider,
      app,
      scopes: requestedScopes(provider, connector.oauth!),
      redirectUri: this.deps.redirectUri,
      state,
      codeChallenge: pkce?.challenge,
      extraParams: connector.oauth!.authorizeParams,
    });
    return { authorizationUrl, expiresAt: expiresAt.toISOString() };
  }

  /** Handles the provider's redirect. `userId` is the signed-in user, who must have started the flow. */
  async complete(
    userId: string,
    params: {
      state?: string | undefined;
      code?: string | undefined;
      error?: string | undefined;
      errorDescription?: string | undefined;
    },
  ): Promise<ConnectResult> {
    if (!params.state) throw badRequest('The connection link is incomplete (no state). Start again.');
    const stateHash = hashToken(params.state);
    // Single use: the row is consumed atomically before anything else happens.
    const [row] = await this.deps.db
      .delete(oauthConnectStates)
      .where(eq(oauthConnectStates.stateHash, stateHash))
      .returning();
    if (!row || row.expiresAt.getTime() < Date.now()) {
      throw badRequest(
        'This connection link has expired or was already used. Start connecting the account again.',
      );
    }
    if (row.userId !== userId) throw forbidden('This connection was started by another user');

    const connector = await this.oauthConnector(row.workspaceId, row.connectorId);
    const provider = resolveProvider(connector.oauth!);
    if (params.error) {
      const reason = params.errorDescription || params.error;
      throw new AppError(400, 'oauth_denied', `${provider.name} did not grant access: ${reason}`);
    }
    if (!params.code) throw badRequest(`${provider.name} did not return an authorization code`);
    const app = await this.deps.apps.resolve(row.workspaceId, row.appRef, connector);
    if (!app) throw badRequest('The OAuth app used for this connection was removed. Start again.');

    let tokens: Awaited<ReturnType<typeof exchangeCode>>;
    try {
      tokens = await exchangeCode({
        provider,
        app,
        code: params.code,
        redirectUri: row.redirectUri,
        codeVerifier: row.codeVerifierEncrypted
          ? this.deps.secrets.decryptJson<string>(row.codeVerifierEncrypted, stateContext(stateHash))
          : undefined,
        requestedScopes: requestedScopes(provider, connector.oauth!),
        fetch: this.deps.fetch,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      const message = error instanceof OAuthProtocolError ? error.message : 'unexpected error';
      this.deps.logger.warn({ provider: provider.id, err: error }, 'OAuth code exchange failed');
      throw new AppError(
        502,
        'oauth_exchange_failed',
        `Could not finish connecting ${provider.name}: ${message}`,
      );
    }

    let account: AccountRow;
    let created = false;
    // Checked again: the user may have left the team or lost a role while at the provider.
    if (row.accountId) {
      account = await this.deps.accounts.get(row.workspaceId, row.accountId);
      await this.deps.permissions?.assertCanManage(row.workspaceId, userId, account);
      await this.deps.tokens.store(account.id, { providerId: provider.id, appRef: app.ref, tokens });
    } else {
      await this.deps.permissions?.assertCanConnect(row.workspaceId, userId, row.draft.owner);
      account = await this.deps.accounts.create(
        row.workspaceId,
        {
          connectorId: connector.id,
          label: row.draft.label ?? connector.name,
          ...(row.draft.name ? { name: row.draft.name } : {}),
          ...(row.draft.description ? { description: row.draft.description } : {}),
          ...(row.draft.config ? { config: row.draft.config } : {}),
        },
        row.draft.owner,
      );
      created = true;
      try {
        await this.deps.tokens.store(account.id, { providerId: provider.id, appRef: app.ref, tokens });
      } catch (error) {
        await this.deps.accounts.delete(row.workspaceId, account.id).catch(() => {});
        throw error;
      }
    }
    await this.deps.accounts.markStatus(account.id, 'active', null);
    await this.deps.onConnected?.(account);
    const test = await this.deps.accounts.test(row.workspaceId, account.id, this.deps.logger);
    return {
      account: await this.deps.accounts.get(row.workspaceId, account.id),
      created,
      identity: test.identity,
      returnTo: row.returnTo,
    };
  }
}
