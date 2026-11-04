import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SITE_JS } from '../src/web/client-scripts.js';

type Listener = () => void;
interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Runs /assets/site.js against a fake page with one dropdown menu (`details[data-menu]`) whose
 * button sits at `button` in a window of `viewport` size, opens it and returns where the menu went.
 */
function openMenu(viewport: { width: number; height: number }, button: Rect, menuSize = { w: 300, h: 200 }) {
  const pop = {
    classList: new Set<string>(),
    style: {} as Record<string, string>,
    offsetWidth: menuSize.w,
    offsetHeight: menuSize.h,
  };
  const summary = { getBoundingClientRect: () => button };
  const listeners: Record<string, Listener[]> = {};
  const menu = {
    open: false,
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = [...(listeners[type] ?? []), fn];
    },
    querySelector: (sel: string) => (sel === '.menu-pop' ? pop : sel === 'summary' ? summary : null),
    contains: () => false,
  };
  const noop = () => {};
  const root = {
    classList: { add: noop, toggle: noop, contains: () => false },
    getAttribute: () => null,
    setAttribute: noop,
    clientWidth: viewport.width,
  };
  const document = {
    documentElement: root,
    querySelectorAll: (sel: string) => (sel === 'details[data-menu]' ? [menu] : []),
    querySelector: () => null,
    addEventListener: noop,
  };
  const window = { innerHeight: viewport.height, scrollY: 0, addEventListener: noop };
  runInNewContext(SITE_JS, {
    document,
    window,
    history: {},
    navigator: {},
    localStorage: undefined,
    setTimeout,
  });
  menu.open = true;
  for (const fn of listeners.toggle ?? []) fn();
  return {
    floating: pop.classList.has('floating'),
    left: Number.parseFloat(pop.style.left ?? 'NaN'),
    top: Number.parseFloat(pop.style.top ?? 'NaN'),
  };
}

describe('dropdown menus in site.js', () => {
  it('opens under its button, right edges aligned, above every card', () => {
    const placed = openMenu({ width: 1440, height: 900 }, { top: 180, bottom: 212, left: 1268, right: 1343 });
    expect(placed).toEqual({ floating: true, left: 1343 - 300, top: 212 + 6 });
  });

  it('opens upwards when there is no room below the button', () => {
    const placed = openMenu({ width: 1440, height: 640 }, { top: 568, bottom: 600, left: 1268, right: 1343 });
    expect(placed.top).toBe(568 - 6 - 200);
  });

  it('stays inside a narrow window', () => {
    const placed = openMenu({ width: 390, height: 844 }, { top: 300, bottom: 332, left: 100, right: 180 });
    expect(placed.left).toBe(8);
    expect(placed.top).toBe(338);
  });
});
