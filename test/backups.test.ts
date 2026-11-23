import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { S3Client, signV4 } from '../src/lib/s3.js';
import { createLogger } from '../src/logger.js';
import {
  BackupService,
  type DumpTools,
  decryptFile,
  encryptFile,
  libpqEnv,
  pgDumpTools,
} from '../src/ops/backups.js';
import { fakeS3 } from './fake-s3.js';
import { pgToolsMatchServer, TEST_DATABASE_URL } from './helpers.js';
import { databaseName, quoteIdent, siblingDatabaseUrl } from './setup/databases.js';

const logger = createLogger({ level: 'silent' });
const KEY = Buffer.alloc(32, 7);

describe('S3 request signing', () => {
  it('matches the AWS Signature V4 example (GET object with a range)', () => {
    const headers = signV4({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      query: {},
      headers: { Range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      date: new Date('2013-05-24T00:00:00Z'),
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

describe('backup encryption', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backup-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips and detects tampering and the wrong key', async () => {
    const plain = join(dir, 'plain');
    const sealed = join(dir, 'sealed');
    const back = join(dir, 'back');
    const data = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
    await writeFile(plain, data);
    await encryptFile(plain, sealed, KEY);
    const encrypted = await readFile(sealed);
    expect(encrypted.subarray(0, 4).toString()).toBe('MPBK');
    expect(encrypted.includes(data.subarray(1000, 1100))).toBe(false);
    await decryptFile(sealed, back, KEY);
    expect((await readFile(back)).equals(data)).toBe(true);

    await expect(decryptFile(sealed, back, Buffer.alloc(32, 8))).rejects.toThrow(
      /encrypted with another key/,
    );
    encrypted[5000] = (encrypted[5000] ?? 0) ^ 1;
    await writeFile(sealed, encrypted);
    await expect(decryptFile(sealed, back, KEY)).rejects.toThrow(/could not be decrypted/);

    // An empty dump still makes a valid file.
    await writeFile(plain, '');
    await encryptFile(plain, sealed, KEY);
    await decryptFile(sealed, back, KEY);
    expect((await readFile(back)).length).toBe(0);
  });

  it('passes connection details to pg tools through the environment', () => {
    expect(libpqEnv('postgres://user:p%40ss@db.internal:6543/app?sslmode=require')).toEqual({
      PGHOST: 'db.internal',
      PGPORT: '6543',
      PGDATABASE: 'app',
      PGUSER: 'user',
      PGPASSWORD: 'p@ss',
      PGSSLMODE: 'require',
    });
  });
});

describe('backup service', () => {
  const s3 = fakeS3();
  let endpoint: string;
  beforeAll(async () => {
    await new Promise<void>((resolve) => s3.server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(s3.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => s3.server.close(() => resolve()));
  });

  it('dumps, encrypts, uploads, lists, prunes and restores', async () => {
    let restored: Buffer | undefined;
    const tools: DumpTools = {
      dump: async (url, file) => writeFile(file, `dump of ${url}`),
      restore: async (_url, file) => {
        restored = await readFile(file);
      },
    };
    let now = new Date('2026-11-01T03:17:00Z');
    const store = new S3Client({
      endpoint,
      bucket: 'backups',
      region: 'auto',
      accessKeyId: 'key',
      secretAccessKey: 's',
    });
    const service = new BackupService({
      databaseUrl: 'postgres://db/app',
      store,
      key: KEY,
      prefix: 'hub/',
      retentionDays: 2,
      keepAtLeast: 1,
      tools,
      logger,
      now: () => now,
    });
    const first = await service.run();
    expect(first.key).toBe('hub/2026-11-01T03-17-00-000Z.pgdump.enc');
    // What is stored is encrypted.
    expect(s3.objects.get(first.key)!.body.includes(Buffer.from('dump of'))).toBe(false);
    s3.objects.set('hub/notes.txt', { body: Buffer.from('not a backup'), modified: new Date() });

    const keys = [first.key];
    for (const day of ['02', '03', '04']) {
      now = new Date(`2026-11-${day}T03:17:00Z`);
      keys.push((await service.run()).key);
    }
    // The storage dates its objects with its own clock: give each the day it was made.
    keys.forEach((key, i) => {
      s3.objects.get(key)!.modified = new Date(Date.UTC(2026, 10, i + 1));
    });
    expect(await service.prune()).toBe(2); // 1st and 2nd are older than 2 days
    const list = await service.list();
    expect(list.map((b) => b.key)).toEqual([
      'hub/2026-11-04T03-17-00-000Z.pgdump.enc',
      'hub/2026-11-03T03-17-00-000Z.pgdump.enc',
    ]);
    expect(s3.objects.has('hub/notes.txt')).toBe(true); // not ours: never deleted

    await service.restore(list[0]!.key, 'postgres://target/app');
    expect(restored?.toString()).toBe('dump of postgres://db/app');
    await expect(service.restore('hub/notes.txt', 'postgres://target/app')).rejects.toThrow(
      /Not a backup key/,
    );
    await expect(store.getFile('hub/missing.pgdump.enc', join(tmpdir(), 'x'))).rejects.toThrow(/NoSuchKey/);
  });

  it('wants the whole bucket configuration or none', () => {
    const base = { DATABASE_URL: TEST_DATABASE_URL, NODE_ENV: 'test' };
    expect(loadConfig(base).backups).toBeUndefined();
    expect(() => loadConfig({ ...base, BACKUP_S3_BUCKET: 'b' })).toThrow(/BACKUP_S3_ENDPOINT/);
    const config = loadConfig({
      ...base,
      BACKUP_S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com/',
      BACKUP_S3_BUCKET: 'b',
      BACKUP_S3_ACCESS_KEY_ID: 'k',
      BACKUP_S3_SECRET_ACCESS_KEY: 's',
      BACKUP_PREFIX: 'prod',
    });
    expect(config.backups).toMatchObject({
      storage: { endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto' },
      prefix: 'prod/',
      retentionDays: 30,
    });
  });
});

describe.skipIf(!pgToolsMatchServer() && !process.env.CI)('pg_dump and pg_restore', () => {
  // Next to this worker's own test database, so parallel workers never share it.
  const target = siblingDatabaseUrl(TEST_DATABASE_URL, 'restore');
  const restoreDb = quoteIdent(databaseName(target));

  it('restores a dump into another database', async () => {
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    const dir = await mkdtemp(join(tmpdir(), 'pgdump-'));
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${restoreDb}`);
      await admin.query(`CREATE DATABASE ${restoreDb}`);
      const file = join(dir, 'db.dump');
      await pgDumpTools.dump(TEST_DATABASE_URL, file);
      await pgDumpTools.restore(target, file);
      const restored = new pg.Client({ connectionString: target });
      await restored.connect();
      const tables = (src: pg.Client) =>
        src
          .query("select count(*)::int as n from information_schema.tables where table_schema = 'public'")
          .then((r) => r.rows[0].n as number);
      expect(await tables(restored)).toBe(await tables(admin));
      await restored.end();
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${restoreDb} WITH (FORCE)`).catch(() => {});
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
