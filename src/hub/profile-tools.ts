import { z } from 'zod';
import type { ActionDefinition, AnyObjectSchema } from '../connectors/sdk.js';
import type { AccountRow } from '../core/accounts.js';
import type { ACCESS_LEVELS } from '../core/workspace-admin.js';
import { AppError } from '../lib/errors.js';
import type { SetupActionSpec, SetupContext } from './setup-tools.js';

type ProfileAccess = (typeof ACCESS_LEVELS)[number];

/** An access profile (persona) as the tools see it. */
export interface ProfileInfo {
  id: string;
  name: string;
  /** The last part of the profile's MCP address (`/mcp/<address>`); it never changes. */
  address: string;
  url: string;
  description: string | null;
  accountIds: string[];
  maxAccess: ProfileAccess;
  /** AI apps and personal tokens connected through this address now. */
  apps: number;
  tokens: number;
}

/**
 * What the profile tools need from the security layer. Defined here, implemented by
 * `WorkspaceProfileTools` (`src/security/assistant.ts`), so the hub does not depend on it.
 */
export interface WorkspaceProfiles {
  list(workspaceId: string): Promise<ProfileInfo[]>;
  /** By address, name (any case) or id. */
  find(workspaceId: string, ref: string): Promise<ProfileInfo>;
  create(
    workspaceId: string,
    input: {
      name: string;
      /** Made from the name when left out. */
      address?: string | undefined;
      description?: string | undefined;
      accountIds: string[];
      maxAccess: ProfileAccess;
    },
  ): Promise<ProfileInfo>;
  update(
    workspaceId: string,
    id: string,
    change: {
      name?: string | undefined;
      description?: string | null | undefined;
      accountIds?: string[] | undefined;
      maxAccess?: ProfileAccess | undefined;
    },
  ): Promise<ProfileInfo>;
  /** Deletes the profile; every app and token connected through its address is disconnected. */
  remove(workspaceId: string, id: string): Promise<ProfileInfo>;
}

const ORDER: Record<ProfileAccess, number> = { none: 0, read: 1, write: 2, full: 3 };
const PROFILE_ACCESS = ['read', 'write', 'full'] as const;

const accountList = z.array(z.string().min(1)).max(200);
const profileRef = z.string().trim().min(1).describe('Profile address, name or id');
const maxAccess = z
  .enum(PROFILE_ACCESS)
  .describe('The most an app on this profile may do: read · write (changes) · full (also sending, deleting)');

const ref = (a: AccountRow) => `${a.connectorId}:${a.name}`;

/** The profile for the AI: accounts by their "service:name", access and connections. */
async function profileView(p: ProfileInfo, ctx: SetupContext) {
  const accounts = await ctx.admin.accountsById(ctx.principal.workspaceId);
  return {
    profile: p.name,
    address: p.address,
    url: p.url,
    ...(p.description ? { description: p.description } : {}),
    accounts: p.accountIds.flatMap((id) => {
      const a = accounts.get(id);
      return a ? [ref(a)] : [];
    }),
    max_access: p.maxAccess,
    apps_connected: p.apps + p.tokens,
  };
}

async function accountIds(refs: readonly string[], ctx: SetupContext): Promise<string[]> {
  const rows = await Promise.all(refs.map((r) => ctx.admin.findAccount(ctx.principal.workspaceId, r)));
  return rows.map((a) => a.id);
}

const CONNECT_HINT =
  'Connect the AI app that should see only these accounts to the profile url (add it there as a new connector or MCP server; the user signs in once). Apps connected to the main address keep their access; the profile only ever narrows it, the access rules still apply.';

/**
 * The access profile tools (`manyplug_access_profiles`, `…_create_access_profile`,
 * `…_update_access_profile`, `…_delete_access_profile`): separate MCP addresses that show an AI app
 * only some accounts, with at most some access. Creating one or narrowing it applies at once;
 * anything that lets a profile's apps see or do more waits for the user's confirmation, and
 * deleting one (which disconnects its apps) always does.
 */
export function profileActions(
  define: <T extends AnyObjectSchema>(spec: SetupActionSpec<T>) => ActionDefinition,
): ActionDefinition[] {
  const profiles = (ctx: SetupContext): WorkspaceProfiles => {
    if (!ctx.profiles) throw new AppError(501, 'no_profiles', 'Access profiles are not available here');
    return ctx.profiles;
  };
  return [
    define({
      name: 'access_profiles',
      title: 'Show access profiles',
      description:
        'Lists access profiles: separate connection addresses that show an AI app only some accounts, with at most some access (e.g. a work AI that sees only work mail).',
      input: z.object({}),
      risk: 'read',
      hints: { readOnly: true, idempotent: true, openWorld: false },
      async run(_input, ctx) {
        const list = await profiles(ctx).list(ctx.principal.workspaceId);
        return {
          profiles: await Promise.all(list.map((p) => profileView(p, ctx))),
          hint: list.length
            ? CONNECT_HINT
            : 'No profiles yet. Create one with manyplug_create_access_profile.',
        };
      },
    }),
    define({
      name: 'create_access_profile',
      title: 'Create an access profile',
      description:
        'Creates an access profile: a new connection address for AI apps that should see only the given accounts, with at most max_access. Returns the address to connect the app to.',
      input: z.object({
        name: z.string().trim().min(1).max(100).describe('e.g. "Work"'),
        accounts: accountList.min(1).describe('Accounts the profile shows, e.g. ["gmail:work"]'),
        max_access: maxAccess.default('full'),
        address: z
          .string()
          .optional()
          .describe('Last part of the address, e.g. "work"; made from the name when left out'),
        description: z.string().trim().max(500).optional(),
      }),
      risk: 'write',
      hints: { openWorld: false },
      async run({ name, accounts, max_access, address, description }, ctx) {
        const created = await profiles(ctx).create(ctx.principal.workspaceId, {
          name,
          address,
          description,
          accountIds: await accountIds(accounts, ctx),
          maxAccess: max_access,
        });
        return { created: await profileView(created, ctx), next: CONNECT_HINT };
      },
    }),
    define({
      name: 'update_access_profile',
      title: 'Change an access profile',
      description:
        'Renames a profile, adds or removes its accounts, or changes its max_access. Narrowing applies at once; showing more accounts or allowing more waits for the user’s confirmation.',
      input: z.object({
        profile: profileRef,
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        add_accounts: accountList.optional(),
        remove_accounts: accountList.optional(),
        max_access: maxAccess.optional(),
      }),
      risk: 'write',
      hints: { idempotent: true, openWorld: false },
      // More accounts or more access for a profile's apps lifts a restriction: the user confirms it.
      async assessRisk({ profile, add_accounts, max_access }, ctx) {
        if (!add_accounts?.length && !max_access) return undefined;
        try {
          const current = await profiles(ctx).find(ctx.principal.workspaceId, profile);
          const added = (await accountIds(add_accounts ?? [], ctx)).filter(
            (id) => !current.accountIds.includes(id),
          );
          const raised = max_access !== undefined && ORDER[max_access] > ORDER[current.maxAccess];
          if (!added.length && !raised) return undefined;
          const what = [
            ...(added.length ? [`shows ${added.length} more account${added.length > 1 ? 's' : ''}`] : []),
            ...(raised ? [`allows ${max_access} access (was ${current.maxAccess})`] : []),
          ];
          return {
            risk: 'dangerous',
            confirm: true,
            reason: `Lowers your protection: profile ${current.name} ${what.join(' and ')}`,
          };
        } catch (error) {
          if (error instanceof AppError) return undefined; // run() reports the same problem
          // Fail closed: if the check cannot run, the user decides.
          return { risk: 'dangerous', confirm: true, reason: 'Changes an access profile' };
        }
      },
      async run({ profile, name, description, add_accounts, remove_accounts, max_access }, ctx) {
        const workspaceId = ctx.principal.workspaceId;
        const current = await profiles(ctx).find(workspaceId, profile);
        let ids: string[] | undefined;
        if (add_accounts?.length || remove_accounts?.length) {
          const removed = new Set(await accountIds(remove_accounts ?? [], ctx));
          const kept = current.accountIds.filter((id) => !removed.has(id));
          ids = [...new Set([...kept, ...(await accountIds(add_accounts ?? [], ctx))])];
        }
        const updated = await profiles(ctx).update(workspaceId, current.id, {
          name,
          description,
          accountIds: ids,
          maxAccess: max_access,
        });
        return { updated: await profileView(updated, ctx) };
      },
    }),
    define({
      name: 'delete_access_profile',
      title: 'Delete an access profile',
      description:
        'Deletes an access profile; every AI app connected through its address loses access. The user always confirms.',
      input: z.object({ profile: profileRef }),
      risk: 'dangerous',
      requiresConfirmation: true,
      hints: { destructive: true, openWorld: false },
      async run({ profile }, ctx) {
        const workspaceId = ctx.principal.workspaceId;
        const found = await profiles(ctx).find(workspaceId, profile);
        const removed = await profiles(ctx).remove(workspaceId, found.id);
        return { deleted: removed.name, disconnected: removed.apps + removed.tokens };
      },
    }),
  ];
}
