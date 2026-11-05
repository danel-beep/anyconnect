/**
 * Letter marks for services whose logos are not in simple-icons (`brand-icons.ts`): one or two
 * letters in the brand's colour, so similar services stay apart in lists instead of sharing a
 * generic icon. Use the key as `icon` in `SERVICE_META`; colours come out as `.bi-<key>` classes
 * like the real marks (see `styles/brands.ts`).
 */
export interface BrandMonogram {
  text: string;
  /** Brand color. */
  hex: string;
}

export const BRAND_MONOGRAMS: Record<string, BrandMonogram> = {
  // Slack's own mark is not in simple-icons: its hash in Slack's aubergine.
  slack: { text: '#', hex: '#4A154B' },
  outlook: { text: 'O', hex: '#0078D4' },
  monday: { text: 'M', hex: '#FF3D57' },
  smartsheet: { text: 'S', hex: '#0073EC' },
  sendgrid: { text: 'SG', hex: '#1A82E2' },
  postmark: { text: 'PM', hex: '#FFDE00' },
  pipedrive: { text: 'P', hex: '#017737' },
  freshdesk: { text: 'F', hex: '#25C16F' },
  twilio: { text: 'T', hex: '#F22F46' },
};
