import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { BRAND } from '../brand.js';
import type { Db } from '../db/client.js';
import {
  accessRules,
  accountShares,
  accounts,
  aiClients,
  aiKeys,
  apiTokens,
  customConnectors,
  notificationChannels,
  oauthGrants,
  personas,
  referrals,
  standingApprovals,
  subscriptions,
  toolCalls,
  triggers,
  userIdentities,
  users,
  userTotp,
  webauthnCredentials,
  webSessions,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import { notFound } from '../lib/errors.js';

/** At most this many activity entries go into an export (the newest ones). */
export const EXPORT_ACTIVITY_LIMIT = 10_000;

/** A trigger as the export shows it; the spec is read by whoever can decrypt it. */
export interface ExportedTrigger {
  id: string;
  name: string;
  enabled: boolean;
  source: string;
  service: string | null;
  accountIds: string[];
  dailyRuns: number | null;
  createdAt: Date;
  [key: string]: unknown;
}

/**
 * Everything the hub keeps about one person, as a document they can download (data portability).
 *
 * Every column is named here on purpose: a new column does not leak into exports until someone
 * adds it. Never included: passwords, tokens and their hashes, service credentials, encryption
 * keys, second-factor secrets. Messenger chats are not included either: they are a copy of what
 * the messenger itself holds, and the person exports them there.
 *
 * Scope: the person's own profile and sign-in data, everything in their personal workspace, and
 * for teams only the membership and the person's own accounts there (a team's rules, activity and
 * other members' accounts are not one member's data, whoever owns the team).
 */
export class DataExportService {
  constructor(
    private readonly deps: {
      db: Db;
      publicUrl: string;
      /** Triggers of a workspace with their decrypted definitions (the triggers subsystem). */
      triggers?: (workspaceId: string) => Promise<ExportedTrigger[]>;
    },
  ) {}

  async forUser(userId: string, now = new Date()): Promise<Record<string, unknown>> {
    const { db } = this.deps;
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        status: users.status,
        locale: users.locale,
        hasPassword: users.passwordHash,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw notFound('User');

    const memberships = await db
      .select({
        workspaceId: workspaces.id,
        name: workspaces.name,
        kind: workspaces.kind,
        settings: workspaces.settings,
        createdAt: workspaces.createdAt,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, userId));
    const personal = memberships.filter((m) => m.role === 'owner' && m.kind === 'personal');
    const teamIds = memberships.filter((m) => !personal.includes(m)).map((m) => m.workspaceId);

    const [identities, sessions, totp, passkeys, channels, grants, referred] = await Promise.all([
      db
        .select({
          provider: userIdentities.provider,
          email: userIdentities.email,
          createdAt: userIdentities.createdAt,
          lastUsedAt: userIdentities.lastUsedAt,
        })
        .from(userIdentities)
        .where(eq(userIdentities.userId, userId)),
      db
        .select({
          createdAt: webSessions.createdAt,
          lastSeenAt: webSessions.lastSeenAt,
          expiresAt: webSessions.expiresAt,
          ip: webSessions.ip,
          userAgent: webSessions.userAgent,
        })
        .from(webSessions)
        .where(eq(webSessions.userId, userId)),
      db.select({ confirmedAt: userTotp.confirmedAt }).from(userTotp).where(eq(userTotp.userId, userId)),
      db
        .select({
          name: webauthnCredentials.name,
          deviceType: webauthnCredentials.deviceType,
          createdAt: webauthnCredentials.createdAt,
          lastUsedAt: webauthnCredentials.lastUsedAt,
        })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, userId)),
      db
        .select({
          kind: notificationChannels.kind,
          label: notificationChannels.label,
          verifiedAt: notificationChannels.verifiedAt,
          createdAt: notificationChannels.createdAt,
        })
        .from(notificationChannels)
        .where(eq(notificationChannels.userId, userId)),
      db
        .select({
          app: oauthGrants.clientName,
          workspaceId: oauthGrants.workspaceId,
          scopes: oauthGrants.scopes,
          createdAt: oauthGrants.createdAt,
          lastUsedAt: oauthGrants.lastUsedAt,
        })
        .from(oauthGrants)
        .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt))),
      db
        .select({ status: referrals.status, reward: referrals.reward, createdAt: referrals.createdAt })
        .from(referrals)
        .where(eq(referrals.referrerUserId, userId)),
    ]);

    const accountColumns = {
      id: accounts.id,
      workspaceId: accounts.workspaceId,
      service: accounts.connectorId,
      name: accounts.name,
      label: accounts.label,
      description: accounts.description,
      config: accounts.config,
      enabled: accounts.enabled,
      status: accounts.status,
      statusMessage: accounts.statusMessage,
      settings: accounts.settings,
      identity: accounts.metadata,
      createdAt: accounts.createdAt,
      lastUsedAt: accounts.lastUsedAt,
    };
    const identityOf = <T extends { identity: { identity?: string } }>(row: T) => ({
      ...row,
      identity: typeof row.identity.identity === 'string' ? row.identity.identity : null,
    });

    return {
      about: {
        product: BRAND.name,
        site: this.deps.publicUrl,
        exportedAt: now,
        notes: [
          'Passwords, tokens, service credentials and encryption keys are never exported.',
          'Messenger chats are not included: they are a copy of what the messenger itself keeps.',
          `Activity holds the newest ${EXPORT_ACTIVITY_LIMIT} entries of each of your workspaces.`,
        ],
      },
      profile: { ...user, hasPassword: user.hasPassword !== null },
      signIn: {
        providers: identities,
        twoStepCodes: totp.some((row) => row.confirmedAt !== null),
        passkeys,
        sessions,
      },
      notificationChannels: channels,
      connectedAiApps: grants,
      invitedPeople: referred,
      memberOf: memberships.map(({ settings: _settings, ...m }) => m),
      accountsInTeams: teamIds.length
        ? (
            await db
              .select(accountColumns)
              .from(accounts)
              .where(and(eq(accounts.ownerUserId, userId), inArray(accounts.workspaceId, teamIds)))
          ).map(identityOf)
        : [],
      workspaces: await Promise.all(
        personal.map(async (workspace) => {
          const id = workspace.workspaceId;
          const [own, shares, rules, apps, profiles, tokens, approvals, services, keys, plan, activity] =
            await Promise.all([
              db.select(accountColumns).from(accounts).where(eq(accounts.workspaceId, id)),
              db
                .select({
                  accountId: accountShares.accountId,
                  userId: accountShares.userId,
                  access: accountShares.access,
                  createdAt: accountShares.createdAt,
                })
                .from(accountShares)
                .where(eq(accountShares.workspaceId, id)),
              db
                .select({
                  aiAppId: accessRules.aiClientId,
                  profileId: accessRules.personaId,
                  service: accessRules.connectorId,
                  accountId: accessRules.accountId,
                  access: accessRules.access,
                  confirm: accessRules.confirm,
                  undoWindowSeconds: accessRules.undoWindowSeconds,
                  note: accessRules.note,
                  createdAt: accessRules.createdAt,
                })
                .from(accessRules)
                .where(eq(accessRules.workspaceId, id)),
              db
                .select({
                  id: aiClients.id,
                  name: aiClients.name,
                  kind: aiClients.kind,
                  createdAt: aiClients.createdAt,
                  lastUsedAt: aiClients.lastUsedAt,
                })
                .from(aiClients)
                .where(eq(aiClients.workspaceId, id)),
              db
                .select({
                  id: personas.id,
                  name: personas.name,
                  description: personas.description,
                  accountIds: personas.accountIds,
                  maxAccess: personas.maxAccess,
                  createdAt: personas.createdAt,
                })
                .from(personas)
                .where(eq(personas.workspaceId, id)),
              db
                .select({
                  name: apiTokens.name,
                  startsWith: apiTokens.tokenPrefix,
                  scopes: apiTokens.scopes,
                  createdAt: apiTokens.createdAt,
                  lastUsedAt: apiTokens.lastUsedAt,
                  expiresAt: apiTokens.expiresAt,
                  revokedAt: apiTokens.revokedAt,
                })
                .from(apiTokens)
                .where(eq(apiTokens.workspaceId, id)),
              db
                .select({
                  holder: standingApprovals.holder,
                  service: standingApprovals.connectorId,
                  accountId: standingApprovals.accountId,
                  actions: standingApprovals.actions,
                  uses: standingApprovals.uses,
                  maxUses: standingApprovals.maxUses,
                  expiresAt: standingApprovals.expiresAt,
                  revokedAt: standingApprovals.revokedAt,
                  createdAt: standingApprovals.createdAt,
                })
                .from(standingApprovals)
                .where(eq(standingApprovals.workspaceId, id)),
              db
                .select({
                  service: customConnectors.connectorId,
                  kind: customConnectors.kind,
                  createdAt: customConnectors.createdAt,
                })
                .from(customConnectors)
                .where(eq(customConnectors.workspaceId, id)),
              db
                .select({
                  provider: aiKeys.provider,
                  label: aiKeys.label,
                  model: aiKeys.model,
                  endsWith: aiKeys.keyHint,
                  dailyRuns: aiKeys.dailyRuns,
                  createdAt: aiKeys.createdAt,
                })
                .from(aiKeys)
                .where(eq(aiKeys.workspaceId, id)),
              db
                .select({
                  plan: subscriptions.planId,
                  status: subscriptions.status,
                  interval: subscriptions.interval,
                  currentPeriodEnd: subscriptions.currentPeriodEnd,
                  cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
                })
                .from(subscriptions)
                .where(eq(subscriptions.workspaceId, id)),
              db
                .select({
                  at: toolCalls.createdAt,
                  tool: toolCalls.toolName,
                  service: toolCalls.connectorId,
                  action: toolCalls.action,
                  accountId: toolCalls.accountId,
                  aiAppId: toolCalls.clientId,
                  status: toolCalls.status,
                  outcome: toolCalls.outcome,
                  risk: toolCalls.risk,
                  error: toolCalls.errorMessage,
                  durationMs: toolCalls.durationMs,
                })
                .from(toolCalls)
                .where(eq(toolCalls.workspaceId, id))
                .orderBy(desc(toolCalls.createdAt))
                .limit(EXPORT_ACTIVITY_LIMIT),
            ]);
          return {
            id,
            name: workspace.name,
            kind: workspace.kind,
            settings: workspace.settings,
            createdAt: workspace.createdAt,
            plan: plan[0] ?? null,
            accounts: own.map(identityOf),
            accountShares: shares,
            rules,
            aiApps: apps,
            profiles,
            personalTokens: tokens,
            standingApprovals: approvals,
            customServices: services,
            aiKeys: keys,
            triggers: (await this.deps.triggers?.(id)) ?? (await this.triggerNames(id)),
            activity,
          };
        }),
      ),
    };
  }

  /** Without the triggers subsystem: what a trigger is, not what it says. */
  private triggerNames(workspaceId: string) {
    return this.deps.db
      .select({
        id: triggers.id,
        name: triggers.name,
        enabled: triggers.enabled,
        source: triggers.source,
        service: triggers.connectorId,
        accountIds: triggers.accountIds,
        dailyRuns: triggers.dailyRuns,
        createdAt: triggers.createdAt,
      })
      .from(triggers)
      .where(eq(triggers.workspaceId, workspaceId));
  }
}
