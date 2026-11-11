import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Accessibility rules every page must keep, checked with axe-core in the same real browser as the
 * layout rules (`pages.visual.ts`): contrast in both themes, names for buttons, links and fields,
 * image alt text, heading order, landmarks, ARIA that screen readers understand.
 *
 * Runs the WCAG 2.2 A/AA rule set plus axe's best practices. A rule is switched off only here, with
 * the reason next to it, never per page.
 */
export interface A11yProblem {
  rule: string;
  where: string;
  detail: string;
}

/** axe's own script, injected into each page before the check. */
export const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const OPTIONS = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
  resultTypes: ['violations'],
};

// The project compiles without the DOM library, so the browser globals are typed loosely here.
type Element = any;
declare const document: any, getComputedStyle: (el: Element) => any;

/**
 * Keyboard focus is visible (WCAG 2.4.7), which axe does not check: each visible link, button and
 * field, focused as if by Tab, must change how it or a nearby wrapper looks (outline, ring, border or
 * background). A wrapper counts because tiles show focus on the whole card (`:focus-within`).
 * Runs inside the page, so it stays self-contained.
 */
export function checkFocus(): A11yProblem[] {
  const problems: A11yProblem[] = [];
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  const look = (el: Element): string => {
    const s = getComputedStyle(el);
    return [
      s.outlineStyle !== 'none' && s.outlineWidth !== '0px' ? `${s.outlineStyle} ${s.outlineColor}` : '',
      s.boxShadow,
      s.borderColor,
      s.backgroundColor,
      s.textDecorationLine,
      s.color,
    ].join('|');
  };
  const chain = (el: Element): Element[] => {
    const out: Element[] = [];
    for (let n = el; n && n !== document.body && out.length < 4; n = n.parentElement) out.push(n);
    return out;
  };
  const describe = (el: Element): string => {
    const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 30);
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/)[0]}`
        : '';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : cls} "${label}"`;
  };
  const seen = new Set<string>();
  for (const el of Array.from(document.querySelectorAll(FOCUSABLE)) as Element[]) {
    if (problems.length >= 5) break;
    if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const nodes = chain(el);
    const before = nodes.map(look);
    el.focus({ focusVisible: true, preventScroll: true });
    if (document.activeElement !== el) continue;
    const after = nodes.map(look);
    el.blur();
    if (before.every((b, i) => b === after[i])) {
      const where = describe(el);
      if (seen.has(where)) continue;
      seen.add(where);
      problems.push({
        rule: 'focus-visible',
        where,
        detail: 'looks the same when focused from the keyboard',
      });
    }
  }
  return problems;
}

/** Runs inside the page after `AXE_SOURCE` was injected. */
export const RUN_AXE = `(async () => {
  const result = await axe.run(document, ${JSON.stringify(OPTIONS)});
  return result.violations.flatMap((v) =>
    v.nodes.slice(0, 5).map((n) => ({
      rule: v.id,
      where: n.target.join(' '),
      detail: (n.failureSummary || v.help).replace(/\\s+/g, ' ').slice(0, 300),
    })),
  );
})()`;
