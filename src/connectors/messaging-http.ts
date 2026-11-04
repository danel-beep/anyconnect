/**
 * HTTP helpers for direct messenger transports (Bot API, Cloud API). Part of the connector SDK.
 *
 * The important rule: a request that may have reached the messenger must never be retried
 * blindly, or the message is sent twice. Only failures that happen before the request leaves
 * (DNS, refused connection) are safe to retry; anything else is rethrown as is and the
 * dispatcher records the job as `uncertain` unless the transport can deduplicate.
 */
import { DeliveryError } from './messaging.js';
import type { FetchLike } from './sdk.js';

const NOT_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** `fetch` that turns "never left this machine" failures into a retryable {@link DeliveryError}. */
export async function deliveryFetch(
  fetch: FetchLike,
  url: string | URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const code = errorCode(error);
    if (code && NOT_SENT_CODES.has(code)) {
      throw new DeliveryError('transient', `Network error (${code})`, { cause: error });
    }
    throw error;
  }
}

/** Reads a JSON body, tolerating empty or non-JSON error pages. */
export async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

/** Constant-time string comparison for webhook secrets. */
export function secretsEqual(a: string | undefined, b: string): boolean {
  if (a === undefined || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
