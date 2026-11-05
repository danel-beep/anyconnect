import type { ActionTag } from '../connectors/sdk.js';

/**
 * Directory rules of AI apps, applied to the catalog of their clients.
 *
 * An app's connector directory (Claude Connectors Directory, ChatGPT apps) accepts a connector only
 * if it offers nothing the directory excludes, whoever connects it. The hub stays one product: the
 * catalog of a client of such an app simply leaves out what that app's rules exclude (other apps
 * still get everything). A new directory with its own rules is one more entry here; actions declare
 * what they do with `ActionDefinition.tags`.
 *
 * Which policies are enforced is configured (`CLIENT_POLICIES`), so a rule that takes features away
 * can be switched on when the listing is submitted, not before.
 */

/** What the catalog of one AI client leaves out. */
export interface ClientRestrictions {
  /** Actions with any of these tags are neither listed nor callable. */
  excludeTags: readonly ActionTag[];
  /**
   * No generic executors: every operation is its own listed tool, so the hub's search / describe /
   * call meta tools are left out and the listing is always direct.
   */
  noGenericExecutor: boolean;
}

export interface ClientPolicy {
  id: string;
  /** The directory whose rules this is. */
  directory: string;
  /** Known app names (`core/ai-apps.ts`) whose clients it applies to. */
  apps: readonly string[];
  restrictions: ClientRestrictions;
  /** Where the rules are published. */
  rules: string;
}

export const CLIENT_POLICIES: readonly ClientPolicy[] = [
  {
    id: 'claude',
    directory: 'Claude Connectors Directory',
    apps: ['Claude'],
    // "Connectors that transfer money ... or generate images, video, or audio aren't accepted";
    // "every tool must return a successful response when called with valid parameters".
    restrictions: { excludeTags: ['moves_money', 'generates_media', 'test_only'], noGenericExecutor: false },
    rules: 'https://claude.com/docs/connectors/building/review-criteria',
  },
  {
    id: 'chatgpt',
    directory: 'ChatGPT apps directory',
    apps: ['ChatGPT', 'OpenAI'],
    // No money transfers; no plans, subscriptions or upgrades in the app; no generic executors.
    restrictions: { excludeTags: ['moves_money', 'commerce', 'test_only'], noGenericExecutor: true },
    rules: 'https://developers.openai.com/apps-sdk/app-submission-guidelines',
  },
];

export const CLIENT_POLICY_IDS = CLIENT_POLICIES.map((p) => p.id);

/** The restrictions for a client of `app` under the enforced policies, or `undefined` for none. */
export function restrictionsFor(
  app: string | undefined,
  enforced: readonly string[],
): ClientRestrictions | undefined {
  if (!app) return undefined;
  const policies = CLIENT_POLICIES.filter((p) => enforced.includes(p.id) && p.apps.includes(app));
  if (policies.length === 0) return undefined;
  return {
    excludeTags: [...new Set(policies.flatMap((p) => p.restrictions.excludeTags))],
    noGenericExecutor: policies.some((p) => p.restrictions.noGenericExecutor),
  };
}

/** Whether an action is offered under the restrictions. */
export function actionAllowed(
  action: { tags?: readonly ActionTag[] | undefined },
  restrictions: ClientRestrictions | undefined,
): boolean {
  if (!restrictions || !action.tags?.length) return true;
  return !action.tags.some((tag) => restrictions.excludeTags.includes(tag));
}
