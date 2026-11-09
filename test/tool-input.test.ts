import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Addresses } from '../src/connectors/builtin/email/message.js';
import { parseToolInput } from '../src/hub/input.js';

const Send = z.object({
  to: Addresses.min(1),
  cc: Addresses.optional(),
  subject: z.string(),
  meta: z.object({ tags: z.array(z.string()).default([]) }).optional(),
});

describe('parseToolInput', () => {
  it('passes valid input through unchanged', () => {
    const parsed = parseToolInput(Send, { to: ['a@b.com'], subject: 'Hi' });
    expect(parsed.success && parsed.data.to).toEqual(['a@b.com']);
  });

  it('wraps a single value where a list is expected, at any depth', () => {
    const input = { to: 'a@b.com', cc: 'c@d.com', subject: 'Hi', meta: { tags: 'x' } };
    const parsed = parseToolInput(Send, input);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ to: ['a@b.com'], cc: ['c@d.com'], meta: { tags: ['x'] } });
    expect(input.to).toBe('a@b.com');
  });

  it('keeps the original error when wrapping does not help', () => {
    const parsed = parseToolInput(Send, { to: 'a@b.com' });
    expect(parsed.success).toBe(false);
    const paths = parsed.error?.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('to');
    expect(paths).toContain('subject');
  });

  it('does not turn objects or nulls into lists', () => {
    expect(parseToolInput(Send, { to: { a: 1 }, subject: 'Hi' }).success).toBe(false);
    expect(parseToolInput(Send, { to: null, subject: 'Hi' }).success).toBe(false);
  });
});
