import { readFileSync } from 'node:fs';

/** Version from package.json (works from src/ and dist/, both one level below the root). */
export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
