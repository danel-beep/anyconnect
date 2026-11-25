import { createHmac } from 'node:crypto';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { ConnectorError, type HubFile, type HubFileInfo, type HubFiles } from '../connectors/sdk.js';
import type { Db } from '../db/client.js';
import { accounts, hubFiles } from '../db/schema.js';
import { DataKey, type SecretBox } from '../lib/crypto.js';
import { isId, newId } from '../lib/ids.js';

/** Limits of the file store; tests shrink them. */
export interface FileStoreLimits {
  /** Largest single file (Telegram uploads photos up to 10 MB and other files up to 50 MB). */
  maxBytes: number;
  /** Total size of the live files of one workspace. */
  maxWorkspaceBytes: number;
  /** How long a file is kept after it was last put. */
  ttlMs: number;
}

export const DEFAULT_FILE_LIMITS: FileStoreLimits = {
  maxBytes: 20 * 1_048_576,
  maxWorkspaceBytes: 200 * 1_048_576,
  ttlMs: 24 * 3_600_000,
};

const keyContext = (id: string) => `file:${id}:dek`;
const dataContext = (id: string) => `file:${id}:data`;
const nameContext = (id: string) => `file:${id}:name`;

type Row = typeof hubFiles.$inferSelect;
/** A row without its bytes: what every read but {@link FileStore.open} needs. */
type Meta = Omit<Row, 'data'>;

/** Every column but `data`, so stat, dedupe and expiry reads never pull a file's bytes. */
const META = {
  id: hubFiles.id,
  workspaceId: hubFiles.workspaceId,
  contentKey: hubFiles.contentKey,
  nameEncrypted: hubFiles.nameEncrypted,
  mimeType: hubFiles.mimeType,
  size: hubFiles.size,
  dataKeyEncrypted: hubFiles.dataKeyEncrypted,
  expiresAt: hubFiles.expiresAt,
  createdAt: hubFiles.createdAt,
} satisfies Record<keyof Meta, unknown>;

/**
 * Short-lived encrypted files of a workspace, the store behind `ctx.files` (see {@link HubFiles}
 * and docs/FILES.md). Each file has its own data key wrapped by the master key, so a deleted row
 * cannot be read from a backup copy of another. Putting the same bytes under the same name again
 * returns the same file with a fresh expiry: ids stay stable, so identical sends are still
 * recognized as duplicates.
 */
export class FileStore {
  readonly limits: FileStoreLimits;
  private readonly contentKey: Buffer;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
    limits: Partial<FileStoreLimits> = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.limits = { ...DEFAULT_FILE_LIMITS, ...limits };
    // Only deduplicates: a key that changes on rotation merely stops merging copies until they expire.
    this.contentKey = secrets.deriveKey('hub-files/content-key');
  }

  /** The store as one workspace's connectors see it. */
  forWorkspace(workspaceId: string): HubFiles {
    return {
      maxBytes: this.limits.maxBytes,
      put: (file) => this.put(workspaceId, file),
      get: async (id) => this.open(await this.require(workspaceId, id, true)),
      stat: async (id) => this.info(await this.require(workspaceId, id, false)),
    };
  }

  async put(
    workspaceId: string,
    file: { data: Uint8Array; name: string; mimeType: string },
  ): Promise<HubFileInfo> {
    const size = file.data.byteLength;
    if (size === 0) throw new ConnectorError('invalid_input', 'The file is empty.');
    if (size > this.limits.maxBytes) {
      throw new ConnectorError(
        'invalid_input',
        `The file is ${mb(size)} MB; the hub passes on files up to ${mb(this.limits.maxBytes)} MB.`,
      );
    }
    const name = cleanName(file.name);
    const mimeType = cleanMime(file.mimeType);
    // The name is part of the key: a copy is only shared with whoever already knows both the bytes
    // and the name, so putting a file never tells someone else's name for it (members of a team
    // share their workspace's store).
    const contentKey = createHmac('sha256', this.contentKey)
      .update(workspaceId)
      .update('\0')
      .update(name)
      .update('\0')
      .update(file.data)
      .digest('base64url');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.limits.ttlMs);

    return this.db.transaction(async (tx) => {
      // One writer per workspace at a time keeps the total below the limit.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hub-files:${workspaceId}`}))`);
      const [existing] = await tx
        .select({ id: hubFiles.id, expiresAt: hubFiles.expiresAt })
        .from(hubFiles)
        .where(and(eq(hubFiles.workspaceId, workspaceId), eq(hubFiles.contentKey, contentKey)))
        .limit(1);
      if (existing && existing.expiresAt > now) {
        const [row] = await tx
          .update(hubFiles)
          .set({ expiresAt })
          .where(eq(hubFiles.id, existing.id))
          .returning(META);
        return this.info(row!);
      }
      if (existing) await tx.delete(hubFiles).where(eq(hubFiles.id, existing.id));
      const [usage] = await tx
        .select({ total: sql<string | null>`sum(${hubFiles.size})` })
        .from(hubFiles)
        .where(and(eq(hubFiles.workspaceId, workspaceId), gt(hubFiles.expiresAt, now)));
      if (Number(usage?.total ?? 0) + size > this.limits.maxWorkspaceBytes) {
        throw new ConnectorError(
          'invalid_input',
          `The hub already keeps ${mb(this.limits.maxWorkspaceBytes)} MB of files for this workspace; they expire within a day. Try again later or send a link instead.`,
        );
      }
      const id = newId('file');
      const key = DataKey.generate();
      const [row] = await tx
        .insert(hubFiles)
        .values({
          id,
          workspaceId,
          contentKey,
          nameEncrypted: key.encrypt(name, nameContext(id)),
          mimeType,
          size,
          dataKeyEncrypted: key.wrap(this.secrets, keyContext(id)),
          data: key.encryptBytes(file.data, dataContext(id)),
          expiresAt,
        })
        .returning(META);
      return this.info(row!, name);
    });
  }

  /**
   * A file of the workspace an account belongs to (the outbox knows accounts, not workspaces), or
   * undefined when it is gone or expired.
   */
  async getForAccount(accountId: string, id: string): Promise<HubFile | undefined> {
    if (!isId('file', id)) return undefined;
    const [row] = await this.db
      .select({ file: hubFiles })
      .from(hubFiles)
      .innerJoin(accounts, eq(accounts.workspaceId, hubFiles.workspaceId))
      .where(and(eq(accounts.id, accountId), eq(hubFiles.id, id), gt(hubFiles.expiresAt, this.now())))
      .limit(1);
    return row ? this.open(row.file) : undefined;
  }

  /** Deletes expired files (background job); returns how many. */
  async prune(): Promise<number> {
    const removed = await this.db
      .delete(hubFiles)
      .where(lte(hubFiles.expiresAt, this.now()))
      .returning({ id: hubFiles.id });
    return removed.length;
  }

  private async require(workspaceId: string, id: string, withData: true): Promise<Row>;
  private async require(workspaceId: string, id: string, withData: false): Promise<Meta>;
  private async require(workspaceId: string, id: string, withData: boolean): Promise<Meta> {
    const [row] = isId('file', id)
      ? await this.db
          .select(withData ? { ...META, data: hubFiles.data } : META)
          .from(hubFiles)
          .where(
            and(
              eq(hubFiles.id, id),
              eq(hubFiles.workspaceId, workspaceId),
              gt(hubFiles.expiresAt, this.now()),
            ),
          )
          .limit(1)
      : [];
    if (!row) {
      throw new ConnectorError(
        'not_found',
        `File "${id}" not found: the hub keeps files for about a day. Fetch it again (e.g. with get_attachment).`,
      );
    }
    return row;
  }

  private key(row: Meta): DataKey {
    return DataKey.unwrap(this.secrets, row.dataKeyEncrypted, keyContext(row.id));
  }

  private info(row: Meta, name?: string): HubFileInfo {
    return {
      id: row.id,
      name: name ?? this.key(row).decrypt(row.nameEncrypted, nameContext(row.id)),
      mimeType: row.mimeType,
      size: row.size,
      expiresAt: row.expiresAt,
    };
  }

  private open(row: Row): HubFile {
    const key = this.key(row);
    const plain = key.decryptBytes(row.data, dataContext(row.id));
    return {
      id: row.id,
      name: key.decrypt(row.nameEncrypted, nameContext(row.id)),
      mimeType: row.mimeType,
      size: row.size,
      expiresAt: row.expiresAt,
      // A plain view of the decrypted bytes, not a second copy of the file.
      data: new Uint8Array(plain.buffer, plain.byteOffset, plain.byteLength),
    };
  }
}

function mb(bytes: number): string {
  const value = bytes / 1_048_576;
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

/** A file name safe to show and to send: no path, no control characters, at most 200 characters. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.slice(0, 200) || 'file';
}

function cleanMime(mimeType: string): string {
  const value = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value) ? value : 'application/octet-stream';
}
