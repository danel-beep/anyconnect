import { hashToken } from '../lib/crypto.js';
import { tokenSecret } from '../lib/vault.js';
import type { VaultScopes } from './vault-scope.js';
import { VaultLockedError, type VaultService } from './vaults.js';

/**
 * Keeps an AI app's way into its user's vault across the OAuth flow (`OAuthServer` calls it):
 * approval in a browser whose vault is open wraps the vault under the authorization code; the code
 * exchange moves it to the issued access and refresh tokens; each refresh moves it again. Only the
 * tokens' hashes are stored, so the wraps open only for the app that holds the tokens.
 *
 * Every step is best-effort: an app approved in a browser without an open vault still works, it just
 * cannot open sealed accounts until it is approved again from a browser that can.
 */
export class VaultGrantLinks {
  constructor(
    private readonly vaults: VaultService,
    private readonly scopes: VaultScopes,
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
    issued: { accessToken: string; refreshToken: string },
  ): Promise<void> {
    const kind = from.kind === 'code' ? 'oauth_code' : 'oauth';
    const ref = hashToken(from.token);
    let vault: Awaited<ReturnType<VaultService['unlock']>>;
    try {
      vault = await this.vaults.unlock(userId, kind, ref, tokenSecret(from.token));
    } catch (error) {
      if (error instanceof VaultLockedError) return;
      throw error;
    }
    for (const token of [issued.accessToken, issued.refreshToken]) {
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
  }

  /** Revoked or deleted tokens: their wraps go with them. */
  async unlink(tokenHashes: string[]): Promise<void> {
    await this.vaults.removeWrapsByRef('oauth', tokenHashes);
  }
}
