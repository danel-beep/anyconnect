import { describe, expect, it } from 'vitest';
import { translator } from '../src/web/i18n.js';
import { callReason, classifyProblem, needsReconnect, problemText } from '../src/web/problems.js';

const t = translator('en');

describe('failure reasons in plain words', () => {
  it('sorts errors by cause', () => {
    expect(classifyProblem('getaddrinfo ENOTFOUND imap.mail.me.com')).toEqual({
      kind: 'unreachable',
      host: 'imap.mail.me.com',
    });
    expect(classifyProblem('connect ECONNREFUSED 10.0.0.1:993').kind).toBe('unreachable');
    expect(classifyProblem('Todoist API returned 401 Unauthorized').kind).toBe('signin');
    expect(classifyProblem('anything', 'needs_reauth').kind).toBe('signin');
    expect(classifyProblem('403 Forbidden: missing scope').kind).toBe('denied');
    expect(classifyProblem('429 Too Many Requests').kind).toBe('busy');
    expect(classifyProblem('502 Bad Gateway').kind).toBe('service');
    expect(classifyProblem('Not connected yet: connect the account').kind).toBe('unfinished');
    expect(classifyProblem('Mailbox is full').kind).toBe('other');
  });

  it('offers to sign in again only when that is what helps', () => {
    expect(needsReconnect(classifyProblem('401 Unauthorized'))).toBe(true);
    expect(needsReconnect(classifyProblem('getaddrinfo ENOTFOUND api.todoist.com'))).toBe(false);
    expect(needsReconnect(classifyProblem('503 Service Unavailable'))).toBe(false);
  });

  it('never shows system codes, but keeps a service’s own words when nothing better is known', () => {
    const away = problemText(t, classifyProblem('getaddrinfo ENOTFOUND api.todoist.com'));
    expect(away).toContain('api.todoist.com');
    expect(away).not.toContain('ENOTFOUND');
    expect(problemText(t, classifyProblem('Mailbox is full.'), 'Mailbox is full.')).toBe(
      'The last check failed: Mailbox is full.',
    );
  });

  it('explains failed calls from their outcome', () => {
    expect(callReason(t, 'denied', null)).toBe('Your rules do not allow this action.');
    expect(callReason(t, 'not_found', 'No task 42.')).toBe('Not found on the service: No task 42.');
    expect(callReason(t, 'upstream', 'getaddrinfo ENOTFOUND api.notion.com')).toContain('api.notion.com');
    expect(callReason(t, null, 'Something odd')).toBe('Something odd');
  });
});
