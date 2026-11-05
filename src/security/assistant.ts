import type { AppInfo, WorkspaceApps } from '../hub/app-tools.js';
import type { ProfileInfo, WorkspaceProfiles } from '../hub/profile-tools.js';
import type { SecurityStatus, UserSecurity } from '../hub/security-tools.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { AiApp, AiAppService } from './apps.js';
import type { NotificationChannels } from './notifications.js';
import { PERSONA_SLUG, type PersonaRow, type PersonaService } from './personas.js';

/** The AI app tools' view of apps (`manyplug_apps` and friends): profiles by name. */
export class WorkspaceAppTools implements WorkspaceApps {
  constructor(
    private readonly apps: AiAppService,
    private readonly personas: PersonaService,
  ) {}

  private async info(workspaceId: string, apps: AiApp[]): Promise<AppInfo[]> {
    const names = new Map((await this.personas.list(workspaceId)).map((p) => [p.id, p.name]));
    return apps.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      lastUsedAt: a.lastUsedAt,
      connections: a.connections.map((c) => ({
        kind: c.kind,
        profile: c.personaId ? (names.get(c.personaId) ?? null) : null,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt,
        expiresAt: c.expiresAt,
      })),
    }));
  }

  async list(workspaceId: string): Promise<AppInfo[]> {
    return this.info(workspaceId, await this.apps.list(workspaceId));
  }

  async find(workspaceId: string, ref: string): Promise<AppInfo> {
    const [app] = await this.info(workspaceId, [await this.apps.find(workspaceId, ref)]);
    return app!;
  }

  async rename(workspaceId: string, id: string, name: string): Promise<AppInfo> {
    const [app] = await this.info(workspaceId, [await this.apps.rename(workspaceId, id, name)]);
    return app!;
  }

  disconnect(workspaceId: string, id: string): Promise<{ signIns: number; tokens: number }> {
    return this.apps.disconnect(workspaceId, id);
  }
}

/**
 * The access profile tools' view of personas (`manyplug_access_profiles` and friends): profiles
 * found by address, name or id, with how many apps use each one.
 */
export class WorkspaceProfileTools implements WorkspaceProfiles {
  constructor(private readonly personas: PersonaService) {}

  private info(row: PersonaRow, used: { apps: number; tokens: number } | undefined): ProfileInfo {
    return {
      id: row.id,
      name: row.name,
      address: row.slug,
      url: this.personas.urlFor(row.slug),
      description: row.description,
      accountIds: row.accountIds,
      maxAccess: row.maxAccess,
      apps: used?.apps ?? 0,
      tokens: used?.tokens ?? 0,
    };
  }

  async list(workspaceId: string): Promise<ProfileInfo[]> {
    const [rows, used] = await Promise.all([
      this.personas.list(workspaceId),
      this.personas.connections(workspaceId),
    ]);
    return rows.map((row) => this.info(row, used.get(row.id)));
  }

  async find(workspaceId: string, ref: string): Promise<ProfileInfo> {
    const all = await this.list(workspaceId);
    const wanted = ref.trim().toLowerCase();
    const byKey = all.find((p) => p.id === ref || p.address === wanted);
    if (byKey) return byKey;
    const byName = all.filter((p) => p.name.toLowerCase() === wanted);
    if (byName.length === 1) return byName[0]!;
    if (byName.length === 0) throw notFound(`Access profile "${ref}"`);
    throw badRequest(
      `Several profiles are called "${ref}": use one of the addresses ${byName.map((p) => p.address).join(', ')}.`,
    );
  }

  async create(workspaceId: string, input: Parameters<WorkspaceProfiles['create']>[1]): Promise<ProfileInfo> {
    const address = input.address?.trim().toLowerCase();
    if (address !== undefined && !PERSONA_SLUG.test(address)) {
      throw badRequest('The address takes 1–32 lowercase letters, digits or "-", e.g. "work".');
    }
    const row = await this.personas.create(workspaceId, {
      slug: address || (await this.personas.freeSlug(workspaceId, input.name)),
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      accountIds: input.accountIds,
      maxAccess: input.maxAccess,
    });
    return this.info(row, undefined);
  }

  async update(
    workspaceId: string,
    id: string,
    change: Parameters<WorkspaceProfiles['update']>[2],
  ): Promise<ProfileInfo> {
    await this.personas.update(
      workspaceId,
      id,
      Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)),
    );
    return this.find(workspaceId, id);
  }

  async remove(workspaceId: string, id: string): Promise<ProfileInfo> {
    const profile = await this.find(workspaceId, id);
    await this.personas.delete(workspaceId, id);
    return profile;
  }
}

/**
 * The security tool's view of the user (`manyplug_security`): second factors, ways in, signed-in
 * browsers and the Telegram approval channel, with the pages where each is changed. Read only.
 */
export class UserSecurityTools implements UserSecurity {
  constructor(
    private readonly deps: {
      secondFactors: (userId: string) => Promise<{ totp: boolean; passkeys: number; recoveryCodes: number }>;
      /** Whether the user has a password, and the sign-in providers linked to them. */
      signIn: (userId: string) => Promise<{ password: boolean; providers: string[] }>;
      /** Live dashboard sessions of the user. */
      sessions: (userId: string) => Promise<number>;
      /** The Telegram channel; absent when this server has no Telegram bot. */
      telegram?: NotificationChannels | undefined;
      requireSecondFactor: boolean;
      publicUrl: string;
    },
  ) {}

  async status(userId: string): Promise<SecurityStatus> {
    const { deps } = this;
    const [factors, signIn, sessions, channels] = await Promise.all([
      deps.secondFactors(userId),
      deps.signIn(userId),
      deps.sessions(userId),
      deps.telegram?.status(userId),
    ]);
    const telegram = channels?.telegram;
    return {
      twoStep: {
        authenticatorApp: factors.totp,
        passkeys: factors.passkeys,
        recoveryCodes: factors.recoveryCodes,
        required: deps.requireSecondFactor,
      },
      signInWith: [...(signIn.password ? ['password'] : []), ...new Set(signIn.providers)],
      sessions,
      telegram: telegram
        ? {
            linked: telegram.linked,
            label: telegram.label,
            since: telegram.linkedAt ? new Date(telegram.linkedAt) : null,
          }
        : null,
      urls: {
        security: `${deps.publicUrl}/security`,
        sessions: `${deps.publicUrl}/app/settings#sessions`,
        telegram: `${deps.publicUrl}/confirm#telegram`,
      },
    };
  }
}
