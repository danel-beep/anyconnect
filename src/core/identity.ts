import { and, asc, eq } from 'drizzle-orm';
import type { Db, DbExecutor } from '../db/client.js';
import { type UserRole, users, workspaceMembers, workspaces } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(db: DbExecutor, email: string): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  return user;
}

export async function getUser(db: DbExecutor, id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

/** Creates a user together with their personal workspace. */
export async function createUser(
  db: Db,
  input: { email: string; password?: string; name?: string; role?: UserRole },
): Promise<{ user: User; workspace: Workspace }> {
  // Accounts created through an external sign-in (Google) have no password.
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        id: newId('usr'),
        email: normalizeEmail(input.email),
        name: input.name ?? null,
        passwordHash,
        role: input.role ?? 'user',
      })
      .returning();
    const [workspace] = await tx
      .insert(workspaces)
      .values({ id: newId('wsp'), name: 'Personal', settings: { toolExposure: 'grouped' } })
      .returning();
    await tx.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: user!.id, role: 'owner' });
    return { user: user!, workspace: workspace! };
  });
}

export async function setPassword(db: DbExecutor, userId: string, password: string): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(users.id, userId));
}

export async function authenticate(
  db: DbExecutor,
  email: string,
  password: string,
): Promise<User | undefined> {
  const user = await findUserByEmail(db, email);
  if (!user?.passwordHash) {
    // Spend comparable time so response timing does not reveal whether the email exists.
    await verifyPassword(
      password,
      'scrypt$32768$8$1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g',
    );
    return undefined;
  }
  return (await verifyPassword(password, user.passwordHash)) ? user : undefined;
}

/** The workspace a user works in by default (their first one). */
export async function getDefaultWorkspace(db: DbExecutor, userId: string): Promise<Workspace | undefined> {
  const [row] = await db
    .select({ workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt))
    .limit(1);
  return row?.workspace;
}

export async function isWorkspaceMember(
  db: DbExecutor,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)))
    .limit(1);
  return Boolean(row);
}

export async function getWorkspace(db: DbExecutor, id: string): Promise<Workspace | undefined> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return workspace;
}

/**
 * Makes sure the bootstrap owner from ADMIN_EMAIL / ADMIN_PASSWORD exists.
 * The environment is the source of truth: changing ADMIN_PASSWORD and restarting resets the password.
 */
export async function ensureAdmin(
  db: Db,
  admin: { email: string; password: string },
): Promise<{ user: User; workspace: Workspace; created: boolean; passwordUpdated: boolean }> {
  const existing = await findUserByEmail(db, admin.email);
  if (!existing) {
    const { user, workspace } = await createUser(db, {
      email: admin.email,
      password: admin.password,
      role: 'admin',
    });
    return { user, workspace, created: true, passwordUpdated: false };
  }
  if (existing.role !== 'admin') await db.update(users).set({ role: 'admin' }).where(eq(users.id, existing.id));
  let passwordUpdated = false;
  if (!existing.passwordHash || !(await verifyPassword(admin.password, existing.passwordHash))) {
    await setPassword(db, existing.id, admin.password);
    passwordUpdated = true;
  }
  let workspace = await getDefaultWorkspace(db, existing.id);
  if (!workspace) {
    const [created] = await db
      .insert(workspaces)
      .values({ id: newId('wsp'), name: 'Personal' })
      .returning();
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: created!.id, userId: existing.id, role: 'owner' });
    workspace = created!;
  }
  return { user: existing, workspace, created: false, passwordUpdated };
}
