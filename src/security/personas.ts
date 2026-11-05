import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { accounts, personas } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { ACCESS_LEVELS } from './policy.js';

export type PersonaRow = typeof personas.$inferSelect;

/** URL segment of a persona's MCP endpoint: `/mcp/<slug>`. */
export const PERSONA_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** `/mcp/team/<slug>` is a team's MCP URL, so no persona may be called `team`. */
const RESERVED_PERSONA_SLUGS = new Set(['team']);

export const CreatePersonaInput = z.object({
  slug: z
    .string()
    .regex(PERSONA_SLUG, 'use 1-32 lowercase letters, digits or "-"')
    .refine((slug) => !RESERVED_PERSONA_SLUGS.has(slug), 'this name is reserved'),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  accountIds: z.array(z.string()).max(1000).default([]),
  maxAccess: z.enum(ACCESS_LEVELS).default('full'),
});
export type CreatePersonaInput = z.input<typeof CreatePersonaInput>;

/** The slug is immutable: grants are bound to the persona's URL. */
export const UpdatePersonaInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  accountIds: z.array(z.string()).max(1000).optional(),
  maxAccess: z.enum(ACCESS_LEVELS).optional(),
});
export type UpdatePersonaInput = z.input<typeof UpdatePersonaInput>;

export interface PersonaView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  accountIds: string[];
  maxAccess: PersonaRow['maxAccess'];
  mcpUrl: string;
  createdAt: string;
  updatedAt: string;
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw badRequest(
      'Invalid persona',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/**
 * Personas: named slices of a workspace ("Работа", "Личное"), each with its own MCP URL. An AI app
 * connected to `/mcp/<slug>` only sees that persona's accounts, capped at its access level.
 */
export class PersonaService {
  constructor(
    private readonly db: Db,
    /** The hub's root MCP URL, e.g. https://hub.example.com/mcp */
    private readonly mcpUrl: string,
  ) {}

  urlFor(slug: string): string {
    return `${this.mcpUrl}/${slug}`;
  }

  /** The persona slug of a canonical resource URL (`<mcpUrl>/<slug>`), if it is one. */
  slugOfResource(resource: string): string | undefined {
    if (!resource.startsWith(`${this.mcpUrl}/`)) return undefined;
    const slug = resource.slice(this.mcpUrl.length + 1);
    return PERSONA_SLUG.test(slug) ? slug : undefined;
  }

  toView(row: PersonaRow): PersonaView {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      accountIds: row.accountIds,
      maxAccess: row.maxAccess,
      mcpUrl: this.urlFor(row.slug),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(workspaceId: string): Promise<PersonaRow[]> {
    return this.db
      .select()
      .from(personas)
      .where(eq(personas.workspaceId, workspaceId))
      .orderBy(asc(personas.createdAt));
  }

  async get(workspaceId: string, id: string): Promise<PersonaRow> {
    const [row] = await this.db
      .select()
      .from(personas)
      .where(and(eq(personas.workspaceId, workspaceId), eq(personas.id, id)))
      .limit(1);
    if (!row) throw notFound('Persona');
    return row;
  }

  async bySlug(workspaceId: string, slug: string): Promise<PersonaRow | undefined> {
    const [row] = await this.db
      .select()
      .from(personas)
      .where(and(eq(personas.workspaceId, workspaceId), eq(personas.slug, slug)))
      .limit(1);
    return row;
  }

  private async checkAccounts(workspaceId: string, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const found = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.id, unique)));
    const known = new Set(found.map((r) => r.id));
    const missing = unique.filter((id) => !known.has(id));
    if (missing.length) throw badRequest(`Unknown accounts: ${missing.join(', ')}`);
    return unique;
  }

  async create(workspaceId: string, raw: CreatePersonaInput): Promise<PersonaRow> {
    const input = parse(CreatePersonaInput, raw);
    if (await this.bySlug(workspaceId, input.slug)) {
      throw conflict(`A persona with the address "${input.slug}" already exists`);
    }
    const [row] = await this.db
      .insert(personas)
      .values({
        id: newId('prs'),
        workspaceId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        accountIds: await this.checkAccounts(workspaceId, input.accountIds),
        maxAccess: input.maxAccess,
      })
      .returning();
    return row!;
  }

  async update(workspaceId: string, id: string, raw: UpdatePersonaInput): Promise<PersonaRow> {
    const input = parse(UpdatePersonaInput, raw);
    await this.get(workspaceId, id);
    const patch: Partial<typeof personas.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.maxAccess !== undefined) patch.maxAccess = input.maxAccess;
    if (input.accountIds !== undefined)
      patch.accountIds = await this.checkAccounts(workspaceId, input.accountIds);
    if (Object.keys(patch).length === 0) return this.get(workspaceId, id);
    const [row] = await this.db
      .update(personas)
      .set(patch)
      .where(and(eq(personas.workspaceId, workspaceId), eq(personas.id, id)))
      .returning();
    return row!;
  }

  /** Deleting a persona disconnects every app and token bound to its URL. */
  async delete(workspaceId: string, id: string): Promise<void> {
    const deleted = await this.db
      .delete(personas)
      .where(and(eq(personas.workspaceId, workspaceId), eq(personas.id, id)))
      .returning({ id: personas.id });
    if (deleted.length === 0) throw notFound('Persona');
  }
}
