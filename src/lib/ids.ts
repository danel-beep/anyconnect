import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Time-sortable, prefixed identifiers (ULID layout: 48-bit ms timestamp + 80 random bits),
 * e.g. `acc_01j9z3k6m4q8v2w7x5y1z3a4b6`. The prefix makes ids self-describing in logs and APIs.
 */
export function newId(prefix: IdPrefix): string {
  const bytes = new Uint8Array(16);
  const now = Date.now();
  // 48-bit big-endian timestamp
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = (now >>> 24) & 0xff;
  bytes[3] = (now >>> 16) & 0xff;
  bytes[4] = (now >>> 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes.set(randomBytes(10), 6);
  return `${prefix}_${encodeBase32(bytes)}`;
}

export type IdPrefix =
  | 'usr' // hub user
  | 'wsp' // workspace
  | 'acc' // connected service account
  | 'cli' // OAuth client (dynamic registration)
  | 'grt' // OAuth grant (an AI client connected to a workspace)
  | 'pat' // personal access token
  | 'app' // AI client as the user sees it (Claude, ChatGPT, a script), the subject of policies
  | 'prs' // persona: a named slice of the workspace with its own MCP URL
  | 'rul' // access rule (client × persona × account × risk)
  | 'pcl' // pending call: waiting for confirmation or for its undo window
  | 'ntf' // notification channel (e.g. the owner's Telegram chat)
  | 'pky' // passkey (WebAuthn credential)
  | 'oap' // OAuth app of a service provider (bring your own app)
  | 'svc' // user-defined service (remote MCP server, HTTP manifest)
  | 'cht' // messenger chat
  | 'msg' // messenger message
  | 'out' // messenger outbox job
  | 'lgn' // messenger login flow
  | 'lim' // limit grant (extra limits on top of a plan)
  | 'adm' // admin audit log entry
  | 'inv' // team invitation
  | 'shr' // account shared with a team member (or the whole team)
  | 'preq' // plan request (manual upgrades before payments)
  | 'err' // error group (the hub's own error tracker)
  | 'inc' // status page incident
  | 'dev'; // browser device key of a user vault
