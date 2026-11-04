import type { ProfileInfo, WorkspaceProfiles } from '../hub/profile-tools.js';
import { badRequest, notFound } from '../lib/errors.js';
import { PERSONA_SLUG, type PersonaRow, type PersonaService } from './personas.js';

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
