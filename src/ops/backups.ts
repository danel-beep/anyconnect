import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BRAND } from '../brand.js';
import type { S3Object } from '../lib/s3.js';
import type { Logger } from '../logger.js';
import { scrubSecrets } from './scrub.js';

/**
 * Database backups to S3-compatible storage (Cloudflare R2, Backblaze B2, AWS S3, MinIO): a
 * `pg_dump` in custom format, encrypted with AES-256-GCM before it leaves the server, uploaded,
 * and older ones pruned. They complement the hosting provider's own backups (Render keeps
 * point-in-time recovery on paid databases): a copy outside the provider, under the owner's
 * control. Restoring is a CLI command (`backup:restore`), never automatic.
 */

/** Where backups go: an S3-compatible bucket (see `S3Client`). */
export interface BackupStore {
  putFile(key: string, path: string, contentType?: string): Promise<void>;
  getFile(key: string, path: string): Promise<void>;
  list(prefix: string): Promise<S3Object[]>;
  delete(key: string): Promise<void>;
}

/** Makes and restores a dump file (`pg_dump` / `pg_restore`; replaceable in tests). */
export interface DumpTools {
  dump(databaseUrl: string, file: string, signal?: AbortSignal): Promise<void>;
  restore(databaseUrl: string, file: string, signal?: AbortSignal): Promise<void>;
}

const SUFFIX = '.pgdump.enc';
const MAGIC = Buffer.from('MPBK');
const VERSION = 1;
const KEY_ID_BYTES = 8;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + KEY_ID_BYTES + IV_BYTES;

export function backupKeyId(key: Buffer): string {
  return createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, KEY_ID_BYTES * 2);
}

/**
 * Encrypts `source` into `target`: magic, version, key id, IV, AES-256-GCM ciphertext, tag. The
 * header is authenticated too (AAD), so a tampered or truncated file fails to decrypt.
 */
export async function encryptFile(source: string, target: string, key: Buffer): Promise<void> {
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), Buffer.from(backupKeyId(key), 'hex'), iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  let started = false;
  const encrypt = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const out = cipher.update(chunk);
      if (!started) {
        started = true;
        return done(null, Buffer.concat([header, out]));
      }
      done(null, out);
    },
    flush(done) {
      const final = cipher.final();
      done(null, Buffer.concat([started ? Buffer.alloc(0) : header, final, cipher.getAuthTag()]));
    },
  });
  await pipeline(createReadStream(source), encrypt, createWriteStream(target, { mode: 0o600 }));
}

export async function decryptFile(source: string, target: string, key: Buffer): Promise<void> {
  // One open file for the size, the header, the tag and the ciphertext: nothing can swap it between.
  const handle = await open(source, 'r');
  try {
    const { size } = await handle.stat();
    if (size < HEADER_BYTES + TAG_BYTES) throw new Error('Not a backup file (too short)');
    const header = Buffer.alloc(HEADER_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`Not a ${BRAND.name} backup file`);
    if (header[MAGIC.length] !== VERSION)
      throw new Error(`Unsupported backup format ${header[MAGIC.length]}`);
    const keyId = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + KEY_ID_BYTES).toString('hex');
    if (keyId !== backupKeyId(key)) {
      throw new Error(
        `This backup was encrypted with another key (id ${keyId}, current ${backupKeyId(key)}): set BACKUP_ENCRYPTION_KEY, or the ENCRYPTION_KEY the backup was made with`,
      );
    }
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(HEADER_BYTES - IV_BYTES));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    try {
      await pipeline(
        size === HEADER_BYTES + TAG_BYTES
          ? Readable.from([]) // an empty dump
          : handle.createReadStream({ start: HEADER_BYTES, end: size - TAG_BYTES - 1, autoClose: false }),
        decipher,
        createWriteStream(target, { mode: 0o600 }),
      );
    } catch (error) {
      await rm(target, { force: true });
      throw new Error(`The backup could not be decrypted (damaged or modified): ${(error as Error).message}`);
    }
  } finally {
    await handle.close();
  }
}

/** libpq environment for a connection URL, so the password never appears in a process list. */
export function libpqEnv(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  const env: Record<string, string> = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

function run(command: string, args: string[], databaseUrl: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...libpqEnv(databaseUrl) },
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(signal ? { signal } : {}),
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'ENOENT'
          ? new Error(
              `${command} is not installed (the Docker image ships it; install postgresql-client locally)`,
            )
          : error,
      ),
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (exit ${code}): ${scrubSecrets(stderr.trim(), 1000)}`));
    });
  });
}

export const pgDumpTools: DumpTools = {
  dump: (databaseUrl, file, signal) =>
    run(
      'pg_dump',
      // pg-boss rebuilds its own schema; its queue is not worth restoring.
      [
        '--format=custom',
        '--compress=6',
        '--no-owner',
        '--no-acl',
        '--exclude-schema=pgboss',
        `--file=${file}`,
      ],
      databaseUrl,
      signal,
    ),
  restore: (databaseUrl, file, signal) =>
    run(
      'pg_restore',
      [
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-acl',
        '--single-transaction',
        '--exit-on-error',
        // Only the name: host, user and password come from the environment.
        `--dbname=${libpqEnv(databaseUrl).PGDATABASE}`,
        file,
      ],
      databaseUrl,
      signal,
    ),
};

export interface BackupInfo {
  key: string;
  size: number;
  createdAt: Date;
}

export class BackupService {
  private readonly tools: DumpTools;
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      databaseUrl: string;
      store: BackupStore;
      key: Buffer;
      /** Key prefix in the bucket, e.g. `manyplug/`. */
      prefix: string;
      retentionDays: number;
      /** Kept whatever their age, so an outage of the job never deletes the last good copies. */
      keepAtLeast?: number;
      tools?: DumpTools;
      logger: Logger;
      now?: () => Date;
    },
  ) {
    this.tools = deps.tools ?? pgDumpTools;
    this.now = deps.now ?? (() => new Date());
  }

  /** Dumps, encrypts and uploads the database, then prunes old backups. */
  async run(signal?: AbortSignal): Promise<BackupInfo & { pruned: number }> {
    const started = Date.now();
    const createdAt = this.now();
    const key = `${this.deps.prefix}${createdAt.toISOString().replace(/[:.]/g, '-')}${SUFFIX}`;
    const dir = await mkdtemp(join(tmpdir(), 'backup-'));
    try {
      const dump = join(dir, 'db.dump');
      const sealed = join(dir, 'db.dump.enc');
      await this.tools.dump(this.deps.databaseUrl, dump, signal);
      await encryptFile(dump, sealed, this.deps.key);
      await rm(dump);
      const { size } = await stat(sealed);
      await this.deps.store.putFile(key, sealed);
      const pruned = await this.prune();
      this.deps.logger.info({ key, size, ms: Date.now() - started, pruned }, 'database backup uploaded');
      return { key, size, createdAt, pruned };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Backups in the bucket, newest first. */
  async list(): Promise<BackupInfo[]> {
    const objects = await this.deps.store.list(this.deps.prefix);
    return objects
      .filter((o) => o.key.endsWith(SUFFIX))
      .map((o) => ({ key: o.key, size: o.size, createdAt: o.lastModified }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Deletes backups older than the retention, keeping at least the newest few. */
  async prune(): Promise<number> {
    const cutoff = this.now().getTime() - this.deps.retentionDays * 86_400_000;
    const old = (await this.list())
      .slice(this.deps.keepAtLeast ?? 3)
      .filter((backup) => backup.createdAt.getTime() < cutoff);
    for (const backup of old) await this.deps.store.delete(backup.key);
    return old.length;
  }

  /**
   * Downloads a backup, decrypts it and restores it into `targetUrl` in one transaction (existing
   * tables of the dump are dropped and recreated). Destructive for the target: the CLI asks for
   * an explicit target and confirmation.
   */
  async restore(key: string, targetUrl: string, signal?: AbortSignal): Promise<void> {
    if (!key.endsWith(SUFFIX)) throw new Error(`Not a backup key: ${key}`);
    const dir = await mkdtemp(join(tmpdir(), 'restore-'));
    try {
      const sealed = join(dir, 'db.dump.enc');
      const dump = join(dir, 'db.dump');
      await this.deps.store.getFile(key, sealed);
      await decryptFile(sealed, dump, this.deps.key);
      await rm(sealed);
      await this.tools.restore(targetUrl, dump, signal);
      this.deps.logger.info({ key }, 'database restored from backup');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
