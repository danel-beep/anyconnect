import { describe, expect, it } from 'vitest';
import { dataResult, NOTICES_KEY, toTransport, withNotice } from '../src/hub/result.js';

/**
 * Hub notes for the AI (quota warnings, "not repeated") must reach the model whichever part of the
 * result its client reads: Claude shows the model `structuredContent` and never the text blocks.
 */
describe('withNotice', () => {
  it('puts the note in the text and in structuredContent, in order', () => {
    const result = withNotice(withNotice(dataResult({ id: 'm1' }), 'second'), 'first', 'start');
    expect(result.content.map((c) => (c as { text: string }).text)).toEqual([
      'first',
      '{"id":"m1"}',
      'second',
    ]);
    expect(result.structuredContent).toEqual({ id: 'm1', [NOTICES_KEY]: ['first', 'second'] });
    expect(result.data).toEqual({ id: 'm1' });
  });

  it('keeps notes apart for values without structuredContent, and never sends that copy', () => {
    const result = withNotice(dataResult([1, 2]), 'Almost at the monthly limit.');
    expect(result.structuredContent).toBeUndefined();
    expect(result.notices).toEqual(['Almost at the monthly limit.']);
    expect(toTransport(result)).not.toHaveProperty('notices');
    expect(toTransport(result).content).toHaveLength(2);
  });
});
