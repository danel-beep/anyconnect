import { createHash } from 'node:crypto';
import net from 'node:net';
import { ImapFlow } from 'imapflow';
import { ConnectorError } from '../../sdk.js';
import type { ServerSettings } from './presets.js';

/** Resolves a hostname under the hub's network policy (no private addresses in production). */
export type ResolveHost = (hostname: string) => Promise<string>;

export interface ImapLogin {
  server: ServerSettings;
  user: string;
  password: string;
  /** Accept self-signed certificates (self-hosted servers, Proton Mail Bridge). */
  allowInvalidCertificate?: boolean;
}

const IDLE_CLOSE_MS = 60_000;
const CONNECT_TIMEOUT_MS = 20_000;

interface PoolEntry {
  fingerprint: string;
  client: Promise<ImapFlow>;
  users: number;
  timer?: NodeJS.Timeout | undefined;
  /** Removed from the pool; closed as soon as the last user releases it. */
  dropped?: boolean;
}

const fingerprintOf = (login: ImapLogin) =>
  createHash('sha256')
    .update(JSON.stringify([login.server, login.user, login.password, login.allowInvalidCertificate]))
    .digest('hex');

/** The network policy refused the server, or it does not resolve. */
export function unreachableHost(protocol: string, host: string, error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const refused = (error as Error)?.name === 'UnsafeUrlError';
  return new ConnectorError(
    refused ? 'permission' : 'upstream',
    `${protocol}: cannot use the server ${host}: ${(error as Error)?.message ?? 'lookup failed'}`,
    { cause: error },
  );
}

/** Maps low-level IMAP/socket errors to user-safe connector errors. Never includes credentials. */
export function toConnectorError(error: unknown, what: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const e = error as {
    authenticationFailed?: boolean;
    code?: string;
    responseText?: string;
    serverResponseCode?: string;
    message?: string;
  };
  if (e?.authenticationFailed || e?.serverResponseCode === 'AUTHENTICATIONFAILED' || e?.code === 'EAUTH') {
    return new ConnectorError(
      'auth',
      `${what}: the server rejected the login. Check the address and the app password.`,
      { cause: error },
    );
  }
  if (e?.serverResponseCode === 'NONEXISTENT' || e?.serverResponseCode === 'TRYCREATE') {
    return new ConnectorError('not_found', `${what}: the folder does not exist.`, { cause: error });
  }
  const network = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'CONNECT_TIMEOUT', 'EAI_AGAIN'];
  if (e?.code && network.includes(e.code)) {
    return new ConnectorError('upstream', `${what}: cannot reach the mail server (${e.code}).`, {
      cause: error,
    });
  }
  const detail = e?.responseText ?? e?.message ?? 'unknown error';
  return new ConnectorError('upstream', `${what}: ${detail}`.slice(0, 300), { cause: error });
}

/**
 * Keeps one IMAP connection per account open for a short while, so that a burst of calls
 * (search → read → move, or the same search over many accounts) does not pay for a TLS handshake
 * and login every time. Mailbox access on a shared connection is serialized with mailbox locks.
 */
export class ImapPool {
  private readonly entries = new Map<string, PoolEntry>();

  async use<T>(
    accountId: string,
    login: ImapLogin,
    resolveHost: ResolveHost,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const entry = this.acquire(accountId, login, resolveHost);
    try {
      const client = await entry.client;
      return await fn(client);
    } catch (error) {
      // A broken connection is dropped; command-level errors keep it.
      const client = await entry.client.catch(() => undefined);
      if (!client?.usable) this.drop(accountId, entry);
      throw error;
    } finally {
      this.release(accountId, entry);
    }
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.entries()];
    this.entries.clear();
    await Promise.all(entries.map(([, entry]) => this.close(entry)));
  }

  private acquire(accountId: string, login: ImapLogin, resolveHost: ResolveHost): PoolEntry {
    const fingerprint = fingerprintOf(login);
    let entry = this.entries.get(accountId);
    if (entry && entry.fingerprint !== fingerprint) {
      this.drop(accountId, entry);
      entry = undefined;
    }
    if (entry) {
      const current = entry;
      // Reconnect transparently if the server closed the idle connection.
      current.client = current.client.then(
        (client) => (client.usable ? client : connect(login, resolveHost)),
        () => connect(login, resolveHost),
      );
    } else {
      entry = { fingerprint, client: connect(login, resolveHost), users: 0 };
      this.entries.set(accountId, entry);
    }
    entry.users++;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    return entry;
  }

  private release(accountId: string, entry: PoolEntry): void {
    entry.users--;
    if (entry.users > 0) return;
    if (entry.dropped || this.entries.get(accountId) !== entry) {
      void this.close(entry);
      return;
    }
    entry.timer = setTimeout(() => this.drop(accountId, entry), IDLE_CLOSE_MS);
    entry.timer.unref();
  }

  private drop(accountId: string, entry: PoolEntry): void {
    if (this.entries.get(accountId) === entry) this.entries.delete(accountId);
    entry.dropped = true;
    if (entry.users <= 0) void this.close(entry);
  }

  private async close(entry: PoolEntry): Promise<void> {
    if (entry.timer) clearTimeout(entry.timer);
    const client = await entry.client.catch(() => undefined);
    if (!client) return;
    await client.logout().catch(() => client.close());
  }
}

async function connect(login: ImapLogin, resolveHost: ResolveHost): Promise<ImapFlow> {
  const { host, port, security } = login.server;
  let address: string;
  try {
    address = await resolveHost(host);
  } catch (error) {
    throw unreachableHost('IMAP', host, error);
  }
  const client = new ImapFlow({
    // Connect to the vetted address; the hostname is still used for TLS (SNI + certificate check).
    host: address,
    ...(net.isIP(host) ? {} : { servername: host }),
    tls: { rejectUnauthorized: !login.allowInvalidCertificate },
    port,
    secure: security === 'tls',
    auth: { user: login.user, pass: login.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 5 * 60_000,
    clientInfo: { name: 'Manyplug' },
  });
  // Errors after connect are surfaced through the next command; never crash the process.
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (error) {
    client.close();
    throw toConnectorError(error, 'IMAP');
  }
  return client;
}
