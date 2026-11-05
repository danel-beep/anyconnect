import { z } from 'zod';
import type { ActionDefinition, AnyObjectSchema } from '../connectors/sdk.js';
import { ownerText } from './catalog.js';
import type { SetupActionSpec } from './setup-tools.js';

/**
 * The team tools (`manyplug_team`, `manyplug_share_account`, `manyplug_invite_member`,
 * `manyplug_remove_member`): a team is run from the chat like the rest of the hub. Each person acts
 * as themselves; sharing an account and adding a person widen who sees data, so they wait for the
 * user's confirmation, while narrowing applies at once. Who may do what is decided in
 * `WorkspaceAdmin` (owners and admins run the team; only an account's owner shares it).
 */

/** Team tools that only make sense inside a team (hidden elsewhere, see `teamCatalogFilter`). */
export const TEAM_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'share_account',
  'invite_member',
  'remove_member',
]);

const LEVEL_TEXT = {
  read: 'read only',
  write: 'read and change',
  full: 'everything, including sending and deleting',
};

const ShareInput = z.object({
  account: z.string().min(1).describe('One of the user’s own accounts, "service:account", e.g. "gmail:ann"'),
  with: z
    .string()
    .trim()
    .min(1)
    .describe('A member (handle, email or name), or "team" for everyone in the team'),
  access: z
    .enum(['read', 'write', 'full'])
    .nullable()
    .describe('read: only reading · write: reading and changes · full: everything · null: stop sharing'),
});

export function teamActions(
  define: <T extends AnyObjectSchema>(spec: SetupActionSpec<T>) => ActionDefinition,
): ActionDefinition[] {
  return [
    define({
      name: 'team',
      title: 'Team',
      description:
        'Shows the team: its members and roles, the team’s connector URL, whose each account is and who it is shared with, and open invitations (for admins). In a personal workspace it lists the user’s teams.',
      input: z.object({}),
      risk: 'read',
      hints: { readOnly: true, idempotent: true, openWorld: false },
      async run(_input, ctx) {
        const o = await ctx.admin.teamOverview(ctx.principal);
        if (o.personal) {
          return {
            personal_workspace: true,
            teams: o.teams.map((t) => ({ team: t.team.name, role: t.role, members: t.members })),
            hint: 'This connection is the user’s personal space. A team has its own connector URL (shown on the Team page of the website); each member adds it to their AI app and signs in as themselves.',
          };
        }
        const { view } = o;
        return {
          team: view.team.name,
          connector_url: o.url,
          ...(view.member
            ? { you: { name: view.member.name, handle: view.member.handle, role: view.member.role } }
            : { shared_connection: true }),
          members: o.members.map((m) => ({ name: m.name, handle: m.handle, role: m.role })),
          accounts: o.accounts.map((a) => ({
            account: `${a.account.connectorId}:${a.account.name}`,
            label: a.account.label,
            whose: ownerText(a.owner),
            ...(a.manages && a.sharedWith.length ? { shared_with: a.sharedWith } : {}),
          })),
          ...(o.invitations.length
            ? {
                invitations: o.invitations.map((i) => ({
                  email: i.email,
                  role: i.role,
                  expires: i.expiresAt.toISOString().slice(0, 10),
                })),
              }
            : {}),
          hint: 'Each member connects their own accounts (manyplug_connect_account) and decides who else may use them (manyplug_share_account). Admins do not see members’ accounts unless they are shared.',
        };
      },
    }),
    define({
      name: 'share_account',
      title: 'Share an account in the team',
      description:
        'Lets a team member (or the whole team) use one of the user’s own accounts at a level, or stops sharing (access null). Sharing more waits for the user’s confirmation; sharing less applies at once.',
      input: ShareInput,
      risk: 'write',
      hints: { idempotent: true, openWorld: false },
      async assessRisk({ account, with: withRef, access }, ctx) {
        try {
          if (!(await ctx.admin.shareWidens(ctx.principal, account, withRef, access))) return undefined;
        } catch {
          return undefined; // run() reports the problem
        }
        const who = withRef.toLowerCase() === 'team' ? 'everyone in the team' : withRef;
        return {
          risk: 'dangerous',
          confirm: true,
          reason: `Lets ${who} use ${account}: ${LEVEL_TEXT[access!]}`,
        };
      },
      async run({ account, with: withRef, access }, ctx) {
        const result = await ctx.admin.shareAccount(ctx.principal, account, withRef, access);
        const ref = `${result.account.connectorId}:${result.account.name}`;
        return access
          ? { shared: ref, with: result.with, access, meaning: LEVEL_TEXT[access] }
          : { stopped_sharing: ref, with: result.with };
      },
    }),
    define({
      name: 'invite_member',
      title: 'Invite a person to the team',
      description:
        'Team admins: creates an invitation link for a person’s email address. Give the user the link to send; only someone signed in with that address can accept it. The user always confirms.',
      input: z.object({
        email: z.email(),
        role: z.enum(['member', 'admin']).default('member'),
      }),
      risk: 'dangerous',
      requiresConfirmation: true,
      hints: { destructive: false, openWorld: false },
      async run({ email, role }, ctx) {
        const { invitation, url } = await ctx.admin.inviteMember(ctx.principal, { email, role });
        return {
          invited: invitation.email,
          role: invitation.role,
          url,
          expires: invitation.expiresAt.toISOString().slice(0, 10),
          instructions:
            'Ask the user to send this link to the person. They sign in with that email address and accept; then they add the team’s connector to their own AI app and sign in as themselves.',
        };
      },
    }),
    define({
      name: 'remove_member',
      title: 'Remove a person from the team',
      description:
        'Team admins: removes a member. Their own accounts go back to their personal space, shares with them end and their AI apps lose access to the team. The user always confirms.',
      input: z.object({ member: z.string().trim().min(1).describe('Handle, email or name') }),
      risk: 'dangerous',
      requiresConfirmation: true,
      hints: { destructive: true, openWorld: false },
      async run({ member }, ctx) {
        const result = await ctx.admin.removeMember(ctx.principal, member);
        return {
          removed: result.member.name,
          their_accounts_moved_to_their_personal_space: result.moved,
          ...(result.removed.length ? { their_accounts_disconnected: result.removed } : {}),
        };
      },
    }),
  ];
}
