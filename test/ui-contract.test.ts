/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { APP_CSS } from '../src/web/styles.js';
import { classIsStyled, cssCompounds, isComponent, type JsxElement, scanTsx } from './ui/markup.js';

/**
 * The markup contract of the website, dashboard and admin panel. A layout that "floats" usually
 * starts as a class that styles nothing (a typo, a modifier used without its base class, a class
 * that was renamed in the CSS): the page renders, nothing fails, and the block silently loses its
 * padding. These rules turn that into a failing test, without a browser:
 *
 * 1. Every class on an element is used by the stylesheet in a way that can match that element
 *    (`pad` alone is not styled when the CSS only knows `.card-head.pad`).
 * 2. No `style` attributes: the Content-Security-Policy (`style-src 'self'`) drops them in
 *    production, so a page that looks right in a test would break live.
 * 3. Classes are for styling only: scripts and tests find elements by `data-*` attributes or ids.
 *
 * Fix a failure in the markup or the CSS, never by allowing it here: see docs/UI.md.
 */

// Imported (as text) rather than read from disk, so the markup is part of this test's import graph
// and `vitest --changed` (npm run check:fast) runs the contract when only a .tsx file changed.
const sources = import.meta.glob<string>('../src/**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const sheet = cssCompounds(APP_CSS);
const elements: JsxElement[] = Object.entries(sources).flatMap(([path, source]) =>
  scanTsx(path.replace(/^\.\.\//, ''), source),
);

const where = (e: JsxElement) => `${e.file}:${e.line} <${e.tag}>`;

describe('UI contract', () => {
  it('reads the markup and the stylesheet', () => {
    // Guards the scanner itself: if it stops finding things, the rules below prove nothing.
    expect(elements.length).toBeGreaterThan(2000);
    expect(elements.filter((e) => e.classes.length > 0).length).toBeGreaterThan(1200);
    expect(sheet.compounds.length).toBeGreaterThan(1000);
  });

  it('styles every class used in the markup', () => {
    const unstyled = elements.flatMap((element) =>
      element.classes
        .filter((token) => !classIsStyled(sheet, element, token))
        .map((token) => `${where(element)} class "${token.name}${token.prefix ? '…' : ''}"`),
    );
    expect(unstyled, 'classes that style nothing on these elements (see docs/UI.md)').toEqual([]);
  });

  it('never uses inline styles (the CSP blocks them in production)', () => {
    const inline = elements.filter((e) => !isComponent(e.tag) && e.attributes.includes('style')).map(where);
    expect(inline).toEqual([]);
  });
});

describe('UI contract scanner', () => {
  const css = cssCompounds(
    '.card{padding:24px}.card-head.pad{padding:20px}@media (max-width:640px){ul.plain>li:first-child{border:0}}' +
      ':where(svg.i){width:1em}.prose :is(h2,h3){margin:0}.btn:not(.ghost):hover{color:red}.heat-3{opacity:.3}' +
      '.menu>summary:has(.menu-label){gap:4px}',
  );
  const one = (markup: string) => scanTsx('x.tsx', markup)[0]!;
  const styled = (markup: string) => {
    const element = one(markup);
    return Object.fromEntries(element.classes.map((t) => [t.name, classIsStyled(css, element, t)]));
  };

  it('finds the classes an element can have', () => {
    expect(one('<p class="muted pad">x</p>').classes.map((c) => c.name)).toEqual(['muted', 'pad']);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: TSX source text under test
    const dynamic = one("<span class={`logo ${big ? 'lg' : ''} heat-${n}`} data-x={a > b}>");
    expect(dynamic.classes).toEqual([
      { name: 'logo', prefix: false },
      { name: 'lg', prefix: false },
      { name: 'heat-', prefix: true },
    ]);
    expect(dynamic.attributes).toEqual(['class', 'data-x']);
    // Arguments of calls are not class names; generics and comparisons are not elements.
    expect(one("<div class={pctClass('w', used, max)} />").classes).toEqual([]);
    // Compared values are data, not class names.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: TSX source text under test
    expect(one("<i class={`dot ${s === 'active' ? 'ok' : 'bad'}`} />").classes.map((c) => c.name)).toEqual([
      'dot',
      'ok',
      'bad',
    ]);
    expect(scanTsx('x.tsx', 'const m = new Map<string, number>(); if (a<b) x();')).toEqual([]);
  });

  it('knows which classes style which elements', () => {
    expect(styled('<div class="card">')).toEqual({ card: true });
    expect(styled('<p class="card pad">')).toEqual({ card: true, pad: false });
    expect(styled('<div class="card-head pad">')).toEqual({ 'card-head': true, pad: true });
    expect(styled('<ul class="plain">')).toEqual({ plain: true });
    expect(styled('<ol class="plain">')).toEqual({ plain: false });
    expect(styled('<svg class="i">')).toEqual({ i: true });
    expect(styled('<div class="prose">')).toEqual({ prose: true });
    expect(styled('<a class="btn ghost">')).toEqual({ btn: true, ghost: false });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: TSX source text under test
    expect(styled('<i class={`heat-${level}`}>')).toEqual({ 'heat-': true });
    expect(styled('<h2 class="h3">')).toEqual({ h3: false });
    expect(styled('<span class="menu-label">')).toEqual({ 'menu-label': true });
  });
});
