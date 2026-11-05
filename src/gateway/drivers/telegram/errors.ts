import { MtPeerNotFoundError, tl } from '@mtcute/core';
import { DeliveryError } from '../../../connectors/messaging.js';
import type { MessengerProblem } from '../../../db/schema.js';
import { SessionError } from '../types.js';

/** Errors that mean the login is gone: the user has to log in again. */
const LOGGED_OUT = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_INVALID',
  'AUTH_KEY_PERM_EMPTY',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
]);

const BANNED = new Set(['USER_DEACTIVATED', 'USER_DEACTIVATED_BAN', 'PHONE_NUMBER_BANNED']);

/** Telegram froze the account (it can only read and appeal). */
const FROZEN = new Set(['FROZEN_METHOD_INVALID', 'FROZEN_PARTICIPANT_MISSING']);

/** A message that can never be delivered as it is. */
const REJECTED = new Set([
  'PEER_ID_INVALID',
  'USER_IS_BLOCKED',
  'YOU_BLOCKED_USER',
  'USER_PRIVACY_RESTRICTED',
  'PRIVACY_PREMIUM_REQUIRED',
  'INPUT_USER_DEACTIVATED',
  'CHAT_WRITE_FORBIDDEN',
  'CHAT_ADMIN_REQUIRED',
  'CHAT_RESTRICTED',
  'CHAT_SEND_PLAIN_FORBIDDEN',
  'CHAT_GUEST_SEND_FORBIDDEN',
  'CHANNEL_PRIVATE',
  'CHANNEL_INVALID',
  'USER_BANNED_IN_CHANNEL',
  'MESSAGE_TOO_LONG',
  'MESSAGE_EMPTY',
  'MSG_ID_INVALID',
  'REPLY_MESSAGE_ID_INVALID',
  'ENTITY_BOUNDS_INVALID',
  'ALLOW_PAYMENT_REQUIRED',
]);

export function rpcText(error: unknown): string | undefined {
  return tl.RpcError.is(error) ? error.text : undefined;
}

/** Seconds from FLOOD_WAIT_X / SLOWMODE_WAIT_X, however mtcute reports them. */
function waitSeconds(error: tl.RpcError): number | undefined {
  const seconds = (error as { seconds?: unknown }).seconds;
  if (typeof seconds === 'number') return seconds;
  const match = /_(\d+)$/.exec(error.message ?? '');
  return match ? Number(match[1]) : undefined;
}

/** The session-level problem behind an error, if it ends the session. */
export function sessionProblem(error: unknown): MessengerProblem | undefined {
  const text = rpcText(error);
  if (!text) return undefined;
  if (LOGGED_OUT.has(text)) return 'logged_out';
  if (BANNED.has(text)) return 'banned';
  if (FROZEN.has(text)) return 'frozen';
  return undefined;
}

export function toSessionError(error: unknown, fallback: MessengerProblem = 'network'): SessionError {
  if (error instanceof SessionError) return error;
  const problem = sessionProblem(error);
  const text = rpcText(error);
  if (problem) return new SessionError(problem, `Telegram: ${text}`, { cause: error });
  if (tl.RpcError.is(error) && /^FLOOD_WAIT/.test(error.text)) {
    return new SessionError('flood', 'Telegram asked to wait', {
      retryAfterSeconds: waitSeconds(error) ?? 60,
      cause: error,
    });
  }
  if (text) return new SessionError('protocol', `Telegram: ${text}`, { cause: error });
  return new SessionError(fallback, error instanceof Error ? error.message : String(error), { cause: error });
}

/**
 * Classifies a failed send for the outbox. Throws the DeliveryError; returns `'duplicate'` when
 * Telegram says this random id was already used, i.e. an earlier attempt went through.
 */
export function deliveryFailure(error: unknown): 'duplicate' {
  if (error instanceof DeliveryError) throw error;
  if (error instanceof MtPeerNotFoundError) {
    throw new DeliveryError('rejected', 'Telegram does not know this chat for this account.', {
      cause: error,
    });
  }
  if (!tl.RpcError.is(error)) {
    throw new DeliveryError('transient', 'Could not reach Telegram.', { cause: error });
  }
  const text = error.text;
  if (text === 'RANDOM_ID_DUPLICATE') return 'duplicate';
  if (/^(FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT)/.test(text)) {
    throw new DeliveryError('rate_limited', 'Telegram asked to wait before sending.', {
      retryAfterSeconds: waitSeconds(error) ?? 60,
      cause: error,
    });
  }
  if (text === 'PEER_FLOOD') {
    throw new DeliveryError('spam_warning', 'Telegram limited sending from this account (PEER_FLOOD).', {
      cause: error,
    });
  }
  const problem = sessionProblem(error);
  if (problem) throw new DeliveryError('auth', `Telegram: ${text}`, { cause: error });
  if (REJECTED.has(text) || error.code === 400 || error.code === 403) {
    throw new DeliveryError('rejected', `Telegram refused the message: ${text}`, { cause: error });
  }
  throw new DeliveryError('transient', `Telegram error: ${text}`, { cause: error });
}
