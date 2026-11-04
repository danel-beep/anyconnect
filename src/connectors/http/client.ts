import { type AccountContext, ConnectorError, type ErrorKind } from '../sdk.js';
import { getPath } from './json-path.js';
import { type RateLimit, sleep, type TokenBucketLimiter } from './rate-limit.js';

/**
 * HTTP client for connectors: one place that turns HTTP into what the hub expects.
 *
 * - goes through `ctx.fetch` (network policy, test fixtures) and honours `ctx.signal`;
 * - adds the OAuth bearer token, and on 401 refreshes it once and retries;
 * - maps statuses to `ConnectorError` kinds (401 → auth, 403 → permission, 404 → not_found,
 *   429 → rate_limited with Retry-After, 4xx → invalid_input, 5xx → upstream) with the service's
 *   own error message when it can be found;
 * - retries idempotent requests once on 502/503/504 and network errors; waits out short 429s;
 * - optional per-account rate limit.
 *
 * Code connectors use it directly; the HTTP manifest engine is built on it.
 */

export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | QueryValue[]
  | Record<string, unknown>;

export interface HttpRequest {
  method?: string;
  /** Absolute URL, or a path appended to `baseUrl`. */
  url: string;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string | undefined>;
  /** JSON body. */
  json?: unknown;
  /** `application/x-www-form-urlencoded` body. */
  form?: Record<string, QueryValue>;
  /** Raw body. */
  body?: string | Uint8Array;
  /** Skip the OAuth `Authorization` header (e.g. for presigned URLs). */
  noAuth?: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  /** Parsed JSON when the response is JSON, text otherwise, `undefined` when empty. */
  data: T;
  url: string;
}

export interface HttpClientOptions {
  baseUrl?: string;
  /** Headers added to every request (rendered credentials, API versions, ...). */
  headers?: Record<string, string | undefined>;
  /** Query parameters added to every request (API keys passed in the query). */
  query?: Record<string, QueryValue>;
  /** Dot paths where the service puts its error message (`error.message`, `errors.0.detail`). */
  errorMessagePaths?: string[];
  rateLimit?: { limiter: TokenBucketLimiter; key: string; limit: RateLimit };
  /** Wait up to this long for a 429/503 Retry-After before giving up (default 5 s). */
  maxRetryWaitMs?: number;
}

type Ctx = Pick<AccountContext<unknown, unknown>, 'fetch' | 'signal' | 'oauth'>;

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const DEFAULT_ERROR_PATHS = [
  'error.message',
  'error_description',
  'message',
  'error',
  'errors.0.message',
  'errors.0.detail',
  'detail',
];

export function appendQuery(url: URL, query: Record<string, QueryValue> | undefined): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null) continue;
      url.searchParams.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
    }
  }
}

function resolveUrl(baseUrl: string | undefined, path: string): URL {
  if (/^https?:\/\//i.test(path)) return new URL(path);
  if (!baseUrl) throw new Error(`Relative URL "${path}" needs a baseUrl`);
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ''), base);
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function errorMessage(data: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = getPath(data, path);
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
  }
  if (typeof data === 'string' && data.trim() && !data.trimStart().startsWith('<')) {
    return data.trim().slice(0, 300);
  }
  return undefined;
}

export function errorKindForStatus(status: number): ErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'invalid_input';
  return 'upstream';
}

function networkError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return signal.reason instanceof Error ? signal.reason : new Error('Aborted');
  const cause = (error as { cause?: unknown })?.cause;
  if (cause instanceof ConnectorError) return cause;
  const detail = cause instanceof Error ? cause.message : error instanceof Error ? error.message : '';
  return new ConnectorError('upstream', `Could not reach the service${detail ? `: ${detail}` : ''}`, {
    cause: error,
  });
}

export class HttpClient {
  constructor(
    private readonly ctx: Ctx,
    private readonly options: HttpClientOptions = {},
  ) {}

  get<T = unknown>(url: string, query?: Record<string, QueryValue>): Promise<HttpResponse<T>> {
    return this.request<T>({ method: 'GET', url, ...(query ? { query } : {}) });
  }

  post<T = unknown>(url: string, json?: unknown): Promise<HttpResponse<T>> {
    return this.request<T>({ method: 'POST', url, json });
  }

  /** Performs the request; resolves only for 2xx/3xx, throws `ConnectorError` otherwise. */
  async request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    const method = (request.method ?? 'GET').toUpperCase();
    const url = resolveUrl(this.options.baseUrl, request.url);
    appendQuery(url, this.options.query);
    appendQuery(url, request.query);

    const headers = new Headers({ accept: 'application/json' });
    for (const [key, value] of Object.entries({ ...this.options.headers, ...request.headers })) {
      if (value !== undefined) headers.set(key, value);
    }
    let body: string | Uint8Array | undefined;
    if (request.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(request.json);
    } else if (request.form) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(request.form)) {
        if (value === undefined || value === null) continue;
        form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      headers.set('content-type', 'application/x-www-form-urlencoded');
      body = form.toString();
    } else if (request.body !== undefined) {
      body = request.body;
    }

    const maxWait = this.options.maxRetryWaitMs ?? 5000;
    let refreshed = false;
    let retried = false;
    for (;;) {
      if (this.options.rateLimit) {
        const { limiter, key, limit } = this.options.rateLimit;
        await limiter.acquire(key, limit, this.ctx.signal);
      }
      if (this.ctx.oauth && !request.noAuth) {
        headers.set('authorization', `${this.ctx.oauth.tokenType || 'Bearer'} ${this.ctx.oauth.accessToken}`);
      }
      let response: Response;
      try {
        response = await this.ctx.fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: this.ctx.signal,
        });
      } catch (error) {
        const mapped = networkError(error, this.ctx.signal);
        const transient = mapped instanceof ConnectorError && mapped.kind === 'upstream';
        if (!retried && transient && IDEMPOTENT.has(method)) {
          retried = true;
          await sleep(300, this.ctx.signal);
          continue;
        }
        throw mapped;
      }

      if (response.status === 401 && this.ctx.oauth && !request.noAuth && !refreshed) {
        await response.body?.cancel();
        refreshed = true;
        await this.ctx.oauth.refresh();
        continue;
      }
      const wait = retryAfterMs(response.headers);
      if (
        !retried &&
        (response.status === 429 || (IDEMPOTENT.has(method) && [502, 503, 504].includes(response.status))) &&
        (wait ?? 500) <= maxWait
      ) {
        await response.body?.cancel();
        retried = true;
        await sleep(wait ?? 500, this.ctx.signal);
        continue;
      }

      const data = await readBody(response);
      if (response.status >= 400) {
        const kind = errorKindForStatus(response.status);
        const message =
          errorMessage(data, this.options.errorMessagePaths ?? DEFAULT_ERROR_PATHS) ??
          `The service answered HTTP ${response.status}`;
        throw new ConnectorError(kind, message, {
          ...(wait !== undefined ? { retryAfterSeconds: Math.ceil(wait / 1000) } : {}),
        });
      }
      return {
        status: response.status,
        headers: response.headers,
        data: data as T,
        url: response.url || url.toString(),
      };
    }
  }
}
