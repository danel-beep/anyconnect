import {
  type IPeersRepository,
  type ITelegramStorageProvider,
  MemoryAuthKeysRepository,
  MemoryKeyValueRepository,
  MemoryPeersRepository,
  MemoryRefMessagesRepository,
  MemoryStorageDriver,
} from '@mtcute/core';
import type { ConnectorLogger } from '../../../connectors/sdk.js';
import type { SessionState } from '../types.js';

/** Peers are kept in this many state rows, so one new contact rewrites a small row, not all of them. */
export const PEER_BUCKETS = 64;

const AUTH_KEY = 'tg:auth';
const KV_KEY = 'tg:kv';
const PEERS_PREFIX = 'tg:peers:';

interface PeerJson {
  id: number;
  accessHash: string;
  isMin: boolean;
  usernames: string[];
  updated: number;
  phone?: string;
  complete: string;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

export function peerBucket(id: number): number {
  return Math.abs(id) % PEER_BUCKETS;
}

/**
 * mtcute storage on top of the gateway's encrypted, lease-fenced session state (Postgres), so a
 * restart or another gateway instance continues the same Telegram session.
 *
 * Everything is served from memory. Permanent auth keys are written at once (mtcute requires it);
 * key-value data (update state, DC list, current user) and the peer cache (access hashes, needed
 * to write to people) are written in batches shortly after mtcute asks to save, and on stop.
 * Losing a batch in a crash only means fetching some updates twice, which the message store
 * deduplicates. Temporary keys and reference messages stay in memory.
 */
export class StateStorage implements ITelegramStorageProvider {
  readonly driver: StateStorageDriver;
  readonly kv: MemoryKeyValueRepository;
  readonly authKeys: MemoryAuthKeysRepository;
  readonly peers: MemoryPeersRepository;
  readonly refMessages: MemoryRefMessagesRepository;

  constructor(state: SessionState, logger: ConnectorLogger, options: { flushDelayMs?: number } = {}) {
    const driver = new StateStorageDriver(state, logger, options.flushDelayMs ?? 2_000);
    this.driver = driver;
    this.kv = new TrackedKeyValue(driver);
    this.authKeys = new PersistedAuthKeys(driver);
    this.peers = new TrackedPeers(driver);
    this.refMessages = new MemoryRefMessagesRepository(driver);
  }

  /** True when a login was saved (a permanent key for some data center). */
  hasLogin(): boolean {
    return this.driver.authKeys().size > 0;
  }

  /** Writes everything pending now (before stopping). */
  flush(): Promise<void> {
    return this.driver.flush();
  }
}

class StateStorageDriver extends MemoryStorageDriver {
  private kvDirty = false;
  private readonly dirtyBuckets = new Set<number>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private loaded: Promise<void> | undefined;

  constructor(
    readonly state: SessionState,
    private readonly logger: ConnectorLogger,
    private readonly flushDelayMs: number,
  ) {
    super();
  }

  authKeys(): Map<number, Uint8Array> {
    return this.getState('authKeys', () => ({
      authKeys: new Map<number, Uint8Array>(),
      authKeysTemp: new Map<string, Uint8Array>(),
      authKeysTempExpiry: new Map<string, number>(),
    })).authKeys;
  }

  kvMap(): Map<string, Uint8Array> {
    return this.getState('kv', () => new Map<string, Uint8Array>());
  }

  peerMap(): Map<number, IPeersRepository.PeerInfo> {
    return this.getState('peers', () => ({
      entities: new Map<number, IPeersRepository.PeerInfo>(),
      usernameIndex: new Map<string, number>(),
      phoneIndex: new Map<string, number>(),
    })).entities;
  }

  override load(): Promise<void> {
    this.loaded ??= this.read();
    return this.loaded;
  }

  private async read(): Promise<void> {
    const auth = (await this.state.get<Record<string, string>>(AUTH_KEY)) ?? {};
    for (const [dc, key] of Object.entries(auth)) this.authKeys().set(Number(dc), fromBase64(key));
    const kv = (await this.state.get<Record<string, string>>(KV_KEY)) ?? {};
    for (const [key, value] of Object.entries(kv)) this.kvMap().set(key, fromBase64(value));
    const peers = new MemoryPeersRepository(this);
    for (const { value } of await this.state.list<PeerJson[]>(PEERS_PREFIX)) {
      for (const peer of value) {
        peers.store({
          id: peer.id,
          accessHash: peer.accessHash,
          isMin: peer.isMin,
          usernames: peer.usernames,
          updated: peer.updated,
          ...(peer.phone ? { phone: peer.phone } : {}),
          complete: fromBase64(peer.complete),
        });
      }
    }
  }

  markKv(): void {
    this.kvDirty = true;
  }

  markPeer(id: number | 'all'): void {
    if (id === 'all') for (let b = 0; b < PEER_BUCKETS; b++) this.dirtyBuckets.add(b);
    else this.dirtyBuckets.add(peerBucket(id));
  }

  async saveAuthKeys(): Promise<void> {
    const auth: Record<string, string> = {};
    for (const [dc, key] of this.authKeys()) auth[String(dc)] = toBase64(key);
    if (Object.keys(auth).length === 0) await this.state.delete(AUTH_KEY);
    else await this.state.set(AUTH_KEY, auth);
  }

  /** mtcute asks to save often (after every batch of updates): coalesce into one write. */
  save(): void {
    if (this.timer || (!this.kvDirty && this.dirtyBuckets.size === 0)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush().catch((error) => this.logger.warn({ err: error }, 'could not save the Telegram session'));
    }, this.flushDelayMs);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // One flush at a time; a flush requested meanwhile runs after it with the newer data.
    while (this.flushing) await this.flushing;
    this.flushing = this.write().finally(() => {
      this.flushing = undefined;
    });
    await this.flushing;
  }

  private async write(): Promise<void> {
    if (this.kvDirty) {
      this.kvDirty = false;
      const kv: Record<string, string> = {};
      for (const [key, value] of this.kvMap()) kv[key] = toBase64(value);
      try {
        await this.state.set(KV_KEY, kv);
      } catch (error) {
        this.kvDirty = true;
        throw error;
      }
    }
    const buckets = [...this.dirtyBuckets];
    this.dirtyBuckets.clear();
    const grouped = new Map<number, PeerJson[]>(buckets.map((b) => [b, []]));
    for (const peer of this.peerMap().values()) {
      grouped.get(peerBucket(peer.id))?.push({
        id: peer.id,
        accessHash: peer.accessHash,
        isMin: peer.isMin,
        usernames: peer.usernames,
        updated: peer.updated,
        ...(peer.phone ? { phone: peer.phone } : {}),
        complete: toBase64(peer.complete),
      });
    }
    for (const [bucket, peers] of grouped) {
      try {
        if (peers.length === 0) await this.state.delete(`${PEERS_PREFIX}${bucket}`);
        else await this.state.set(`${PEERS_PREFIX}${bucket}`, peers);
      } catch (error) {
        for (const b of grouped.keys()) this.dirtyBuckets.add(b);
        throw error;
      }
    }
  }

  destroy(): Promise<void> {
    return this.flush();
  }
}

class TrackedKeyValue extends MemoryKeyValueRepository {
  constructor(private readonly owner: StateStorageDriver) {
    super(owner);
  }

  override set(key: string, value: Uint8Array): void {
    super.set(key, value);
    this.owner.markKv();
  }

  override delete(key: string): void {
    super.delete(key);
    this.owner.markKv();
  }

  override deleteAll(): void {
    super.deleteAll();
    this.owner.markKv();
  }
}

class PersistedAuthKeys extends MemoryAuthKeysRepository {
  constructor(private readonly owner: StateStorageDriver) {
    super(owner);
  }

  override async set(dc: number, key: Uint8Array | null): Promise<void> {
    super.set(dc, key);
    await this.owner.saveAuthKeys();
  }

  override async deleteByDc(dc: number): Promise<void> {
    super.deleteByDc(dc);
    await this.owner.saveAuthKeys();
  }

  override async deleteAll(): Promise<void> {
    super.deleteAll();
    await this.owner.saveAuthKeys();
  }
}

class TrackedPeers extends MemoryPeersRepository {
  constructor(private readonly owner: StateStorageDriver) {
    super(owner);
  }

  override store(peer: IPeersRepository.PeerInfo): void {
    super.store(peer);
    this.owner.markPeer(peer.id);
  }

  override deleteAll(): void {
    super.deleteAll();
    this.owner.markPeer('all');
  }
}
