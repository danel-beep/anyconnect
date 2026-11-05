/**
 * Static analysis of the web panel's markup and CSS for `test/ui-contract.test.ts`.
 *
 * - `cssCompounds()` reads a stylesheet into compound selectors (`ul.plain`, `.card-head.pad`), each
 *   with its tag and the classes it requires, including those inside `@media`/`@supports`.
 * - `scanTsx()` finds every JSX element in a `.tsx` file with its tag, its `class` (the class names
 *   it can have, from string literals, template literals and conditionals) and its other attributes.
 *
 * Both are deliberately small: the markup is our own and formatted by Biome, so a full TSX or CSS
 * parser is not needed. Anything the scanner cannot read with certainty (a class passed in a
 * variable, a computed suffix) is skipped rather than guessed.
 */

export interface Compound {
  /** Lower-case tag name, if the compound names one (`ul.plain` → `ul`). */
  tag?: string;
  /** Classes the element must have for this compound to match it. */
  classes: string[];
}

export interface Stylesheet {
  compounds: Compound[];
  /** Every class name the stylesheet mentions anywhere. */
  classes: Set<string>;
}

const CLASS_IN_SELECTOR = /\.(-?[_a-zA-Z][\w-]*)/g;

/** Splits on `sep` outside parentheses and brackets. */
function splitTop(text: string, isSep: (ch: string, i: number) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && isSep(ch, i)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** `:is(a,b) .x` → [`a .x`, `b .x`]; `:where(svg.i)` → `svg.i`. */
function expandMatches(selector: string): string[] {
  const m = /:(?:is|where)\(/.exec(selector);
  if (!m) return [selector];
  const open = m.index + m[0].length;
  let depth = 1;
  let close = open;
  for (; close < selector.length && depth > 0; close++) {
    if (selector[close] === '(') depth++;
    else if (selector[close] === ')') depth--;
  }
  const inner = selector.slice(open, close - 1);
  const before = selector.slice(0, m.index);
  const after = selector.slice(close);
  return splitTop(inner, (ch) => ch === ',').flatMap((alt) => expandMatches(`${before}${alt}${after}`));
}

/** The compounds of one complex selector (`ul.plain > li:first-child` → `ul.plain`, `li`). */
function compoundsOf(selector: string): Compound[] {
  // `summary:has(.menu-label)`: the class inside marks a descendant, so it is a compound of its own.
  const related = [...selector.matchAll(/:has\(((?:[^()]|\([^()]*\))*)\)/gi)].flatMap((m) =>
    splitTop(m[1]!, (ch) => ch === ',').flatMap((relative) => compoundsOf(relative.replace(/^[>+~]\s*/, ''))),
  );
  // Pseudo-elements and negations never require a class of the element.
  const cleaned = selector
    .replace(/::?[a-z-]+\((?:[^()]|\([^()]*\))*\)/gi, (pseudo) => (pseudo.startsWith(':not(') ? '' : pseudo))
    .replace(/::[a-z-]+/gi, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/:[a-z-]+(\((?:[^()]|\([^()]*\))*\))?/gi, '');
  const parts = splitTop(cleaned.replace(/\s*([>+~])\s*/g, ' '), (ch) => ch === ' ');
  const own = parts.map((part): Compound => {
    const tag = /^([a-zA-Z][\w-]*)/.exec(part)?.[1]?.toLowerCase();
    const classes = [...part.matchAll(CLASS_IN_SELECTOR)].map((c) => c[1]!);
    return tag && tag !== '*' ? { tag, classes } : { classes };
  });
  return [...own, ...related];
}

/** Reads every selector of a stylesheet, descending into `@media`, `@supports` and `@container`. */
export function cssCompounds(css: string): Stylesheet {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const compounds: Compound[] = [];
  const classes = new Set<string>();
  let i = 0;
  const readBlock = (end: number) => {
    while (i < end) {
      const open = text.indexOf('{', i);
      if (open < 0 || open >= end) {
        i = end;
        return;
      }
      const prelude = text
        .slice(i, open)
        .trim()
        .replace(/^[;}\s]+/, '');
      // Find the matching closing brace.
      let depth = 1;
      let close = open + 1;
      for (; close < text.length && depth > 0; close++) {
        if (text[close] === '{') depth++;
        else if (text[close] === '}') depth--;
      }
      const bodyEnd = close - 1;
      if (prelude.startsWith('@')) {
        if (/^@(media|supports|container|layer)\b/.test(prelude)) {
          i = open + 1;
          readBlock(bodyEnd);
        }
        // @keyframes, @font-face, @page: no selectors of elements.
      } else {
        for (const selector of splitTop(prelude, (ch) => ch === ',')) {
          for (const expanded of expandMatches(selector)) {
            for (const c of expanded.matchAll(CLASS_IN_SELECTOR)) classes.add(c[1]!);
            compounds.push(...compoundsOf(expanded).filter((c) => c.classes.length > 0));
          }
        }
      }
      i = close;
    }
  };
  readBlock(text.length);
  return { compounds, classes };
}

export interface ClassToken {
  name: string;
  /** The markup builds a longer name from this one (`heat-${level}`). */
  prefix: boolean;
}

export interface JsxElement {
  file: string;
  line: number;
  /** Tag as written: `div`, `svg`, or a component such as `Icon`. */
  tag: string;
  /** Attribute names on the element (`class`, `style`, `data-copy`…). */
  attributes: string[];
  /** Class names the element can have; empty when `class` is missing or not readable. */
  classes: ClassToken[];
  /** Raw source of the `class` value, for error messages. */
  classSource?: string;
}

const IDENT = /[A-Za-z0-9_$]/;

/**
 * Reads a JS expression (the inside of `{...}`) and returns the string pieces that can end up in
 * the value: string literals and the literal parts of template literals. Arguments of function
 * calls are skipped (`pctClass('w', …)` is not the class `w`).
 */
function stringPieces(expr: string): { text: string; endsAtHole: boolean }[] {
  const pieces: { text: string; endsAtHole: boolean }[] = [];
  let i = 0;
  const callDepth: boolean[] = [];
  const inCall = () => callDepth.includes(true);
  const readTemplate = () => {
    // at the opening backtick
    i++;
    let chunk = '';
    while (i < expr.length && expr[i] !== '`') {
      if (expr[i] === '\\') {
        chunk += expr[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (expr[i] === '$' && expr[i + 1] === '{') {
        if (!inCall()) pieces.push({ text: chunk, endsAtHole: true });
        chunk = '';
        i += 2;
        let depth = 1;
        const start = i;
        while (i < expr.length && depth > 0) {
          if (expr[i] === '{') depth++;
          else if (expr[i] === '}') depth--;
          else if (expr[i] === '`') {
            // nested template inside the hole: skip it whole
            let d = 0;
            i++;
            while (i < expr.length && !(expr[i] === '`' && d === 0)) {
              if (expr[i] === '$' && expr[i + 1] === '{') d++;
              else if (expr[i] === '}' && d > 0) d--;
              i++;
            }
          }
          i++;
        }
        const hole = expr.slice(start, i - 1);
        if (!inCall()) pieces.push(...stringPieces(hole));
        continue;
      }
      chunk += expr[i];
      i++;
    }
    i++; // closing backtick
    if (!inCall()) pieces.push({ text: chunk, endsAtHole: false });
  };
  while (i < expr.length) {
    const ch = expr[i]!;
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < expr.length && expr[j] !== ch) {
        if (expr[j] === '\\') {
          value += expr[j + 1] ?? '';
          j += 2;
          continue;
        }
        value += expr[j];
        j++;
      }
      // `status === 'active' ? 'ok' : 'bad'`: a compared value is data, not a class name.
      if (!inCall() && !comparedAt(expr, i, j + 1)) pieces.push({ text: value, endsAtHole: false });
      i = j + 1;
    } else if (ch === '`') {
      readTemplate();
    } else if (ch === '(') {
      // A call when an identifier (or `?.`) comes right before the parenthesis.
      let k = i - 1;
      while (k >= 0 && expr[k] === ' ') k--;
      callDepth.push(k >= 0 && (IDENT.test(expr[k]!) || expr[k] === '.'));
      i++;
    } else if (ch === ')') {
      callDepth.pop();
      i++;
    } else {
      i++;
    }
  }
  return pieces;
}

/** Whether the literal at `start`..`end` is an operand of `===`, `!==`, `==` or `!=`. */
function comparedAt(expr: string, start: number, end: number): boolean {
  const before = expr.slice(0, start).trimEnd();
  const after = expr.slice(end).trimStart();
  return /[=!]==?$/.test(before) || /^[=!]==?/.test(after);
}

const CLASS_NAME = /^-?[_a-zA-Z][\w-]*$/;

function tokensOf(pieces: { text: string; endsAtHole: boolean }[]): ClassToken[] {
  const tokens: ClassToken[] = [];
  for (const piece of pieces) {
    const words = piece.text.split(/\s+/);
    words.forEach((word, index) => {
      if (!word) return;
      const last = index === words.length - 1;
      // `heat-${x}`: the last word right before a hole is only the beginning of a name.
      const prefix = last && piece.endsAtHole && !/\s$/.test(piece.text);
      if (prefix) {
        if (/^[_a-zA-Z][\w-]*$/.test(word)) tokens.push({ name: word, prefix: true });
      } else if (CLASS_NAME.test(word)) tokens.push({ name: word, prefix: false });
    });
  }
  return tokens;
}

/** Reads a balanced `{...}` starting at `start` (the `{`); returns the inside and the end index. */
function readBraces(src: string, start: number): { inner: string; end: number } {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "'" || ch === '"') {
      i++;
      while (i < src.length && src[i] !== ch) i += src[i] === '\\' ? 2 : 1;
    } else if (ch === '`') {
      i++;
      let d = 0;
      while (i < src.length && !(src[i] === '`' && d === 0)) {
        if (src[i] === '\\') i++;
        else if (src[i] === '$' && src[i + 1] === '{') d++;
        else if (src[i] === '}' && d > 0) d--;
        i++;
      }
    } else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { inner: src.slice(start + 1, i), end: i + 1 };
    }
    i++;
  }
  return { inner: src.slice(start + 1), end: src.length };
}

/** Every JSX element of a `.tsx` source with its tag, attributes and possible classes. */
export function scanTsx(file: string, src: string): JsxElement[] {
  const elements: JsxElement[] = [];
  const lineAt = (index: number) => src.slice(0, index).split('\n').length;
  const tagStart = /<([a-zA-Z][\w.]*)(?=[\s/>])/g;
  for (let match = tagStart.exec(src); match; match = tagStart.exec(src)) {
    // `a<b` comparisons and generics (`Map<string, …>`) are not elements.
    const before = src[match.index - 1] ?? '';
    if (IDENT.test(before)) continue;
    const tag = match[1]!;
    let i = match.index + match[0].length;
    const attributes: string[] = [];
    let classes: ClassToken[] = [];
    let classSource: string | undefined;
    let ok = false;
    while (i < src.length) {
      while (/\s/.test(src[i] ?? '')) i++;
      const ch = src[i];
      if (ch === '>' || (ch === '/' && src[i + 1] === '>')) {
        ok = true;
        break;
      }
      if (ch === '{') {
        i = readBraces(src, i).end; // {...spread}
        continue;
      }
      const name = /^[A-Za-z_:][\w:.-]*/.exec(src.slice(i))?.[0];
      if (!name) break; // not JSX after all
      i += name.length;
      attributes.push(name);
      if (src[i] !== '=') continue;
      i++;
      const quote = src[i];
      if (quote === '"' || quote === "'") {
        const end = src.indexOf(quote, i + 1);
        const value = src.slice(i + 1, end);
        if (name === 'class') {
          classes = tokensOf([{ text: value, endsAtHole: false }]);
          classSource = value;
        }
        i = end + 1;
      } else if (quote === '{') {
        const { inner, end } = readBraces(src, i);
        if (name === 'class') {
          classes = tokensOf(stringPieces(inner));
          classSource = inner;
        }
        i = end;
      } else {
        break;
      }
    }
    if (ok) {
      elements.push({
        file,
        line: lineAt(match.index),
        tag,
        attributes,
        classes,
        ...(classSource !== undefined ? { classSource } : {}),
      });
    }
  }
  return elements;
}

/** A component (`<Icon>`), not an HTML element: its real tag and classes are not known here. */
export const isComponent = (tag: string) => /^[A-Z]/.test(tag) || tag.includes('.');

/**
 * Whether a class of an element is used by the stylesheet: some compound mentions it and every
 * other class and the tag that compound needs are on the element too. A class that only styles
 * children (`.prose h2`) counts, since the compound may sit on an ancestor.
 */
export function classIsStyled(sheet: Stylesheet, element: JsxElement, token: ClassToken): boolean {
  if (token.prefix) return [...sheet.classes].some((c) => c.startsWith(token.name));
  const own = new Set(element.classes.filter((c) => !c.prefix).map((c) => c.name));
  const prefixes = element.classes.filter((c) => c.prefix).map((c) => c.name);
  const has = (cls: string) => own.has(cls) || prefixes.some((p) => cls.startsWith(p));
  const component = isComponent(element.tag);
  return sheet.compounds.some(
    (compound) =>
      compound.classes.includes(token.name) &&
      // A component adds classes of its own and picks the tag: only the name is checked there.
      (component ||
        ((!compound.tag || compound.tag === element.tag.toLowerCase()) && compound.classes.every(has))),
  );
}
