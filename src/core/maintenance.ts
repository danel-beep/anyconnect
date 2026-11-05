import { and, eq, gt, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  apiTokens,
  loginStates,
  oauthAuthorizationCodes,
  oauthClients,
  oauthConnectStates,
  oauthGrants,
  oauthTokens,
  pendingLogins,
  toolCalls,
  vaultDeviceRequests,
  vaultWraps,
  webauthnChallenges,
  webSessions,
} from '../db/schema.js';
import type { PgErrorStore } from '../ops/error-store.js';
import type { ErrorReporter } from '../ops/errors.js';
import type { StatusService } from '../ops/status.js';

const DAY = 86_400_000;

/** Deletes expired security artifacts and old audit entries. Safe to run on every instance. */
export async function runMaintenance(db: Db, options: { auditRetentionDays?: number } = {}): Promise<void> {
  const now = Date.now();
  await db.delete(oauthAuthorizationCodes).where(lt(oauthAuthorizationCodes.expiresAt, new Date(now - DAY)));
  await db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, new Date(now - DAY)));
  // Vault wraps of OAuth tokens that no longer exist, and of codes never exchanged.
  await db
    .delete(vaultWraps)
    .where(
      and(
        eq(vaultWraps.kind, 'oauth'),
        notExists(
          db.select({ one: sql`1` }).from(oauthTokens).where(eq(oauthTokens.tokenHash, vaultWraps.ref)),
        ),
      ),
    );
  await db
    .delete(vaultWraps)
    .where(and(eq(vaultWraps.kind, 'oauth_code'), lt(vaultWraps.createdAt, new Date(now - DAY))));
  // Personal tokens revoked or expired some other way (a suspended user, an expiry date).
  await db.delete(vaultWraps).where(
    and(
      eq(vaultWraps.kind, 'api_token'),
      notExists(
        db
          .select({ one: sql`1` })
          .from(apiTokens)
          .where(
            and(
              eq(apiTokens.id, vaultWraps.ref),
              isNull(apiTokens.revokedAt),
              or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date(now))),
            ),
          ),
      ),
    ),
  );
  // Browsers that asked to open a vault and were never approved (DEVICE_REQUEST_TTL_MS).
  await db.delete(vaultDeviceRequests).where(lt(vaultDeviceRequests.createdAt, new Date(now - 7 * DAY)));
  await db.delete(webSessions).where(lt(webSessions.expiresAt, new Date(now)));
  await db.delete(pendingLogins).where(lt(pendingLogins.expiresAt, new Date(now)));
  await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, new Date(now)));
  // Abandoned "connect an account" OAuth flows.
  await db.delete(oauthConnectStates).where(lt(oauthConnectStates.expiresAt, new Date(now)));
  // Abandoned "Sign in with Google" flows.
  await db.delete(loginStates).where(lt(loginStates.expiresAt, new Date(now)));
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

export function scheduleMaintenance(
  deps: {
    db: Db;
    ops: { errors: ErrorReporter; errorStore: PgErrorStore; status: StatusService };
    config: { ops: { errorRetentionDays: number } };
  },
  intervalMs = 60 * 60_000,
): () => void {
  const run = async () => {
    try {
      await runMaintenance(deps.db);
      await deps.ops.errorStore.prune(deps.config.ops.errorRetentionDays);
      await deps.ops.status.prune();
    } catch (error) {
      deps.ops.errors.capture(error, { source: 'maintenance' });
    }
  };
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
