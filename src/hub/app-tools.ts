import { z } from 'zod';
import type { ActionDefinition, AnyObjectSchema } from '../connectors/sdk.js';
import { AppError, badRequest } from '../lib/errors.js';
import type { SetupActionSpec, SetupContext } from './setup-tools.js';

/** An AI app as the tools see it: its live sign-ins and tokens. */
export interface AppInfo {
  id: string;
  name: string;
  /** `automation`: the hub's own triggers acting on their own. */
  kind: 'oauth' | 'api_token' | 'automation';
  lastUsedAt: Date | null;
  connections: {
    kind: 'oauth' | 'token';
    /** The access profile it connects through, by name. */
    profile: string | null;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
  }[];
}

/**
 * What the AI app tools need from the security layer. Defined here, implemented by
 * `WorkspaceAppTools` (`src/security/assistant.ts`), so the hub does not depend on it.
 */
export interface WorkspaceApps {
  list(workspaceId: string): Promise<AppInfo[]>;
  /** By id or name (any case). */
  find(workspaceId: string, ref: string): Promise<AppInfo>;
  rename(workspaceId: string, id: string, name: string): Promise<AppInfo>;
  /** Ends every sign-in and token of the app; its rules stay. */
  disconnect(workspaceId: string, id: string): Promise<{ signIns: number; tokens: number }>;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);

const appRef = z
  .string()
  .trim()
  .min(1)
  .describe('AI app name or id (see manyplug_apps), or "this" for the app making this call');

/** The app for the AI: how it connects, through which profile, when it was last used. */
function appView(app: AppInfo, ctx: SetupContext) {
  return {
    app: app.name,
    id: app.id,
    ...(app.id === ctx.principal.aiClientId ? { this_app: true } : {}),
    kind:
      app.kind === 'api_token' ? 'personal token' : app.kind === 'automation' ? 'hub triggers' : 'signs in',
    connected: app.connections.length > 0,
    connections: app.connections.map((c) => ({
      via: c.kind === 'token' ? 'token' : 'sign-in',
      ...(c.profile ? { profile: c.profile } : {}),
      since: day(c.createdAt),
      ...(c.lastUsedAt ? { last_used: day(c.lastUsedAt) } : {}),
      ...(c.expiresAt ? { expires: day(c.expiresAt) } : {}),
    })),
    ...(app.lastUsedAt ? { last_used: day(app.lastUsedAt) } : {}),
  };
}

/**
 * The AI app tools (`manyplug_apps`, `manyplug_rename_app`, `manyplug_disconnect_app`): which apps
 * reach the workspace and how, a clearer name, and ending an app's access. Disconnecting always
 * waits for the user's confirmation; what an app may do is set with `manyplug_set_rule`.
 */
export function appActions(
  define: <T extends AnyObjectSchema>(spec: SetupActionSpec<T>) => ActionDefinition,
): ActionDefinition[] {
  const apps = (ctx: SetupContext): WorkspaceApps => {
    if (!ctx.apps) throw new AppError(501, 'no_apps', 'AI apps are not available here');
    return ctx.apps;
  };
  const find = (ref: string, ctx: SetupContext): Promise<AppInfo> => {
    if (ref.toLowerCase() === 'this') {
      if (!ctx.principal.aiClientId)
        throw badRequest('This connection is not linked to an AI app; name the app.');
      return apps(ctx).find(ctx.principal.workspaceId, ctx.principal.aiClientId);
    }
    return apps(ctx).find(ctx.principal.workspaceId, ref);
  };
  return [
    define({
      name: 'apps',
      title: 'Show AI apps',
      description:
        'Lists the AI apps that use this hub (this one included): how each connects (sign-in or personal token), through which access profile, and when it was last used.',
      input: z.object({}),
      risk: 'read',
      hints: { readOnly: true, idempotent: true, openWorld: false },
      async run(_input, ctx) {
        const list = await apps(ctx).list(ctx.principal.workspaceId);
        return {
          apps: list.map((a) => appView(a, ctx)),
          hint: 'What an app may do and when it asks first: manyplug_rules and manyplug_set_rule with "app".',
        };
      },
    }),
    define({
      name: 'rename_app',
      title: 'Rename an AI app',
      description: 'Gives an AI app a clearer name, e.g. "Claude on the work laptop". Rules keep applying.',
      input: z.object({ app: appRef, name: z.string().trim().min(1).max(100) }),
      risk: 'write',
      hints: { idempotent: true, openWorld: false },
      async run({ app, name }, ctx) {
        // In a team the app is everyone's who uses it: the team's admins rename it.
        await ctx.admin.authorize(ctx.principal, 'admin');
        const found = await find(app, ctx);
        const renamed = await apps(ctx).rename(ctx.principal.workspaceId, found.id, name);
        return { renamed: appView(renamed, ctx) };
      },
    }),
    define({
      name: 'disconnect_app',
      title: 'Disconnect an AI app',
      description:
        'Ends every sign-in and personal token of an AI app, so it loses access until it connects again (its rules stay). Disconnecting the app making this call ends this conversation’s access too. The user always confirms.',
      input: z.object({ app: appRef }),
      risk: 'dangerous',
      requiresConfirmation: true,
      hints: { destructive: true, idempotent: true, openWorld: false },
      async run({ app }, ctx) {
        // In a team this ends every member's sign-in of the app: the team's admins decide that.
        await ctx.admin.authorize(ctx.principal, 'admin');
        const found = await find(app, ctx);
        const ended = await apps(ctx).disconnect(ctx.principal.workspaceId, found.id);
        return {
          disconnected: found.name,
          sign_ins_ended: ended.signIns,
          tokens_revoked: ended.tokens,
          note: 'Its rules stay in place in case it connects again.',
        };
      },
    }),
  ];
}
