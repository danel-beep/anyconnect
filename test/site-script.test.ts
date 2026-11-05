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
    location: { hash: '' },
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

/**
 * Runs /assets/site.js against a fake "Add a service" card: a search box filtering the full list,
 * which sits in a folded <details>, and a popular row the search hides.
 */
function serviceSearch() {
  const listeners: Record<string, ((e?: unknown) => void)[]> = {};
  const attrs: Record<string, string> = {
    'data-filter': '#list',
    'data-filter-empty': '#none',
    'data-filter-expand': '#all',
    'data-filter-hide': '#popular',
  };
  const input = {
    value: '',
    getAttribute: (k: string) => attrs[k] ?? null,
    addEventListener: (type: string, fn: (e?: unknown) => void) => {
      listeners[type] = [...(listeners[type] ?? []), fn];
    },
    dispatchEvent: (e: { type: string }) => {
      for (const fn of listeners[e.type] ?? []) fn(e);
    },
  };
  const item = (text: string) => ({ hidden: false, getAttribute: () => text });
  const items = [item('gmail mail'), item('slack chat'), item('notion docs')];
  const group = { hidden: false, querySelectorAll: () => items };
  const list = {
    querySelectorAll: (sel: string) =>
      sel === '[data-search]' ? items : sel === '[data-filter-group]' ? [group] : [],
  };
  const details = {
    open: false,
    flags: new Set<string>(),
    setAttribute(k: string) {
      this.flags.add(k);
    },
    removeAttribute(k: string) {
      this.flags.delete(k);
    },
  };
  const popular = { hidden: false };
  const none = { hidden: true };
  const byId: Record<string, unknown> = {
    '#list': list,
    '#all': details,
    '#popular': popular,
    '#none': none,
  };
  const noop = () => {};
  const document = {
    documentElement: {
      classList: { add: noop, toggle: noop, contains: () => false },
      getAttribute: () => null,
    },
    querySelectorAll: (sel: string) => (sel === '[data-filter]' ? [input] : []),
    querySelector: (sel: string) => byId[sel] ?? null,
    getElementById: () => null,
    addEventListener: noop,
  };
  class Event {
    constructor(readonly type: string) {}
  }
  runInNewContext(SITE_JS, {
    document,
    window: { innerHeight: 800, scrollY: 0, addEventListener: noop },
    history: {},
    navigator: {},
    location: { hash: '' },
    localStorage: undefined,
    Event,
    setTimeout,
  });
  const type = (value: string) => {
    input.value = value;
    input.dispatchEvent({ type: 'input' });
  };
  const press = (key: string) => {
    for (const fn of listeners.keydown ?? []) fn({ key, preventDefault: noop });
  };
  return { type, press, items, details, popular, none };
}

describe('service search in site.js', () => {
  it('opens the full list while searching, hides the popular row and restores both after', () => {
    const page = serviceSearch();
    page.type('mail');
    expect(page.items.map((i) => i.hidden)).toEqual([false, true, true]);
    expect(page.details.open).toBe(true);
    expect(page.details.flags.has('data-searching')).toBe(true);
    expect(page.popular.hidden).toBe(true);

    page.type('nothing like this');
    expect(page.none.hidden).toBe(false);

    // Escape clears the box; the list goes back to folded because it was folded before.
    page.press('Escape');
    expect(page.items.every((i) => !i.hidden)).toBe(true);
    expect(page.details.open).toBe(false);
    expect(page.details.flags.has('data-searching')).toBe(false);
    expect(page.popular.hidden).toBe(false);
    expect(page.none.hidden).toBe(true);
  });

  it('keeps the list open after a search when it was open before', () => {
    const page = serviceSearch();
    page.details.open = true;
    page.type('slack');
    page.type('');
    expect(page.details.open).toBe(true);
  });
});
