import { randomUUID } from 'node:crypto';
import { BRAND } from '../brand.js';
import type { ErrorEvent, ErrorSink } from './errors.js';

/**
 * Sends captured errors to Sentry (or any Sentry-compatible service: GlitchTip, Bugsink…) over
 * its envelope HTTP API, without the Sentry SDK. Only the scrubbed event goes out: type, message,
 * stack frames, the argument-free context, release and environment. Rate limited so an error
 * storm does not burn the project's quota.
 */
export interface SentryDsn {
  /** https://<host>/api/<project>/envelope/ */
  envelopeUrl: string;
  publicKey: string;
  dsn: string;
}

export function parseSentryDsn(dsn: string): SentryDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error('SENTRY_DSN is not a URL');
  }
  const project = url.pathname.replace(/^\/+|\/+$/g, '');
  const prefix = project.includes('/') ? `/${project.slice(0, project.lastIndexOf('/'))}` : '';
  const projectId = project.slice(project.lastIndexOf('/') + 1);
  if (!url.username || !projectId || !/^\d+$/.test(projectId) || url.protocol !== 'https:') {
    throw new Error('SENTRY_DSN must look like https://<key>@<host>/<project id>');
  }
  return {
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    publicKey: decodeURIComponent(url.username),
    dsn,
  };
}

export class SentrySink implements ErrorSink {
  readonly name = 'sentry';
  private readonly dsn: SentryDsn;
  private windowStart = 0;
  private sentInWindow = 0;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    dsn: string,
    private readonly options: {
      fetch?: typeof fetch;
      /** Events per minute at most; the rest are only in the logs and the built-in tracker. */
      perMinute?: number;
      serverName?: string;
    } = {},
  ) {
    this.dsn = parseSentryDsn(dsn);
  }

  capture(event: ErrorEvent): Promise<void> | void {
    const now = Date.now();
    if (now - this.windowStart > 60_000) {
      this.windowStart = now;
      this.sentInWindow = 0;
    }
    if (this.sentInWindow >= (this.options.perMinute ?? 30)) return;
    this.sentInWindow += 1;
    const request = this.send(event);
    this.inflight.add(request);
    return request.finally(() => this.inflight.delete(request));
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  private async send(event: ErrorEvent): Promise<void> {
    const eventId = randomUUID().replace(/-/g, '');
    const payload = {
      event_id: eventId,
      timestamp: event.at.getTime() / 1000,
      platform: 'node',
      level: event.level,
      logger: event.source,
      release: event.release,
      environment: event.environment,
      ...(this.options.serverName ? { server_name: this.options.serverName } : {}),
      transaction: event.context.path ?? event.context.tool ?? event.context.job,
      exception: {
        values: [
          {
            type: event.type,
            value: event.message,
            ...(event.stack ? { stacktrace: { frames: sentryFrames(event.stack) } } : {}),
          },
        ],
      },
      tags: {
        source: event.source,
        ref: event.ref,
        ...(event.requestId ? { request_id: event.requestId } : {}),
        ...Object.fromEntries(
          Object.entries(event.context)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v).slice(0, 200)]),
        ),
      },
      fingerprint: [event.fingerprint],
    };
    const body = [
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: this.dsn.dsn }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(payload),
    ].join('\n');
    const response = await (this.options.fetch ?? fetch)(this.dsn.envelopeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${this.dsn.publicKey}, sentry_client=${BRAND.slug}/1.0`,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Sentry answered ${response.status}`);
  }
}

/** Node stack lines → Sentry frames (oldest first, as Sentry expects). */
export function sentryFrames(stack: string) {
  return stack
    .split('\n')
    .map((line) => {
      const match = line.match(/^at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?$/);
      if (!match) return { function: line.replace(/^at\s+/, '') };
      const [, fn, file, lineno, colno] = match;
      return {
        function: fn || '?',
        filename: file,
        lineno: Number(lineno),
        colno: Number(colno),
        in_app: !file!.includes('node_modules') && !file!.startsWith('node:'),
      };
    })
    .reverse();
}
