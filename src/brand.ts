/**
 * The product's name in one place. Use it for new user-facing text and identifiers instead of a
 * literal, so a future rename is a one-line change. (Connectors under `src/connectors/` must not
 * import app code; they spell the name out.)
 */
export const BRAND = {
  /** Display name: site, dashboard, MCP server title, emails, passkeys. */
  name: 'Manyplug',
  /** Lowercase identifier: MCP server name in AI app configs, tool prefix, logs. */
  slug: 'manyplug',
} as const;

/**
 * Identifiers the product used before (it was called AnyConnect until November 2026). Data written
 * back then (activity entries of the hub's own tools) still carries them.
 */
export const LEGACY_SLUGS: readonly string[] = ['anyconnect'];
