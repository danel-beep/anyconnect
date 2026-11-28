import { describe, expect, it } from 'vitest';
import { type MessengerAccountRow, MessengerAccounts } from '../src/messaging/accounts.js';
import { DEFAULT_PACING, nextSendTime, resolvePacing, typingDurationMs } from '../src/messaging/pacing.js';
import { indexTerms, matchesQuery, queryTerms, stem } from '../src/messaging/search-index.js';

describe('blind search index terms', () => {
  it('indexes word prefixes and finds inflected Russian and English forms', () => {
    const terms = new Set(indexTerms('Встречаемся завтра на встрече по Meetings', 't'));
    for (const query of ['встреча', 'встречу', 'встречи', 'завтра', 'meeting', 'meetings']) {
      for (const term of queryTerms(query, 't')) expect(terms.has(term), `${query} -> ${term}`).toBe(true);
    }
    expect(queryTerms('ёлка', 't')).toEqual(queryTerms('елка', 't'));
  });

  it('keeps the query terms namespaced, bounded and stem-like', () => {
    expect(queryTerms('Привет', 'f')).toEqual(['f:привет']);
    expect(stem('сообщениями')).toBe('сообщен');
    expect(queryTerms('a b c d e f g h i j k l m n', 't').length).toBeLessThanOrEqual(8);
    expect(indexTerms('x'.repeat(5_000), 't').length).toBeLessThanOrEqual(800);
  });

  it('verifies candidates on decrypted text', () => {
    expect(matchesQuery('Счёт за ноябрь оплачен', 'счета ноябрь')).toBe(true);
    expect(matchesQuery('Счёт за ноябрь оплачен', 'декабрь')).toBe(false);
  });
});

describe('pacing', () => {
  const at = (iso: string) => new Date(iso);
  const now = at('2026-11-04T12:00:00Z');
  const fixed = () => 0.5;

  it('sends at once when idle, and keeps a random gap after the last message', () => {
    expect(
      nextSendTime(
        DEFAULT_PACING,
        { lastSentAt: null, sentLastDay: [], newContactsLastDay: [] },
        { now, newContact: false },
      ),
    ).toEqual({
      ok: true,
      at: now,
    });
    const decision = nextSendTime(
      DEFAULT_PACING,
      { lastSentAt: now, sentLastDay: [now], newContactsLastDay: [] },
      { now, newContact: false, random: fixed },
    );
    const gap = DEFAULT_PACING.minGapMs + 0.5 * (DEFAULT_PACING.maxGapMs - DEFAULT_PACING.minGapMs);
    expect(decision).toEqual({ ok: true, at: new Date(now.getTime() + gap) });
  });

  it('waits for rolling windows and reports daily and new-contact limits', () => {
    const limits = resolvePacing(
      { perMinute: 2, perDay: 3, newContactsPerDay: 1, minGapMs: 0, maxGapMs: 0 },
      undefined,
    );
    const sent = [at('2026-11-04T11:59:30Z'), at('2026-11-04T11:59:50Z')];
    const minute = nextSendTime(
      limits,
      { lastSentAt: sent[1]!, sentLastDay: sent, newContactsLastDay: [] },
      { now, newContact: false },
    );
    expect(minute).toEqual({ ok: true, at: at('2026-11-04T12:00:30Z') });

    const day = [at('2026-11-04T01:00:00Z'), ...sent];
    const daily = nextSendTime(
      limits,
      { lastSentAt: sent[1]!, sentLastDay: day, newContactsLastDay: [] },
      { now, newContact: false },
    );
    expect(daily).toMatchObject({ ok: false, at: at('2026-11-05T01:00:00Z'), reason: 'daily limit' });

    const fresh = nextSendTime(
      resolvePacing({ newContactsPerDay: 1, minGapMs: 0, maxGapMs: 0 }, undefined),
      { lastSentAt: null, sentLastDay: [], newContactsLastDay: [at('2026-11-04T08:00:00Z')] },
      { now, newContact: true },
    );
    expect(fresh).toMatchObject({ ok: false, at: at('2026-11-05T08:00:00Z') });

    const disabled = nextSendTime(
      resolvePacing({ newContactsPerDay: 0 }, undefined),
      { lastSentAt: null, sentLastDay: [], newContactsLastDay: [] },
      { now, newContact: true },
    );
    expect(disabled.ok).toBe(false);
    expect(Number.isFinite(disabled.at.getTime())).toBe(true);
  });

  it('lets account settings override connector defaults and types for a human time', () => {
    expect(resolvePacing({ perMinute: 20, typing: false }, { perMinute: 3 })).toMatchObject({
      perMinute: 3,
      typing: false,
    });
    expect(typingDurationMs('ok', fixed)).toBe(1_000);
    expect(typingDurationMs('x'.repeat(1_000), fixed)).toBe(8_000);
  });
});

describe('messenger session status', () => {
  const row = (patch: Partial<MessengerAccountRow>): MessengerAccountRow => ({
    accountId: 'acc_1',
    leaseOwner: 'gw',
    leaseOwnerUrl: null,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    fencingToken: 1,
    state: 'online',
    problem: null,
    problemMessage: null,
    failures: 0,
    nextAttemptAt: null,
    lastOnlineAt: new Date(),
    sendPausedUntil: null,
    sendPauseReason: null,
    updatedAt: new Date(),
    ...patch,
  });

  it('is online only while the gateway that runs the session holds its lease', () => {
    expect(MessengerAccounts.isOnline(row({}))).toBe(true);
    expect(MessengerAccounts.view(row({})).state).toBe('online');
    // The gateway died without saying so: its lease ran out, the row still says online.
    const stale = row({ leaseExpiresAt: new Date(Date.now() - 1_000) });
    expect(MessengerAccounts.isOnline(stale)).toBe(false);
    expect(MessengerAccounts.view(stale).state).toBe('connecting');
    expect(MessengerAccounts.view(row({ state: 'backoff', leaseExpiresAt: null })).state).toBe('backoff');
  });

  it('says that an open circuit keeps trying', () => {
    const view = MessengerAccounts.view(
      row({ state: 'backoff', problem: 'failing', problemMessage: '8 failed attempts' }),
    );
    expect(view.message).toContain('trying again');
    expect(view.message).toContain('8 failed attempts');
  });
});
