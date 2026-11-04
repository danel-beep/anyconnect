import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { dataKeys } from '../db/schema.js';
import type { SecretBox } from '../lib/crypto.js';

/**
 * Long-lived random data keys, stored wrapped by the SecretBox.
 *
 * Keys derived directly from ENCRYPTION_KEY would change on rotation and silently break
 * everything derived from them (blind indexes, lookup hashes). A wrapped data key survives
 * rotation: the SecretBox can still unwrap it with a previous key, and re-wrapping it with the
 * new key does not change it.
 */
export class DataKeys {
  private readonly cache = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
  ) {}

  get(purpose: string): Promise<Buffer> {
    let key = this.cache.get(purpose);
    if (!key) {
      key = this.load(purpose);
      key.catch(() => this.cache.delete(purpose));
      this.cache.set(purpose, key);
    }
    return key;
  }

  private context(purpose: string): string {
    return `data-key:${purpose}`;
  }

  private async load(purpose: string): Promise<Buffer> {
    const fresh = randomBytes(32).toString('base64');
    // Concurrent first starts: exactly one insert wins, everyone reads the winner.
    await this.db
      .insert(dataKeys)
      .values({ purpose, keyEncrypted: this.secrets.encrypt(fresh, this.context(purpose)) })
      .onConflictDoNothing();
    const [row] = await this.db.select().from(dataKeys).where(eq(dataKeys.purpose, purpose)).limit(1);
    if (!row) throw new Error(`data key "${purpose}" is missing`);
    const key = Buffer.from(this.secrets.decrypt(row.keyEncrypted, this.context(purpose)), 'base64');
    if (this.secrets.needsRotation(row.keyEncrypted)) {
      await this.db
        .update(dataKeys)
        .set({ keyEncrypted: this.secrets.encrypt(key.toString('base64'), this.context(purpose)) })
        .where(eq(dataKeys.purpose, purpose));
    }
    return key;
  }
}

interface SubKeys {
  lookup: Buffer;
  index: Buffer;
  webhook: Buffer;
}

/**
 * Sub-keys of the messenger data key, one per use, so a leak of one says nothing about others.
 * Call {@link MessengerKeys.init} once at startup (it reads the wrapped key from the database).
 */
export class MessengerKeys {
  private keys: SubKeys | undefined;
  private loading: Promise<void> | undefined;

  constructor(private readonly dataKeys: DataKeys) {}

  init(): Promise<void> {
    this.loading ??= this.dataKeys.get('messenger/v1').then((root) => {
      const sub = (info: string) => Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), info, 32));
      this.keys = { lookup: sub('lookup'), index: sub('search-index'), webhook: sub('webhook') };
    });
    this.loading.catch(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private get k(): SubKeys {
    if (!this.keys) throw new Error('MessengerKeys.init() was not awaited');
    return this.keys;
  }

  /** Keyed hash for equality lookups (chat and message ids) without storing them in clear. */
  lookupKey(accountId: string, scope: string, value: string): string {
    return createHmac('sha256', this.k.lookup)
      .update(`${accountId}\u0000${scope}\u0000${value}`, 'utf8')
      .digest('base64url')
      .slice(0, 22);
  }

  /**
   * 32-bit blind index token. Short on purpose: collisions only cost a false candidate that is
   * dropped after decryption, and they make frequency analysis of the index less useful.
   */
  indexToken(accountId: string, token: string): number {
    return createHmac('sha256', this.k.index)
      .update(`${accountId}\u0000${token}`, 'utf8')
      .digest()
      .readInt32BE(0);
  }

  webhookSecret(accountId: string): string {
    return createHmac('sha256', this.k.webhook).update(accountId, 'utf8').digest('base64url').slice(0, 43);
  }
}
