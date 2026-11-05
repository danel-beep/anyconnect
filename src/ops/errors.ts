import { createHash } from 'node:crypto';
import type { Logger } from '../logger.js';
import { currentContext, newRequestId } from './context.js';
import { scrubSecrets } from './scrub.js';

/**
 * The hub's error tracking. Every unexpected error (an unhandled exception in a route, a tool call
 * that crashed, a failed background job, a process-level crash) is captured once with
 * `ErrorReporter.capture()`, which:
 *
 * 1. scrubs the message (`scrubSecrets`) and keeps only stack frames, never arguments;
 * 2. groups it by a fingerprint (where + error type + normalized message + first own frame);
 * 3. logs it with a short reference the user sees ("Internal error (ref 3f9a…)");
 * 4. hands it to every configured sink: the built-in store (admin panel → Errors) and, when
 *    SENTRY_DSN is set, Sentry. A new destination is one more `ErrorSink`.
 *
 * Expected failures (a service said 401, invalid input, rate limits) are not errors here: they are
 * normal results with their own messages.
 */

export type ErrorSource = 'http' | 'tool' | 'job' | 'process' | 'maintenance' | 'mcp' | (string & {});

export interface ErrorContext {
  /** HTTP method and path (no query string: it may hold codes or tokens). */
  method?: string;
  path?: string;
  tool?: string;
  connector?: string;
  job?: string;
  workspaceId?: string;
  [key: string]: string | number | boolean | undefined;
}

/** One captured error, already scrubbed and fingerprinted. */
export interface ErrorEvent {
  /** Short reference shown to the user and written to the log. */
  ref: string;
  fingerprint: string;
  source: ErrorSource;
  level: 'error' | 'fatal';
  type: string;
  message: string;
  /** Stack frames only (`at …` lines), without the message line. */
  stack: string | undefined;
  context: ErrorContext;
  requestId: string | undefined;
  release: string;
  environment: string;
  at: Date;
}

export interface ErrorSink {
  readonly name: string;
  capture(event: ErrorEvent): void | Promise<void>;
  /** Sends what is buffered (on shutdown). */
  flush?(): Promise<void>;
}

export interface CaptureOptions {
  source: ErrorSource;
  context?: ErrorContext;
  level?: 'error' | 'fatal';
}

export class ErrorReporter {
  private readonly sinks: ErrorSink[] = [];

  constructor(private readonly options: { logger: Logger; release: string; environment: string }) {}

  addSink(sink: ErrorSink): this {
    this.sinks.push(sink);
    return this;
  }

  get sinkNames(): string[] {
    return this.sinks.map((s) => s.name);
  }

  /** Records an unexpected error; returns the reference to show the user. Never throws. */
  capture(error: unknown, options: CaptureOptions): string {
    const event = toEvent(error, options, this.options);
    this.options.logger[event.level === 'fatal' ? 'fatal' : 'error'](
      {
        err: error,
        ref: event.ref,
        source: event.source,
        fingerprint: event.fingerprint.slice(0, 12),
        ...cleanContext(event.context),
      },
      `${event.source} error: ${event.type}`,
    );
    for (const sink of this.sinks) {
      try {
        const pending = sink.capture(event);
        if (pending) pending.catch((err) => this.sinkFailed(sink, err));
      } catch (err) {
        this.sinkFailed(sink, err);
      }
    }
    return event.ref;
  }

  async flush(timeoutMs = 3000): Promise<void> {
    const all = Promise.allSettled(this.sinks.map((s) => s.flush?.()));
    await Promise.race([all, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  private sinkFailed(sink: ErrorSink, err: unknown) {
    // Logged at warn without the event: a broken sink must not cause an error loop.
    this.options.logger.warn({ sink: sink.name, err }, 'error sink failed');
  }
}

function cleanContext(context: ErrorContext): ErrorContext {
  return Object.fromEntries(Object.entries(context).filter(([, v]) => v !== undefined)) as ErrorContext;
}

/** Builds the event: name, scrubbed message, stack frames, fingerprint, ambient request id. */
export function toEvent(
  error: unknown,
  options: CaptureOptions,
  meta: { release: string; environment: string },
): ErrorEvent {
  const err =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-error thrown');
  const type = err.name || 'Error';
  const message = scrubSecrets(err.message || '(no message)', 1000);
  const stack = stackFrames(err.stack);
  const ambient = currentContext();
  const context = cleanContext({
    ...(ambient?.job ? { job: ambient.job } : {}),
    ...options.context,
  });
  return {
    ref: newRequestId().slice(0, 10),
    fingerprint: fingerprint(options.source, type, message, stack),
    source: options.source,
    level: options.level ?? 'error',
    type,
    message,
    stack,
    context,
    requestId: ambient?.requestId,
    release: meta.release,
    environment: meta.environment,
    at: new Date(),
  };
}

function stackFrames(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const frames = stack
    .split('\n')
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, 30)
    .map((line) => scrubSecrets(line.trim(), 500));
  return frames.length ? frames.join('\n') : undefined;
}

/**
 * Same bug → same group: numbers, ids and quoted values are normalized out of the message, and
 * the first frame from the hub's own code (not node_modules) pins the place.
 */
export function fingerprint(
  source: string,
  type: string,
  message: string,
  stack: string | undefined,
): string {
  const normalized = message
    .replace(/(["'`]).*?\1/g, '?')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\b[a-z]{2,5}_[0-9a-z]{10,}\b/g, '#')
    .replace(/\d+/g, '#')
    .slice(0, 200);
  const own = stack
    ?.split('\n')
    .find((line) => /[/\\]/.test(line) && !line.includes('node_modules') && !line.includes('node:'))
    ?.replace(/:\d+:\d+\)?$/, '')
    .replace(/^at\s+/, '');
  return createHash('sha256')
    .update([source, type, normalized, own ?? ''].join('|'))
    .digest('hex');
}
