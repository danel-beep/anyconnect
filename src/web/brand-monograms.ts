/**
 * Letter marks for services whose logos are not in `brand-icons.ts` (simple-icons or
 * `scripts/brand-icons-extra.json`): one or two letters in the brand's colour, so similar services stay apart in
 * lists instead of sharing a generic icon. Use the key as `icon` in `SERVICE_META`; colours come out as `.bi-<key>` classes
 * like the real marks (see `styles/brands.ts`).
 */
export interface BrandMonogram {
  text: string;
  /** Brand color. */
  hex: string;
}

export const BRAND_MONOGRAMS: Record<string, BrandMonogram> = {
  // No openly licensed copy of these marks exists yet; add a real mark to scripts/brand-icons-extra.json
  // when one does, and drop the letters here.
  smartsheet: { text: 'S', hex: '#0073EC' },
  freshdesk: { text: 'F', hex: '#25C16F' },
  harvest: { text: 'H', hex: '#FA5D00' },
};
