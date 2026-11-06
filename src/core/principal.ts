import { createHash } from 'node:crypto';
import type { AutomationScope } from '../db/schema.js';

/** Who is calling the hub, resolved from an OAuth token, a personal access token or a browser session. */
export interface Principal {
  /** `automation`: one of the user's triggers acting on its own (`credentialId` = the trigger id). */
  kind: 'oauth' | 'api_token' | 'session' | 'automation';
  userId: string;
  workspaceId: string;
  scopes: string[];
  /** OAuth client id (AI app) for OAuth tokens. */
  clientId?: string;
  /** OAuth grant id or personal access token id. */
  credentialId?: string;
  /** The AI client (Claude, ChatGPT, a script) access rules apply to. */
  aiClientId?: string;
  /** Set when the caller is bound to a persona's MCP URL: it only sees that persona's accounts. */
  personaId?: string;
  /**
   * The team's shared connection (one key for everyone): the hub cannot tell which member is
   * calling, so it sees only what the whole team may use and cannot change the setup.
   */
  shared?: boolean;
  /**
   * The end user's account at the AI provider, when the client says who it is (ChatGPT sends
   * `_meta["openai/subject"]` with every call; Claude sends nothing). Stored only as a hash
   * (`openai:<sha256 prefix>`): usage is counted per AI account, not per email, so one person cannot
   * multiply free use with several hub sign-ups, and the raw id is never kept.
   */
  aiSubject?: string;
  /**
   * A trigger acting on its own: which tools it may call and whether risky ones wait for the user
   * (enforced by the executor's `automation` stage, see `docs/TRIGGERS.md`).
   */
  automation?: AutomationScope;
}

/** Request `_meta` keys that identify the end user at the AI provider, by provider. */
const SUBJECT_KEYS: Array<[key: string, provider: string]> = [['openai/subject', 'openai']];

/** Hashes the AI provider's user id from a request's `_meta` (see {@link Principal.aiSubject}). */
export function aiSubjectFromMeta(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  for (const [key, provider] of SUBJECT_KEYS) {
    const value = meta[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) {
      return `${provider}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
    }
  }
  return undefined;
}

/** The key usage is counted under: the AI account when known, otherwise the AI app connection. */
export function usageCaller(principal: Principal): string {
  if (principal.aiSubject) return principal.aiSubject;
  if (principal.credentialId) return `${principal.kind}:${principal.credentialId}`;
  return `user:${principal.userId}`;
}
