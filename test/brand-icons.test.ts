import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../src/connectors/index.js';
import { BRAND_ICONS } from '../src/web/brand-icons.js';
import { BRAND_MONOGRAMS } from '../src/web/brand-monograms.js';
import { HIDDEN_SERVICES, PLANNED_SERVICES, SERVICE_META } from '../src/web/catalog.js';
import { CLIENT_GUIDES } from '../src/web/clients.js';

/** Services that are not a brand (any IMAP mailbox, any REST API): an interface icon is right. */
const GENERIC = new Set(['imap', 'http']);

const known = (icon: string) => Boolean(BRAND_ICONS[icon] || BRAND_MONOGRAMS[icon]);

describe('service logos', () => {
  it('gives every branded connector its brand mark or brand letters', () => {
    for (const { id } of createBuiltinRegistry().all()) {
      if (HIDDEN_SERVICES.has(id)) continue;
      const meta = SERVICE_META[id];
      expect(meta, `${id}: no SERVICE_META entry`).toBeDefined();
      if (GENERIC.has(id)) {
        expect(meta?.icon ?? meta?.glyph, id).toBeDefined();
        continue;
      }
      expect(meta?.icon, `${id}: needs a brand icon in SERVICE_META`).toBeDefined();
      expect(
        known(meta?.icon ?? ''),
        `${id}: "${meta?.icon}" is not in brand-icons.ts or brand-monograms.ts`,
      ).toBe(true);
    }
  });

  it('points every icon reference at a mark that exists', () => {
    const refs = [
      ...Object.entries(SERVICE_META).map(([id, m]) => [id, m.icon] as const),
      ...PLANNED_SERVICES.map((s) => [s.name, s.icon] as const),
      ...CLIENT_GUIDES.map((g) => [g.id, g.icon] as const),
    ];
    for (const [who, icon] of refs) if (icon) expect(known(icon), `${who}: "${icon}"`).toBe(true);
  });

  it('keeps marks and letters apart and every mark drawable', () => {
    for (const slug of Object.keys(BRAND_MONOGRAMS)) expect(BRAND_ICONS[slug], slug).toBeUndefined();
    for (const [slug, icon] of Object.entries(BRAND_ICONS)) {
      expect(icon.path, slug).toMatch(/^[Mm]/);
      expect(icon.hex, slug).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
