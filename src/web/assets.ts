import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Self-hosted fonts (the CSP allows fonts only from the hub itself): Onest for text, JetBrains Mono
 * for code, both variable, Latin and Cyrillic subsets, from the @fontsource-variable packages.
 */
export const SANS = `"Onest Variable",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif`;
export const MONO = `"JetBrains Mono Variable",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const CYRILLIC = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116';

interface FontFile {
  family: string;
  /** Module specifier of the woff2 file. */
  module: string;
  range: string;
  weight: string;
}

/** Public file name → font. */
export const FONT_FILES: Record<string, FontFile> = {
  'onest-latin.woff2': {
    family: 'Onest Variable',
    module: '@fontsource-variable/onest/files/onest-latin-wght-normal.woff2',
    range: LATIN,
    weight: '100 900',
  },
  'onest-latin-ext.woff2': {
    family: 'Onest Variable',
    module: '@fontsource-variable/onest/files/onest-latin-ext-wght-normal.woff2',
    range: LATIN_EXT,
    weight: '100 900',
  },
  'onest-cyrillic.woff2': {
    family: 'Onest Variable',
    module: '@fontsource-variable/onest/files/onest-cyrillic-wght-normal.woff2',
    range: CYRILLIC,
    weight: '100 900',
  },
  'mono-latin.woff2': {
    family: 'JetBrains Mono Variable',
    module: '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
    range: LATIN,
    weight: '100 800',
  },
  'mono-cyrillic.woff2': {
    family: 'JetBrains Mono Variable',
    module: '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-cyrillic-wght-normal.woff2',
    range: CYRILLIC,
    weight: '100 800',
  },
};

export const FONT_FACES = Object.entries(FONT_FILES)
  .map(
    ([file, f]) =>
      `@font-face{font-family:"${f.family}";font-style:normal;font-display:swap;font-weight:${f.weight};src:url(/assets/fonts/${file}) format("woff2");unicode-range:${f.range}}`,
  )
  .join('\n');

const require = createRequire(import.meta.url);
const cache = new Map<string, Buffer>();

/** The bytes of a public font file, or undefined for unknown names. */
export function fontFile(name: string): Buffer | undefined {
  const font = FONT_FILES[name];
  if (!font) return undefined;
  let bytes = cache.get(name);
  if (!bytes) {
    bytes = readFileSync(require.resolve(font.module));
    cache.set(name, bytes);
  }
  return bytes;
}
