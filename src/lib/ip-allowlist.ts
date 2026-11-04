import { BlockList, isIP } from 'node:net';

/**
 * An allowlist of IP addresses and CIDR ranges ("203.0.113.7", "10.0.0.0/8", "2001:db8::/32").
 * Throws on malformed entries so a typo in the config fails at start-up instead of silently
 * locking everyone out (or letting everyone in).
 */
export class IpAllowlist {
  private readonly list = new BlockList();
  readonly empty: boolean;

  constructor(entries: string[]) {
    this.empty = entries.length === 0;
    for (const entry of entries) {
      const [address, prefix, extra] = entry.split('/');
      const family = isIP(address ?? '');
      const type = family === 6 ? 'ipv6' : 'ipv4';
      if (!family || extra !== undefined) throw new Error(`Invalid IP or CIDR range: "${entry}"`);
      if (prefix === undefined) {
        this.list.addAddress(address!, type);
        continue;
      }
      const bits = Number(prefix);
      if (!/^\d+$/.test(prefix) || bits > (family === 6 ? 128 : 32))
        throw new Error(`Invalid CIDR range: "${entry}"`);
      this.list.addSubnet(address!, bits, type);
    }
  }

  /** True when the list is empty (no restriction) or contains the address. */
  allows(ip: string): boolean {
    if (this.empty) return true;
    const address = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
    const family = isIP(address);
    if (!family) return false;
    return this.list.check(address, family === 6 ? 'ipv6' : 'ipv4');
  }
}
