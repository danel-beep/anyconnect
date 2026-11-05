import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Reader } from 'mmdb-lib';
import { cleanCountry } from './classify.js';

/** Finds the country of a visitor. Only the two-letter code leaves it; addresses are never kept. */
export interface GeoResolver {
  country(input: { ip: string; header: (name: string) => string | undefined }): string | null;
}

/** A country header set by the CDN or platform in front of the hub (`cf-ipcountry`). */
export class HeaderGeo implements GeoResolver {
  constructor(private readonly headers: readonly string[]) {}

  country(input: { header: (name: string) => string | undefined }): string | null {
    for (const name of this.headers) {
      const code = cleanCountry(input.header(name));
      if (code) return code;
    }
    return null;
  }
}

interface MmdbReader {
  get(ip: string): { country_code?: string; country?: { iso_code?: string } } | null;
}

/**
 * A local IP-to-country database in MaxMind format (default: the public-domain
 * `@ip-location-db/geo-whois-asn-country-mmdb`, ~8 MB), loaded on the first lookup. Lookups take
 * microseconds and never leave the process. A missing or broken file turns the lookup off.
 */
export class MmdbGeo implements GeoResolver {
  private reader: MmdbReader | null | undefined;

  constructor(
    private readonly path: string | undefined,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  country(input: { ip: string }): string | null {
    const reader = this.load();
    if (!reader || !input.ip || input.ip === 'unknown') return null;
    try {
      const row = reader.get(input.ip.replace(/^::ffff:/, ''));
      return cleanCountry(row?.country_code ?? row?.country?.iso_code);
    } catch {
      // Not an IP address (a socket path in tests): no country.
      return null;
    }
  }

  private load(): MmdbReader | null {
    if (this.reader !== undefined) return this.reader;
    this.reader = null;
    try {
      const require = createRequire(import.meta.url);
      const file =
        this.path ?? require.resolve('@ip-location-db/geo-whois-asn-country-mmdb/geo-whois-asn-country.mmdb');
      this.reader = new Reader(readFileSync(file)) as unknown as MmdbReader;
    } catch (error) {
      this.onError(error);
    }
    return this.reader;
  }
}

/** The first resolver that knows the country wins (a CDN header, then the local database). */
export class ChainGeo implements GeoResolver {
  constructor(private readonly resolvers: readonly GeoResolver[]) {}

  country(input: { ip: string; header: (name: string) => string | undefined }): string | null {
    for (const resolver of this.resolvers) {
      const code = resolver.country(input);
      if (code) return code;
    }
    return null;
  }
}
