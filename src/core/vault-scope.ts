import { AsyncLocalStorage } from 'node:async_hooks';
import type { VaultWrapKind } from '../db/schema.js';
import { hashToken } from '../lib/crypto.js';
import { tokenSecret, type UnlockedVault } from '../lib/vault.js';
import type { Principal } from './principal.js';
import { VaultLockedError, type VaultService } from './vaults.js';

/**
 * The secret a request brings that can open its caller's vault: the bearer token of an AI app or
 * personal token, or the browser's device key. Held only in memory for the request; `toJSON` and
 * `inspect` hide the secret so a logged object cannot leak it.
 */
export class VaultSecret {
  readonly #secret: Buffer;

  constructor(
    readonly userId: string,
    readonly kind: VaultWrapKind,
    readonly ref: string,
    secret: Buffer,
  ) {
    this.#secret = secret;
  }

  get secret(): Buffer {
    return this.#secret;
  }

  toJSON() {
    return { userId: this.userId, kind: this.kind, ref: this.ref };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `VaultSecret(${this.kind}:${this.ref})`;
  }
}

class Scope {
  private opening: Promise<UnlockedVault | undefined> | undefined;
  private opened: UnlockedVault | undefined;

  constructor(
    private readonly vaults: VaultService,
    private readonly source: VaultSecret | UnlockedVault | undefined,
    readonly userId: string | undefined,
  ) {
    if (source && !(source instanceof VaultSecret)) this.opened = source;
  }

  get vault(): UnlockedVault | undefined {
    return this.opened;
  }

  /** The secret this scope was opened from, when it came from the request (not an opened vault). */
  get secret(): VaultSecret | undefined {
    return this.source instanceof VaultSecret ? this.source : undefined;
  }

  open(): Promise<UnlockedVault | undefined> {
    if (this.opened) return Promise.resolve(this.opened);
    const source = this.source;
    if (!(source instanceof VaultSecret)) return Promise.resolve(undefined);
    this.opening ??= this.vaults
      .unlock(source.userId, source.kind, source.ref, source.secret)
      .then((vault) => {
        this.opened = vault;
        return vault;
      })
      .catch((error: unknown) => {
        if (error instanceof VaultLockedError) return undefined;
        throw error;
      });
    return this.opening;
  }
}

/**
 * Request-scoped access to the caller's vault (`AsyncLocalStorage`). Code that needs a sealed key
 * awaits {@link prepare} at an async boundary and then reads {@link current} synchronously. Outside
 * a scope (background jobs, the gateway, the admin panel) there is no vault, so sealed accounts stay
 * locked by construction rather than by a check someone could forget.
 */
export class VaultScopes {
  private readonly storage = new AsyncLocalStorage<Scope>();
  /** Vaults kept for a later step of one action (see {@link hold}): memory only, never stored. */
  private readonly held = new Map<string, { userId: string; vault: UnlockedVault; until: number }>();

  private help: ((source: VaultSecret | undefined) => Promise<string | undefined>) | undefined;

  constructor(private readonly vaults: VaultService) {}

  /** Explains a locked vault for the request's own secret (`VaultGrantLinks.explainLocked`). */
  setLockedHelp(help: (source: VaultSecret | undefined) => Promise<string | undefined>): void {
    this.help = help;
  }

  /**
   * The error for a sealed account this request cannot open, saying exactly what the user does
   * next (and, for an AI app, filing its request to be let in). Never throws.
   */
  async lockedError(): Promise<VaultLockedError> {
    const source = this.storage.getStore()?.secret;
    const message = await this.help?.(source).catch(() => undefined);
    return message ? new VaultLockedError(message) : lockedError();
  }

  /** Runs `fn` with the vault that `source` opens (lazily, at most once). */
  run<T>(source: VaultSecret | undefined, fn: () => T): T {
    return this.storage.run(new Scope(this.vaults, source, source?.userId), fn);
  }

  /** Runs `fn` with a vault already opened in this request (e.g. just created). */
  runOpened<T>(userId: string, vault: UnlockedVault, fn: () => T): T {
    return this.storage.run(new Scope(this.vaults, vault, userId), fn);
  }

  /** Opens the current scope's vault if it can be opened. Never throws for a locked vault. */
  async prepare(): Promise<UnlockedVault | undefined> {
    return this.storage.getStore()?.open();
  }

  /** The vault opened in this scope, if any (after {@link prepare}). */
  current(): UnlockedVault | undefined {
    return this.storage.getStore()?.vault;
  }

  /** The user whose vault this scope may open. */
  currentUserId(): string | undefined {
    return this.storage.getStore()?.userId;
  }

  /**
   * Keeps the vault open in this request for a later step of the same action, such as a held-back
   * call the runner executes after the user approves it or its undo window ends. Only in this
   * process's memory and only until `untilMs`: after a restart (or on another instance) the step
   * finds the vault locked and the user repeats the request. Keeps an existing hold.
   */
  async hold(key: string, untilMs: number): Promise<boolean> {
    this.prune();
    if (this.held.has(key)) return true;
    const vault = await this.prepare();
    const userId = this.currentUserId();
    if (!vault || !userId) return false;
    this.held.set(key, { userId, vault, until: untilMs });
    return true;
  }

  /** Runs `fn` with the vault held under `key` (if any) and forgets it. */
  runHeld<T>(key: string, fn: () => T): T {
    this.prune();
    const held = this.held.get(key);
    this.held.delete(key);
    return held ? this.runOpened(held.userId, held.vault, fn) : this.run(undefined, fn);
  }

  /** Forgets a hold (the action was declined or cancelled). */
  release(key: string): void {
    this.held.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, held] of this.held) if (held.until <= now) this.held.delete(key);
  }

  /** Throws when no vault is open, with a message the user can act on. */
  require(): UnlockedVault {
    const vault = this.current();
    if (!vault) throw lockedError();
    return vault;
  }
}

export function lockedError(): VaultLockedError {
  return new VaultLockedError(
    'This account is protected by your personal vault and can only be opened from your AI app or a browser where you are signed in',
  );
}

/**
 * The vault secret a bearer token brings: OAuth access tokens are wrapped per token (ref = the
 * token's hash, which is what the database knows it by), personal tokens per token id. A shared team
 * key opens nobody's vault.
 */
export function bearerVaultSecret(principal: Principal, token: string): VaultSecret | undefined {
  if (principal.shared) return undefined;
  if (principal.kind === 'oauth')
    return new VaultSecret(principal.userId, 'oauth', hashToken(token), tokenSecret(token));
  if (principal.kind === 'api_token' && principal.credentialId) {
    return new VaultSecret(principal.userId, 'api_token', principal.credentialId, tokenSecret(token));
  }
  return undefined;
}
