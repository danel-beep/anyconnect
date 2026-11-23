import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBackup } from '../src/cli/backup-verify.js';
import { loadConfig } from '../src/config.js';
import { getDefaultWorkspace } from '../src/core/identity.js';
import { runMigrations } from '../src/db/migrate.js';
import { users } from '../src/db/schema.js';
import { SecretBox } from '../src/lib/crypto.js';
import { S3Client } from '../src/lib/s3.js';
import { createLogger } from '../src/logger.js';
import { BackupService } from '../src/ops/backups.js';
import { migrationState } from '../src/ops/builtin-checks.js';
import { formatRestoreReport } from '../src/ops/restore-check.js';
import { createServices } from '../src/services.js';
import { fakeS3 } from './fake-s3.js';
import {
  ADMIN,
  pgToolsMatchServer,
  resetDatabase,
  resultJson,
  startTestHub,
  TEST_DATABASE_URL,
  TEST_KEY,
  TestBrowser,
  type TestHub,
} from './helpers.js';
import { MemoryOAuthProvider, type Tokens } from './oauth-app.js';
import { databaseName, quoteIdent, siblingDatabaseUrl } from './setup/databases.js';

/**
 * The practice restore from docs/OPERATIONS.md, run on every CI build: a hub with real data (an
 * owner with a browser session and an open vault, accounts encrypted with ENCRYPTION_KEY and one
 * sealed to the vault, an AI app signed in over OAuth, a personal token) is backed up with the real
 * `pg_dump`, restored with the real `pg_restore` into an empty database, and a hub started on the
 * copy with the same keys must carry on as if nothing happened: same sessions, same tokens, every
 * account's credentials still decrypt. CI installs a `pg_dump` matching its server, so there the
 * test always runs.
 */
describe.skipIf(!pgToolsMatchServer() && !process.env.CI)('practice restore from a backup', () => {
  const s3 = fakeS3();
  const target = siblingDatabaseUrl(TEST_DATABASE_URL, 'drill');
  const targetDb = quoteIdent(databaseName(target));
  let env: Record<string, string>;
  let hub: TestHub;
  let restoredHub: TestHub | undefined;
  let owner: TestBrowser;
  let app: MemoryOAuthProvider;
  let apiToken: string;
  let backupKey: string;
  const ACCOUNTS = ['main', 'second', 'sealed'];
  const before = new Map<string, string>();

  const connect = async (on: TestHub): Promise<Client> => {
    if (!app.savedTokens) {
      const first = new StreamableHTTPClientTransport(new URL(on.mcpUrl), { authProvider: app });
      await expect(new Client({ name: 'probe', version: '1.0.0' }).connect(first)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
      await first.finishAuth((await owner.authorize(app.authorizationUrl!)).searchParams);
    }
    const client = new Client({ name: 'drill', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(on.mcpUrl), { authProvider: app }));
    return client;
  };

  /** What each account's tool reports, including a fingerprint of its decrypted secret. */
  const fingerprints = async (on: TestHub): Promise<Map<string, string>> => {
    const client = await connect(on);
    try {
      const out = new Map<string, string>();
      for (const account of ACCOUNTS) {
        const result = await client.callTool({ name: 'demo_account_info', arguments: { account } });
        expect(result.isError, `${account}: ${JSON.stringify(result.content)}`).toBeFalsy();
        out.set(account, resultJson(result).secretFingerprint);
      }
      return out;
    } finally {
      await client.close();
    }
  };

  const tableCounts = async (url: string): Promise<Record<string, number>> => {
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      const { rows } = await db.query<{ schema: string; name: string }>(
        "select table_schema as schema, table_name as name from information_schema.tables where table_schema in ('public', 'drizzle') and table_type = 'BASE TABLE' order by 1, 2",
      );
      const out: Record<string, number> = {};
      for (const { schema, name } of rows) {
        const result = await db.query(
          `select count(*)::int as n from ${quoteIdent(schema)}.${quoteIdent(name)}`,
        );
        out[`${schema}.${name}`] = result.rows[0].n;
      }
      return out;
    } finally {
      await db.end();
    }
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) => s3.server.listen(0, '127.0.0.1', resolve));
    env = {
      BACKUP_S3_ENDPOINT: `http://127.0.0.1:${(s3.server.address() as AddressInfo).port}`,
      BACKUP_S3_BUCKET: 'backups',
      BACKUP_S3_ACCESS_KEY_ID: 'key',
      BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
    };
    await resetDatabase();
    // Seeded Demo accounts are encrypted with ENCRYPTION_KEY only (created before the vault).
    hub = await startTestHub({ env });
    owner = new TestBrowser(hub.baseUrl);
    await owner.login();
    await owner.request('/app'); // creates the owner's vault, its key in this browser's cookie
    const [user] = await hub.services.db.select().from(users).where(eq(users.email, ADMIN.email));
    const workspace = (await getDefaultWorkspace(hub.services.db, user!.id))!;
    const sealed = await hub.services.accounts.create(workspace.id, {
      connectorId: 'demo',
      name: 'sealed',
      label: 'Sealed',
      credentials: { secret: 'sealed-secret' },
    });
    expect(sealed.dataKeyEncrypted).toMatch(/^s1\./);
    app = new MemoryOAuthProvider();
    for (const [account, fingerprint] of await fingerprints(hub)) before.set(account, fingerprint);
    ({ token: apiToken } = await hub.services.apiTokens.create({
      workspaceId: workspace.id,
      userId: user!.id,
      name: 'drill',
      scopes: ['mcp', 'api'],
    }));

    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${targetDb} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${targetDb}`);
    await admin.end();
  });

  afterAll(async () => {
    await restoredHub?.close();
    await hub.close().catch(() => {});
    await new Promise<void>((resolve) => s3.server.close(() => resolve()));
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${targetDb} WITH (FORCE)`).catch(() => {});
    await admin.end();
  });

  it('backs up the live database and restores every row into an empty one', async () => {
    ({ key: backupKey } = await hub.services.backups!.run());
    expect((await hub.services.backups!.list()).map((b) => b.key)).toEqual([backupKey]);
    await hub.services.backups!.restore(backupKey, target);

    const source = await tableCounts(TEST_DATABASE_URL);
    expect(Object.keys(source).length).toBeGreaterThan(50);
    expect(source['public.accounts']).toBe(3);
    expect(await tableCounts(target)).toEqual(source);

    // The job queue is not part of a backup: pg-boss recreates its schema on start.
    const copy = new pg.Client({ connectionString: target });
    await copy.connect();
    const boss = await copy.query("select 1 from information_schema.schemata where schema_name = 'pgboss'");
    await copy.end();
    expect(boss.rowCount).toBe(0);
  });

  it('leaves the copy at the build’s migrations, and migrating it again changes nothing', async () => {
    const pool = new pg.Pool({ connectionString: target, max: 1 });
    try {
      const restored = await migrationState(pool);
      expect(restored.state).toBe('current');
      await runMigrations(target);
      await runMigrations(target);
      expect(await migrationState(pool)).toEqual(restored);
    } finally {
      await pool.end();
    }
    expect(await tableCounts(target)).toEqual(await tableCounts(TEST_DATABASE_URL));
  });

  it('backup:verify restores into a scratch database and opens its data with this server’s keys', async () => {
    await expect(verifyBackup(hub.services, backupKey, TEST_DATABASE_URL)).rejects.toThrow(
      /hub's own database/,
    );
    const report = await verifyBackup(hub.services, backupKey, target);
    expect(report).toMatchObject({
      ok: true,
      migrations: { state: 'current' },
      rows: { users: 1, accounts: 3 },
      envelopes: { unknownKeys: [] },
      // Seeded accounts open with ENCRYPTION_KEY; the sealed one only with its owner's vault.
      accounts: { readable: 2, sealed: 1, unreadable: [] },
    });
    expect(report.envelopes.checked).toBeGreaterThan(0);
    expect(formatRestoreReport(report)).toContain('The backup restores and its data opens with these keys.');
  });

  it('a hub on the copy with the same keys keeps sessions, tokens and every account', async () => {
    // Same address (same PUBLIC_URL), the way DATABASE_URL is switched to the restored database.
    const port = Number(new URL(hub.baseUrl).port);
    await hub.close();
    restoredHub = await startTestHub({ env, databaseUrl: target, keepData: true, port });
    expect(restoredHub.baseUrl).toBe(hub.baseUrl);

    // The browser is still signed in.
    expect((await owner.request('/app')).status).toBe(200);

    // The AI app's access token works and every account decrypts to the same secret, sealed included.
    expect(await fingerprints(restoredHub)).toEqual(before);

    // Its refresh token too.
    const refreshed = await fetch(`${restoredHub.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: app.savedTokens!.refresh_token!,
        client_id: app.client!.client_id,
      }),
    });
    expect(refreshed.status).toBe(200);
    app.savedTokens = (await refreshed.json()) as Tokens;
    expect(await fingerprints(restoredHub)).toEqual(before);

    // And the personal token.
    const api = await fetch(`${restoredHub.baseUrl}/api/v1/accounts`, {
      headers: { authorization: `Bearer ${apiToken}` },
    });
    expect(api.status).toBe(200);
    expect(JSON.stringify(await api.json())).toContain('sealed');

    // The health checks agree (migrations current, jobs and database fine).
    const report = await restoredHub.services.ops.health.run({ timeoutMs: 10_000 });
    expect(report.checks.find((c) => c.name === 'migrations')?.status).toBe('ok');
  });

  it('restores with the old key after ENCRYPTION_KEY is rotated, and refuses a stranger’s key', async () => {
    const logger = createLogger({ level: 'silent' });
    const store = new S3Client({
      endpoint: env.BACKUP_S3_ENDPOINT!,
      bucket: 'backups',
      region: 'auto',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });
    const service = (secrets: SecretBox) =>
      new BackupService({
        databaseUrl: target,
        store,
        key: secrets.deriveKey('backup'),
        previousKeys: secrets.deriveKeys('backup'),
        prefix: 'manyplug/',
        retentionDays: 30,
        logger,
      });
    const stranger = Buffer.alloc(32, 9).toString('base64');
    await expect(service(new SecretBox(stranger)).restore(backupKey, target)).rejects.toThrow(
      /encrypted with another key/,
    );
    // Rotated: the new key is primary, the backup's key is in ENCRYPTION_KEYS_PREVIOUS.
    await restoredHub!.close();
    restoredHub = undefined;
    await service(new SecretBox(stranger, [TEST_KEY])).restore(backupKey, target);
    expect(await tableCounts(target)).toMatchObject({ 'public.accounts': 3 });
  });

  it('backup:verify names what a lost ENCRYPTION_KEY makes unreadable', async () => {
    // The backup key was kept, ENCRYPTION_KEY was not: the copy restores but its secrets stay shut.
    const services = createServices(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: TEST_DATABASE_URL,
        ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
        BACKUP_ENCRYPTION_KEY: new SecretBox(TEST_KEY).deriveKey('backup').toString('base64'),
        LOG_LEVEL: 'silent',
        JOBS_ENABLED: 'false',
        ...env,
      }),
      { logger: createLogger({ level: 'silent' }) },
    );
    try {
      const report = await verifyBackup(services, backupKey, target);
      expect(report.ok).toBe(false);
      expect(report.accounts).toMatchObject({ readable: 0, sealed: 1 });
      expect(report.accounts.unreadable).toHaveLength(2);
      expect(report.envelopes.unknownKeys.map((u) => u.column)).toContain('accounts.data_key_encrypted');
      expect(formatRestoreReport(report)).toContain('PROBLEMS FOUND');
    } finally {
      await services.close();
    }
  });
});
