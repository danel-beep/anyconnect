import { describe, expect, it } from 'vitest';
import {
  cleanLine,
  compact,
  decodeCursor,
  encodeCursor,
  htmlToText,
  page,
  pickFields,
  snippetText,
  stripInvisible,
  truncateText,
} from '../src/connectors/sdk.js';
import { shapeData } from '../src/hub/shaping.js';
import { estimateTokens, toolListTokens } from '../src/hub/tokens.js';

describe('response shaping helpers (SDK)', () => {
  it('converts HTML email bodies to readable text', () => {
    const html = `<html><head><style>p{color:red}</style></head><body>
      <p>Привет,&nbsp;Иван!</p><script>alert(1)</script><!-- tracking -->
      <ul><li>Счёт №5</li><li>Срок &laquo;завтра&raquo;</li></ul>
      <a href="https://pay.example/inv/5">Оплатить</a> <a href="mailto:a@b.c">a@b.c</a>&#x1F600;
    </body></html>`;
    expect(htmlToText(html)).toBe(
      'Привет, Иван!\n\n- Счёт №5\n- Срок «завтра»\n\nОплатить (https://pay.example/inv/5) a@b.c😀',
    );
  });

  it('truncates on a word boundary and says how much is missing', () => {
    const text = 'word '.repeat(100).trim();
    const cut = truncateText(text, 52);
    expect(cut.startsWith('word word')).toBe(true);
    expect(cut).toMatch(/… \[\+\d+ chars\]$/);
    expect(truncateText('short', 10)).toBe('short');
  });

  it('picks fields of objects, arrays and pages, always keeping id', () => {
    const item = { id: '1', subject: 'Hi', from: { name: 'A', email: 'a@x' }, body: 'long' };
    expect(pickFields(item, ['subject', 'from.email'])).toEqual({
      id: '1',
      subject: 'Hi',
      from: { email: 'a@x' },
    });
    expect(pickFields([item], ['subject'])).toEqual([{ id: '1', subject: 'Hi' }]);
    expect(pickFields(page([item], { nextCursor: 'c' }), ['body'])).toEqual({
      items: [{ id: '1', body: 'long' }],
      nextCursor: 'c',
    });
  });

  it('drops empty values and round-trips cursors', () => {
    expect(compact({ a: null, b: '', c: [], d: { e: undefined }, f: 0, g: false, h: ['x', null] })).toEqual({
      f: 0,
      g: false,
      h: ['x'],
    });
    expect(page([1], { nextCursor: null })).toEqual({ items: [1] });
    expect(decodeCursor(encodeCursor({ offset: 20 }))).toEqual({ offset: 20 });
    expect(decodeCursor('not base64 json')).toBeUndefined();
  });
});

describe('result size budget (hub)', () => {
  const items = Array.from({ length: 200 }, (_, i) => ({
    id: String(i),
    subject: `Invoice ${i}`,
    snippet: 'x'.repeat(80),
  }));

  it('leaves small results alone (but compact)', () => {
    expect(shapeData({ a: 1, b: null }, { maxTokens: 100 })).toEqual({ data: { a: 1 }, truncated: false });
  });

  it('keeps as many list items as fit and explains the cut', () => {
    const shaped = shapeData({ items, nextCursor: 'abc' }, { maxTokens: 500 });
    expect(shaped.truncated).toBe(true);
    const data = shaped.data as {
      items: unknown[];
      nextCursor: string;
      truncated: { omitted: number; hint: string };
    };
    expect(data.items.length).toBeGreaterThan(5);
    expect(data.items.length + data.truncated.omitted).toBe(200);
    expect(data.nextCursor).toBe('abc');
    expect(estimateTokens(data)).toBeLessThanOrEqual(500);
  });

  it('wraps a top-level array when it has to cut it', () => {
    const data = shapeData(items, { maxTokens: 300 }).data as { items: unknown[]; truncated: object };
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.truncated).toBeDefined();
  });

  it('cuts long strings before dropping items', () => {
    const shaped = shapeData({ id: '1', body: 'слово '.repeat(5000) }, { maxTokens: 400 });
    const data = shaped.data as { body: string };
    expect(data.body).toMatch(/chars\]$/);
    expect(estimateTokens(shaped.data)).toBeLessThanOrEqual(400);
  });

  it('applies the selected fields', () => {
    expect(shapeData(items.slice(0, 2), { maxTokens: 1000, fields: ['subject'] }).data).toEqual([
      { id: '0', subject: 'Invoice 0' },
      { id: '1', subject: 'Invoice 1' },
    ]);
  });

  it('estimates tokens of a tool list', () => {
    const tokens = toolListTokens([{ name: 'a', description: 'x'.repeat(350), inputSchema: {} }]);
    expect(tokens).toBeGreaterThan(100);
    expect(tokens).toBeLessThan(130);
    expect(estimateTokens('привет')).toBe(3);
  });
});

describe('invisible characters (marketing preview padding)', () => {
  // A preview line as a newsletter sends it: text, then hundreds of characters that render as nothing.
  const padding = '͏ ‌ ͏ ‌ ﻿‍ '.repeat(60);
  const sample = `Your November statement is ready.${padding}Questions? Reply to this email.`;

  it('removes them and leaves one space where the padding was', () => {
    expect(stripInvisible(sample)).toBe('Your November statement is ready. Questions? Reply to this email.');
    expect(stripInvisible('soft­hyphen and zero​width')).toBe('softhyphen and zerowidth');
    expect(stripInvisible('﻿Hello')).toBe('Hello');
  });

  it('keeps joiners inside emoji and words, code indentation and plain line breaks', () => {
    const family = '👨‍👩‍👧';
    expect(stripInvisible(`Family ${family} photo`)).toBe(`Family ${family} photo`);
    expect(stripInvisible('می‌خواهم')).toBe('می‌خواهم');
    const code = 'if (x) {\n    return 1;\n}';
    expect(stripInvisible(code)).toBe(code);
    expect(stripInvisible('line one ‌\n‌line two')).toBe('line one\nline two');
  });

  it('makes one short clean line for snippets', () => {
    const snippet = snippetText(`${sample} ${'More text follows here. '.repeat(20)}`);
    expect(snippet.length).toBeLessThanOrEqual(200);
    expect(snippet.startsWith('Your November statement is ready. Questions? Reply')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).not.toMatch(/͏|‌|‍|﻿| |\s{2}/);
    expect(cleanLine('  Re:\u00A0\u00A0Invoice\n  #42 ')).toBe('Re: Invoice #42');
    expect(snippetText('Short one.')).toBe('Short one.');
  });

  it('is applied to every tool result by the hub', () => {
    const shaped = shapeData({ items: [{ id: 'a1', text: sample }] }, { maxTokens: 2000 });
    expect(shaped.data).toEqual({
      items: [{ id: 'a1', text: 'Your November statement is ready. Questions? Reply to this email.' }],
    });
  });
});
