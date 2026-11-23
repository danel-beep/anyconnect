import { runMigrations } from '../db/migrate.js';
import { checkRestoredDatabase, type RestoreReport } from '../ops/restore-check.js';
import { createServices, type Services } from '../services.js';

/** Same server and database name: restoring there would overwrite the hub's own data. */
function sameDatabase(a: string, b: string): boolean {
  const x = new URL(a);
  const y = new URL(b);
  return x.hostname === y.hostname && (x.port || '5432') === (y.port || '5432') && x.pathname === y.pathname;
}

/**
 * The practice restore (`backup:verify`): restores backup `key` into the scratch database at
 * `targetUrl`, migrates it to this build, and checks it with this server's keys. Nothing is started
 * on the copy (no jobs, no messenger sessions), so it is safe to run with production keys.
 */
export async function verifyBackup(
  services: Services,
  key: string,
  targetUrl: string,
): Promise<RestoreReport> {
  const backups = services.backups;
  if (!backups) throw new Error('Backups are not configured: set BACKUP_S3_* (see docs/OPERATIONS.md)');
  if (sameDatabase(targetUrl, services.config.database.url))
    throw new Error("--target-url is the hub's own database: verify into a new, empty one");
  await backups.restore(key, targetUrl);
  await runMigrations(targetUrl);
  const copy = createServices(
    { ...services.config, database: { ...services.config.database, url: targetUrl } },
    { logger: services.logger },
  );
  try {
    return await checkRestoredDatabase({
      pool: copy.database.pool,
      secrets: copy.secrets,
      accounts: copy.accounts,
    });
  } finally {
    await copy.close();
  }
}
