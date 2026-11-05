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

/**
 * Downloads a file a message should carry, for messengers that cannot fetch a link themselves.
 * Goes through the connector's `fetch` (the hub's network policy: no private addresses) and stops
 * reading past `maxBytes`, so a huge or endless response cannot exhaust memory. Failures are
 * {@link DeliveryError}s: nothing was sent yet, so a server error is safe to retry.
 */
export async function downloadForUpload(
  fetch: FetchLike,
  url: string,
  options: { maxBytes: number; signal?: AbortSignal },
): Promise<{ data: Uint8Array; mimeType: string; name: string }> {
  let response: Response;
  try {
    response = await fetch(url, { ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    throw new DeliveryError('transient', 'Could not download the file to send', { cause: error });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new DeliveryError(
      response.status >= 500 ? 'transient' : 'rejected',
      `Could not download the file to send (HTTP ${response.status})`,
    );
  }
  const tooLarge = () =>
    new DeliveryError('rejected', `The file is larger than ${Math.round(options.maxBytes / 1_048_576)} MB`);
  if (Number(response.headers.get('content-length') ?? 0) > options.maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > options.maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    data,
    mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
    name: fileNameFromUrl(url),
  };
}

/** The last path segment of a link, decoded, as a file name. */
export function fileNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '') || 'file';
  } catch {
    return 'file';
  }
}
