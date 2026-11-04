import type { PacingLimits } from '../connectors/messaging.js';

/**
 * Human-like sending. Pure functions: the dispatcher feeds them counters from the outbox and
 * gets back when the next message may go out. Defaults follow what a careful person does on a
 * phone; they are per account and can be changed in the account config (`pacing`).
 */
export const DEFAULT_PACING: PacingLimits = {
  perMinute: 8,
  perHour: 120,
  perDay: 600,
  newContactsPerDay: 10,
  minGapMs: 2_500,
  maxGapMs: 9_000,
  typing: true,
};

export function resolvePacing(
  connectorDefaults: Partial<PacingLimits> | undefined,
  accountOverrides: Partial<PacingLimits> | undefined,
): PacingLimits {
  const merged = { ...DEFAULT_PACING, ...connectorDefaults, ...stripUndefined(accountOverrides ?? {}) };
  if (merged.maxGapMs < merged.minGapMs) merged.maxGapMs = merged.minGapMs;
  return merged;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface PacingCounters {
  lastSentAt: Date | null;
  /** Timestamps of messages sent in the last 24 hours, any order. */
  sentLastDay: Date[];
  newContactsLastDay: Date[];
}

export type PacingDecision =
  | { ok: true; at: Date }
  /** A rolling limit is exhausted; try again at `at`. */
  | { ok: false; at: Date; reason: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * When may the next message of this account be sent? Combines the random gap after the last
 * message with the rolling per-minute/hour/day windows and the stricter new-contact window.
 */
export function nextSendTime(
  limits: PacingLimits,
  counters: PacingCounters,
  options: { now: Date; newContact: boolean; random?: () => number },
): PacingDecision {
  const now = options.now.getTime();
  const random = options.random ?? Math.random;
  let at = now;

  if (counters.lastSentAt) {
    const gap = limits.minGapMs + random() * (limits.maxGapMs - limits.minGapMs);
    at = Math.max(at, counters.lastSentAt.getTime() + gap);
  }

  const windows: { span: number; limit: number; times: Date[]; reason: string }[] = [
    { span: MINUTE, limit: limits.perMinute, times: counters.sentLastDay, reason: 'per-minute limit' },
    { span: HOUR, limit: limits.perHour, times: counters.sentLastDay, reason: 'hourly limit' },
    { span: DAY, limit: limits.perDay, times: counters.sentLastDay, reason: 'daily limit' },
  ];
  if (options.newContact) {
    windows.push({
      span: DAY,
      limit: limits.newContactsPerDay,
      times: counters.newContactsLastDay,
      reason: 'daily limit for first messages to new people',
    });
  }

  let blockedBy: string | undefined;
  for (const window of windows) {
    const free = windowFreeAt(window.times, window.span, window.limit, at);
    if (free > at) {
      at = free;
      if (window.span >= HOUR) blockedBy = window.reason;
    }
  }
  if (!Number.isFinite(at)) {
    return {
      ok: false,
      at: new Date(now + DAY),
      reason: 'sending to new people is disabled for this account',
    };
  }
  // Waiting for a minute window is ordinary pacing; hitting an hourly or daily limit is worth
  // telling the AI, because the message will go out much later.
  if (blockedBy) return { ok: false, at: new Date(at), reason: blockedBy };
  return { ok: true, at: new Date(at) };
}

/** Earliest time ≥ `from` at which fewer than `limit` events fall into the trailing window. */
function windowFreeAt(times: Date[], span: number, limit: number, from: number): number {
  if (limit <= 0) return Number.POSITIVE_INFINITY;
  const inWindow = times
    .map((t) => t.getTime())
    .filter((t) => t > from - span)
    .sort((a, b) => a - b);
  if (inWindow.length < limit) return from;
  // The window frees up when the oldest event that keeps it full leaves it.
  return inWindow[inWindow.length - limit]! + span;
}

/** How long to show "typing..." for a text: about a fast typist, with jitter, 1–8 seconds. */
export function typingDurationMs(text: string, random: () => number = Math.random): number {
  const perChar = 35 + random() * 25;
  return Math.round(Math.min(8_000, Math.max(1_000, text.length * perChar)));
}
