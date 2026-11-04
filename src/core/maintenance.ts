import { and, lt, notExists, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthGrants,
  oauthTokens,
  pendingLogins,
  toolCalls,
  webauthnChallenges,
  webSessions,
} from '../db/schema.js';
import type { Logger } from '../logger.js';

const DAY = 86_400_000;

/** Deletes expired security artifacts and old audit entries. Safe to run on every instance. */
export async function runMaintenance(db: Db, options: { auditRetentionDays?: number } = {}): Promise<void> {
  const now = Date.now();
  await db.delete(oauthAuthorizationCodes).where(lt(oauthAuthorizationCodes.expiresAt, new Date(now - DAY)));
  await db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, new Date(now - DAY)));
  await db.delete(webSessions).where(lt(webSessions.expiresAt, new Date(now)));
  await db.delete(pendingLogins).where(lt(pendingLogins.expiresAt, new Date(now)));
  await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, new Date(now)));
  // Dynamically registered clients that never completed an authorization within 30 days.
  await db
    .delete(oauthClients)
    .where(
      and(
        sql`${oauthClients.registrationType} = 'dynamic'`,
        lt(oauthClients.createdAt, new Date(now - 30 * DAY)),
        notExists(
          db
            .select({ one: sql`1` })
            .from(oauthGrants)
            .where(sql`${oauthGrants.clientId} = ${oauthClients.id}`),
        ),
      ),
    );
  // Revoked grants are kept for a while for the audit trail, then removed.
  await db.delete(oauthGrants).where(lt(oauthGrants.revokedAt, new Date(now - 30 * DAY)));
  const retention = options.auditRetentionDays ?? 90;
  await db.delete(toolCalls).where(lt(toolCalls.createdAt, new Date(now - retention * DAY)));
}

export function scheduleMaintenance(db: Db, logger: Logger, intervalMs = 60 * 60_000): () => void {
  const run = () => runMaintenance(db).catch((err) => logger.warn({ err }, 'maintenance failed'));
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
