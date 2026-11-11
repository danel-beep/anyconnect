import { describe, expect, it } from 'vitest';
import { argumentFields, pickLocale } from '../src/security/confirmations.js';

describe('arguments on the confirmation page', () => {
  it('shows text as written, plain lists on one line and the rest as JSON', () => {
    expect(
      argumentFields({
        to: ['dana@example.com', 'lee@example.com'],
        subject: 'Q3 numbers',
        body: 'Hi Dana,\n\nSee attached.',
        draft: false,
        count: 3,
        options: { cc: ['x@example.com'] },
        empty: '',
        missing: null,
      }),
    ).toEqual([
      { name: 'to', value: 'dana@example.com, lee@example.com' },
      { name: 'subject', value: 'Q3 numbers' },
      { name: 'body', value: 'Hi Dana,\n\nSee attached.' },
      { name: 'draft', value: 'false' },
      { name: 'count', value: '3' },
      { name: 'options', value: '{\n  "cc": [\n    "x@example.com"\n  ]\n}' },
    ]);
  });

  it('shows small objects by their values: a guest is an address, a time is a time', () => {
    expect(
      argumentFields({
        start: { dateTime: '2026-12-01T15:00:00+01:00' },
        end: { dateTime: '2026-12-01T16:00:00', timeZone: 'Europe/Berlin' },
        attendees: [{ email: 'ann@example.com' }, { email: 'lee@example.com' }],
        people: [{ email: 'ann@example.com', name: 'Ann' }, { email: 'lee@example.com' }],
        none: [],
      }),
    ).toEqual([
      { name: 'start', value: '2026-12-01T15:00:00+01:00' },
      { name: 'end', value: '2026-12-01T16:00:00 · Europe/Berlin' },
      { name: 'attendees', value: 'ann@example.com, lee@example.com' },
      { name: 'people', value: 'ann@example.com · Ann\nlee@example.com' },
      { name: 'none', value: '[]' },
    ]);
  });

  it('cuts very long values and very many fields', () => {
    const [long] = argumentFields({ body: 'a'.repeat(5000) });
    expect(long!.value).toHaveLength(4001);
    expect(long!.value.endsWith('…')).toBe(true);
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, i]));
    expect(argumentFields(many)).toHaveLength(30);
  });
});

describe('pickLocale', () => {
  it('takes the first supported language and falls back to English', () => {
    expect(pickLocale(null, 'ru-RU')).toBe('ru');
    expect(pickLocale('en', 'ru')).toBe('en');
    expect(pickLocale(undefined, 'de')).toBe('en');
    expect(pickLocale()).toBe('en');
  });
});
