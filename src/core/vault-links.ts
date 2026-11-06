import { eq, inArray } from 'drizzle-orm';
import { BRAND } from '../brand.js';
import type { Db } from '../db/client.js';
import { aiClients, apiTokens, oauthGrants, oauthTokens, type VaultRequestKind } from '../db/schema.js';
import { hashToken } from '../lib/crypto.js';
import { tokenSecret } from '../lib/vault.js';
import type { VaultScopes, VaultSecret } from './vault-scope.js';
import { VaultLockedError, type VaultRequest, type VaultService } from './vaults.js';

/** A waiting request with what the user recognises it by (the AI app's or token's name). */
export interface LabeledVaultRequest extends VaultRequest {
  /** AI app or token name; undefined for a browser (it shows its code instead). */
  label?: string;
}

/**
 * Keeps an AI app's way into its user's vault across the OAuth flow (`OAuthServer` calls it):
 * approval in a browser whose vault is open wraps the vault under the authorization code; the code
 * exchange moves it to the issued access and refresh tokens; each refresh moves it again. Only the
 * tokens' hashes are stored, so the wraps open only for the app that holds the tokens.
 *
 * An app that has no way in (connected before the vault existed, or approved in a browser where it
 * was locked) is never left stuck: its tokens file a request (`vault_requests`, public keys only)
 * at each issuance and whenever it reaches a sealed account, and the user lets it in with one
 * **Allow** in any browser where the vault is open. The same goes for personal tokens.
 */
export class VaultGrantLinks {
  constructor(
    private readonly vaults: VaultService,
    private readonly scopes: VaultScopes,
    private readonly deps: { db: Db; publicUrl: string },
  ) {}

  /** At approval, inside the consent request. */
  async linkCode(userId: string, code: string): Promise<void> {
    const vault = await this.scopes.prepare();
    if (!vault || this.scopes.currentUserId() !== userId) return;
    await this.vaults.addWrap(userId, vault, 'oauth_code', hashToken(code), tokenSecret(code));
  }

  /** At token issuance: from the code (first exchange) or the presented refresh token. */
  async linkTokens(
    userId: string,
    from: { kind: 'code' | 'refresh'; token: string },
    issued: { grantId: string; accessToken: string; refreshToken: string },
  ): Promise<void> {
    const kind = from.kind === 'code' ? 'oauth_code' : 'oauth';
    const ref = hashToken(from.token);
    const tokens = [issued.accessToken, issued.refreshToken];
    let vault: Awaited<ReturnType<VaultService['unlock']>>;
    try {
      vault = await this.vaults.unlock(userId, kind, ref, tokenSecret(from.token));
    } catch (error) {
      if (!(error instanceof VaultLockedError)) throw error;
      // No way in yet: the new tokens ask for one, replacing what older tokens asked.
      if (await this.vaults.exists(userId)) {
        await this.vaults.request(
          userId,
          'oauth',
          issued.grantId,
          tokens.map((t) => ({ ref: hashToken(t), secret: tokenSecret(t) })),
        );
      }
      return;
    }
    for (const token of tokens) {
      await this.vaults.addWrap(userId, vault, 'oauth', hashToken(token), tokenSecret(token));
    }
    // A code is single-use; a rotated refresh token keeps its wrap through the reuse grace period
    // and is removed with the token (maintenance) or the grant (revocation).
    if (from.kind === 'code') await this.vaults.removeWrap(userId, kind, ref);
  }

  /** A personal token created while its owner's vault is open in this request. */
  async linkPersonalToken(userId: string, tokenId: string, token: string): Promise<void> {
    const vault = await this.scopes.prepare();
    if (!vault || this.scopes.currentUserId() !== userId) return;
    await this.vaults.addWrap(userId, vault, 'api_token', tokenId, tokenSecret(token));
  }

  async unlinkPersonalToken(userId: string, tokenId: string): Promise<void> {
    await this.vaults.removeWrap(userId, 'api_token', tokenId);
    await this.vaults.removeRequests('api_token', [tokenId]);
  }

  /** A revoked app: its wraps and its waiting request go with it. */
  async unlink(tokenHashes: string[], grantId?: string): Promise<void> {
    await this.vaults.removeWrapsByRef('oauth', tokenHashes);
    if (grantId) await this.vaults.removeRequests('oauth', [grantId]);
  }

  /**
   * Why a sealed account did not open in this request, in words the AI can pass on, with the exact
   * step that fixes it. For an AI app or personal token without a way in, files (or refreshes) its
   * request first, so the user finds it waiting behind **Allow**.
   */
  async explainLocked(source: VaultSecret | undefined): Promise<string | undefined> {
    const securityUrl = `${this.deps.publicUrl}/security#vault`;
    if (!source) return undefined;
    if (source.kind === 'device') {
      return `This browser cannot open your private vault yet. Open ${securityUrl} in a browser where you already use ${BRAND.name} and press "Allow" next to the code this browser shows there, or open the vault here with your recovery key.`;
    }
    const subject = await this.subjectOf(source);
    if (!subject || !(await this.vaults.exists(source.userId))) return undefined;
    await this.vaults.request(
      source.userId,
      subject.kind,
      subject.id,
      [{ ref: source.ref, secret: source.secret }],
      {
        merge: true,
      },
    );
    return (
      `This account is protected by the user's private ${BRAND.name} vault, and this AI app ("${subject.label}") ` +
      `has not been allowed to open it yet (it was connected before the vault existed, or from a browser where the vault was locked). ` +
      `Ask the user to open ${securityUrl} in a browser where they use ${BRAND.name}, press "Allow" next to "${subject.label}", and then try again. ` +
      'Nothing else needs to change; other accounts keep working.'
    );
  }

  /** Waiting requests with the AI app's or token's name, newest first. */
  async requests(userId: string): Promise<LabeledVaultRequest[]> {
    const requests = await this.vaults.requests(userId);
    const labels = await this.labels(
      requests.filter((r) => r.kind === 'oauth').map((r) => r.subject),
      requests.filter((r) => r.kind === 'api_token').map((r) => r.subject),
    );
    return requests.map((r) => {
      if (r.kind === 'device') return r;
      return {
        ...r,
        label: labels.get(`${r.kind}:${r.subject}`) ?? (r.kind === 'oauth' ? 'AI app' : 'personal token'),
      };
    });
  }

  private async subjectOf(
    source: VaultSecret,
  ): Promise<{ kind: VaultRequestKind; id: string; label: string } | undefined> {
    if (source.kind === 'oauth') {
      const [row] = await this.deps.db
        .select({ grantId: oauthTokens.grantId })
        .from(oauthTokens)
        .where(eq(oauthTokens.tokenHash, source.ref))
        .limit(1);
      if (!row) return undefined;
      const label = (await this.labels([row.grantId], [])).get(`oauth:${row.grantId}`) ?? 'AI app';
      return { kind: 'oauth', id: row.grantId, label };
    }
    if (source.kind === 'api_token') {
      const label = (await this.labels([], [source.ref])).get(`api_token:${source.ref}`) ?? 'personal token';
      return { kind: 'api_token', id: source.ref, label };
    }
    return undefined;
  }

  /** `oauth:<grant id>` / `api_token:<token id>` → the name the user knows the app by. */
  private async labels(grantIds: string[], tokenIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (grantIds.length) {
      const rows = await this.deps.db
        .select({ id: oauthGrants.id, clientName: oauthGrants.clientName, appName: aiClients.name })
        .from(oauthGrants)
        .leftJoin(aiClients, eq(aiClients.id, oauthGrants.aiClientId))
        .where(inArray(oauthGrants.id, grantIds));
      for (const r of rows) out.set(`oauth:${r.id}`, r.appName ?? r.clientName ?? 'AI app');
    }
    if (tokenIds.length) {
      const rows = await this.deps.db
        .select({ id: apiTokens.id, name: apiTokens.name })
        .from(apiTokens)
        .where(inArray(apiTokens.id, tokenIds));
      for (const r of rows) out.set(`api_token:${r.id}`, r.name);
    }
    return out;
  }
}
