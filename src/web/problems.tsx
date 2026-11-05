import type { FC } from 'hono/jsx';
import type { Translate } from './i18n.js';

/**
 * Why a connection check or a call failed, in terms a person can act on. Errors reach us as text
 * from many places (HTTP status lines, Node network errors, IMAP servers, connector messages), so
 * the text is sorted by its well-known markers; anything unknown stays `other` and its own message
 * is shown as the detail.
 */
export type ProblemKind = 'unreachable' | 'signin' | 'denied' | 'busy' | 'service' | 'unfinished' | 'other';

export interface Problem {
  kind: ProblemKind;
  /** The server that could not be reached, when the error names it. */
  host?: string | undefined;
}

const UNREACHABLE =
  /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNABORTED)\b|fetch failed|socket hang up|getaddrinfo|network error|timed out|timeout/i;
const HOST = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH)\s+([a-z0-9.-]+\.[a-z]{2,})/i;
const SIGNIN =
  /\b401\b|unauthori[sz]ed|invalid[_ ](api[_ ])?(key|token|grant|credentials)|authentication ?failed|invalid credentials|login failed|AUTHENTICATIONFAILED|expired|revoked|not authenticated|bad credentials|not valid|wrong (password|key|token)/i;
const DENIED = /\b403\b|forbidden|permission|insufficient|not allowed|scope/i;
const BUSY = /\b429\b|rate.?limit|too many requests/i;
const SERVICE = /\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/i;

export function classifyProblem(message: string | null | undefined, status?: string): Problem {
  const text = message ?? '';
  if (/not connected yet/i.test(text)) return { kind: 'unfinished' };
  if (UNREACHABLE.test(text)) return { kind: 'unreachable', host: HOST.exec(text)?.[1] };
  if (status === 'needs_reauth' || SIGNIN.test(text)) return { kind: 'signin' };
  if (DENIED.test(text)) return { kind: 'denied' };
  if (BUSY.test(text)) return { kind: 'busy' };
  if (SERVICE.test(text)) return { kind: 'service' };
  return { kind: 'other' };
}

/** Fixed by signing in again (the Reconnect button), not by checking again. */
export const needsReconnect = (problem: Problem) =>
  problem.kind === 'signin' || problem.kind === 'denied' || problem.kind === 'unfinished';

/** One sentence for a failure: what went wrong and what helps (unknown ones keep their own words). */
export function problemText(t: Translate, problem: Problem, message?: string | null): string {
  if (problem.kind === 'unreachable')
    return t('problem.unreachable', { host: problem.host ?? t('problem.unreachableHost') });
  if (problem.kind === 'other')
    return message ? t('problem.otherSaid', { message: message.replace(/\.+$/, '') }) : t('problem.other');
  return t(`problem.${problem.kind}`);
}

/**
 * The reason for a failed account or call. The service's raw message stays one click away under
 * "Details" (`details`) or in the tooltip, for whoever needs to report it.
 */
export const ProblemText: FC<{
  t: Translate;
  message: string | null | undefined;
  status?: string | undefined;
  details?: boolean;
}> = ({ t, message, status, details }) => {
  const problem = classifyProblem(message, status);
  const text = problemText(t, problem, message);
  const raw = message && problem.kind !== 'other' ? message : undefined;
  return (
    <span class="problem" title={details ? undefined : raw}>
      {text}
      {details && raw ? (
        <details class="problem-raw">
          <summary>{t('problem.details')}</summary>
          <code>{raw}</code>
        </details>
      ) : null}
    </span>
  );
};

/** Why a call in the activity log failed, from its recorded outcome or, failing that, its error. */
export function callReason(t: Translate, outcome: string | null, message: string | null): string {
  switch (outcome) {
    case 'denied':
      return t('problem.call.denied');
    case 'declined':
      return t('problem.call.declined');
    case 'quota_exceeded':
      return t('problem.call.quota');
    case 'rate_limited':
      return t('problem.busy');
    case 'timeout':
      return t('problem.call.timeout');
    case 'circuit_open':
      return t('problem.call.circuit');
    case 'auth':
      return t('problem.signin');
    case 'permission':
      return t('problem.denied');
    case 'invalid_input':
    case 'not_found': {
      const said = message?.replace(/\.+$/, '').slice(0, 200);
      return said ? t(`problem.call.${outcome}`, { message: said }) : t(`problem.call.${outcome}Bare`);
    }
    default: {
      if (!message) return t('problem.call.unknown');
      const problem = classifyProblem(message);
      return problem.kind === 'other' && message
        ? message.replace(/\.+$/, '').slice(0, 200)
        : problemText(t, problem, message);
    }
  }
}
