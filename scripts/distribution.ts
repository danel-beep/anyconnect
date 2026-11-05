// Writes the AI app directory files (server.json, plugins in integrations/...) from
// src/distribution/listing.ts. Usage: npm run distribution          (write)
//                                     npm run distribution -- --check (fail if out of date)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { distributionFiles } from '../src/distribution/manifests.js';
import { VERSION } from '../src/version.js';

const root = join(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const stale: string[] = [];
for (const [path, content] of Object.entries(distributionFiles(VERSION))) {
  const target = join(root, path);
  const next = typeof content === 'string' ? Buffer.from(content) : content;
  let current: Buffer | undefined;
  try {
    current = readFileSync(target);
  } catch {
    current = undefined;
  }
  if (current?.equals(next)) continue;
  stale.push(path);
  if (!check) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, next);
  }
}
if (check && stale.length) {
  console.error(`Out of date (run npm run distribution):\n${stale.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(stale.length ? `${check ? 'Stale' : 'Wrote'}: ${stale.join(', ')}` : 'Up to date.');
