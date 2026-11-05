/**
 * Layout rules every page must keep, checked in a real browser (Playwright `page.evaluate`).
 * The function runs inside the page, so it must stay self-contained: no imports, no closures.
 *
 * What it catches, from bugs that reached production:
 * - the page scrolls sideways (something wider than the window);
 * - text glued to the edge of a card, notice or banner (a block without its padding);
 * - content sticking out of its card.
 */
export interface LayoutProblem {
  rule: 'page-overflow' | 'text-at-edge' | 'card-overflow';
  /** A short CSS-like path to the element, for the failure message. */
  where: string;
  detail: string;
}

/** Boxes whose text needs breathing room from their border. */
export const BOXES = '.card, .notice, .warning, .flash, .callout, .empty-state, .hint-box';

// The project compiles without the DOM library (it would clash with Node's fetch types), so the
// browser globals this in-page function uses are typed loosely here.
type Element = any;
declare const document: any, getComputedStyle: (el: Element) => any, NodeFilter: any;

export function checkLayout(boxesSelector: string): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  const doc = document.documentElement;
  const describe = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body && parts.length < 4) {
      const id = node.id ? `#${node.id}` : '';
      const cls =
        typeof node.className === 'string' && node.className.trim()
          ? `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      parts.unshift(`${node.tagName.toLowerCase()}${id}${cls}`);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const visible = (el: Element): boolean => {
    // Also false inside a closed <details>, whose content still has a layout box in Chromium.
    if (
      !el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })
    ) {
      return false;
    }
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0)
      return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  /** Inside a box that scrolls sideways (wide tables): its content may legitimately run off. */
  const scrolls = (el: Element, stop: Element): boolean => {
    for (let n = el.parentElement; n && n !== stop; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true;
    }
    return false;
  };
  /** Text in a control has its own box: measure the control, not the glyphs. */
  const CONTROL = 'button, input, select, textarea, .btn, .badge, code, kbd, img, svg, .logo-tile';

  // 1. Nothing wider than the window.
  if (doc.scrollWidth > doc.clientWidth + 1) {
    const offenders: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*')) as Element[]) {
      if (offenders.length >= 3) break;
      const r = el.getBoundingClientRect();
      if (r.right > doc.clientWidth + 1 && visible(el) && !scrolls(el, document.body)) {
        // Report the outermost offender only.
        if (!offenders.some((o) => o && el.parentElement && describe(el.parentElement).endsWith(o))) {
          offenders.push(describe(el));
        }
      }
    }
    problems.push({
      rule: 'page-overflow',
      where: offenders.join(' | ') || 'body',
      detail: `page is ${doc.scrollWidth}px wide in a ${doc.clientWidth}px window`,
    });
  }

  // 2 and 3. Text inside boxes keeps off the border; content stays inside.
  const boxes = (Array.from(document.querySelectorAll(boxesSelector)) as Element[]).filter(visible);
  for (const box of boxes) {
    const b = box.getBoundingClientRect();
    const style = getComputedStyle(box);
    const framed =
      style.borderTopWidth !== '0px' ||
      style.borderLeftWidth !== '0px' ||
      (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent');
    if (!framed) continue;
    // A box that scrolls sideways (a flush card around a wide table) may hold wider content.
    const sideways = style.overflowX === 'auto' || style.overflowX === 'scroll';
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const reported = new Set<Element>();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const parent = node.parentElement;
      if (!parent || !visible(parent) || scrolls(parent, box)) continue;
      // Text of a nested box is checked against that box.
      const owner = parent.closest(boxesSelector);
      if (owner !== box) continue;
      const control = parent.closest(CONTROL);
      const target = control && box.contains(control) ? control : parent;
      if (reported.has(target)) continue;
      const rects =
        target === parent
          ? Array.from(
              (() => {
                const range = document.createRange();
                range.selectNodeContents(node);
                return range.getClientRects();
              })(),
            )
          : [target.getBoundingClientRect()];
      for (const r of rects) {
        if (r.width === 0 || r.height === 0) continue;
        const gaps: Record<string, number> = { top: r.top - b.top, bottom: b.bottom - r.bottom };
        if (!sideways) Object.assign(gaps, { left: r.left - b.left, right: b.right - r.right });
        const out = Object.entries(gaps).find(([, gap]) => gap < -1);
        if (out) {
          reported.add(target);
          problems.push({
            rule: 'card-overflow',
            where: describe(target),
            detail: `sticks out of ${describe(box)} on the ${out[0]} by ${Math.round(-out[1])}px`,
          });
          break;
        }
        const tight = Object.entries(gaps).find(
          ([side, gap]) => gap < (side === 'top' || side === 'bottom' ? 6 : 10),
        );
        if (tight) {
          reported.add(target);
          problems.push({
            rule: 'text-at-edge',
            where: describe(target),
            detail: `"${(node.textContent ?? '').trim().slice(0, 40)}" is ${Math.round(tight[1])}px from the ${tight[0]} edge of ${describe(box)}`,
          });
          break;
        }
      }
    }
  }
  return problems;
}
