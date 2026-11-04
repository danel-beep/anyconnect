import { z } from 'zod';
import type { ActionDefinition, AnyObjectSchema } from '../connectors/sdk.js';
import { AppError } from '../lib/errors.js';
import type { SetupActionSpec, SetupContext } from './setup-tools.js';

/** How the user signs in and approves actions, as the security tool reports it. */
export interface SecurityStatus {
  twoStep: {
    authenticatorApp: boolean;
    passkeys: number;
    /** Unused recovery codes. */
    recoveryCodes: number;
    /** This server makes two-step sign-in compulsory. */
    required: boolean;
  };
  /** Ways in: "password" and the sign-in providers linked to the user (e.g. "google"). */
  signInWith: string[];
  /** Browsers signed in to the dashboard now. */
  sessions: number;
  /** Approving held-back actions in Telegram; null when this server has no Telegram bot. */
  telegram: { linked: boolean; label: string | null; since: Date | null } | null;
  /** Pages where each of these is changed. */
  urls: { security: string; sessions: string; telegram: string };
}

/**
 * What the security tool needs from the security layer. Defined here, implemented by
 * `UserSecurityTools` (`src/security/assistant.ts`), so the hub does not depend on it.
 */
export interface UserSecurity {
  status(userId: string): Promise<SecurityStatus>;
}

/** Fewer unused recovery codes than this is worth a word. */
const FEW_RECOVERY_CODES = 3;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);

/**
 * `manyplug_security`: how safe the user's sign-in is and whether Telegram approvals are on, with
 * the page for each change. Read only: sign-in security and the confirmation channel change on the
 * site after signing in again, never from the chat, so an AI can never weaken them.
 */
export function securityActions(
  define: <T extends AnyObjectSchema>(spec: SetupActionSpec<T>) => ActionDefinition,
): ActionDefinition[] {
  const security = (ctx: SetupContext): UserSecurity => {
    if (!ctx.security) throw new AppError(501, 'no_security', 'Sign-in security is not available here');
    return ctx.security;
  };
  return [
    define({
      name: 'security',
      title: 'Show sign-in security',
      description:
        'Shows how the user signs in (two-step sign-in, passkeys, recovery codes left, signed-in browsers) and whether held-back actions can be approved in Telegram, with the page to change each. Changes are made on the site only.',
      input: z.object({}),
      risk: 'read',
      hints: { readOnly: true, idempotent: true, openWorld: false },
      async run(_input, ctx) {
        const s = await security(ctx).status(ctx.principal.userId);
        const on = s.twoStep.authenticatorApp || s.twoStep.passkeys > 0;
        const advice: string[] = [];
        if (!on) {
          advice.push(
            `Turn on two-step sign-in (an authenticator app or a passkey) at ${s.urls.security}: a stolen password alone then cannot open the hub and its accounts.`,
          );
        } else if (s.twoStep.recoveryCodes < FEW_RECOVERY_CODES) {
          advice.push(
            `Only ${s.twoStep.recoveryCodes} recovery code(s) left: make new ones at ${s.urls.security}#recovery before losing the phone or key.`,
          );
        }
        if (s.telegram && !s.telegram.linked) {
          advice.push(
            `Link Telegram at ${s.urls.telegram} to approve risky actions from the phone instead of the hub's page.`,
          );
        }
        if (s.sessions > 3) {
          advice.push(
            `${s.sessions} browsers are signed in: sign out the ones you do not know at ${s.urls.sessions}.`,
          );
        }
        return {
          two_step: {
            on,
            authenticator_app: s.twoStep.authenticatorApp,
            passkeys: s.twoStep.passkeys,
            ...(on ? { recovery_codes_left: s.twoStep.recoveryCodes } : {}),
            ...(s.twoStep.required ? { required_on_this_server: true } : {}),
          },
          sign_in_with: s.signInWith,
          signed_in_browsers: s.sessions,
          ...(s.telegram
            ? {
                telegram_approvals: s.telegram.linked
                  ? {
                      linked: true,
                      ...(s.telegram.label ? { chat: s.telegram.label } : {}),
                      since: day(s.telegram.since),
                    }
                  : { linked: false },
              }
            : {}),
          change_at: {
            sign_in: s.urls.security,
            browsers: s.urls.sessions,
            ...(s.telegram ? { telegram: s.urls.telegram } : {}),
          },
          advice,
          note: `${s.telegram ? 'Sign-in security and Telegram linking change' : 'Sign-in security changes'} only on these pages, after the user signs in; they cannot be changed from the chat.`,
        };
      },
    }),
  ];
}
