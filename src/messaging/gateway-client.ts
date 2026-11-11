import { z } from 'zod';
import type { DownloadedFile, InboundChat } from '../connectors/messaging.js';
import { ConnectorError } from '../connectors/sdk.js';
import type { MessengerAccounts } from './accounts.js';
import type { StoredAttachment } from './store.js';

/** Interactive login state, shared by the gateway API, the hub and the login page. */
export const LoginView = z.object({
  id: z.string(),
  accountId: z.string(),
  /** What the user has to do next. */
  step: z.enum(['scan_qr', 'enter_code', 'enter_password', 'show_pairing_code', 'done', 'failed']),
  /** QR payload to render (WhatsApp, Telegram QR login). Refreshes; poll the flow. */
  qr: z.string().optional(),
  /** Pairing code to type on the phone (WhatsApp "link with phone number"). */
  pairingCode: z.string().optional(),
  /** Hint for the password step (Telegram 2FA hint). */
  hint: z.string().optional(),
  identity: z.string().optional(),
  error: z.string().optional(),
  expiresAt: z.string(),
});
export type LoginView = z.infer<typeof LoginView>;

export const StartLoginInput = z.object({
  method: z.enum(['qr', 'phone']),
  /** International format, digits only or with "+". Required for `phone`. */
  phone: z
    .string()
    .regex(/^\+?[0-9]{6,16}$/)
    .optional(),
});
export type StartLoginInput = z.infer<typeof StartLoginInput>;

export const LoginStepInput = z.object({
  code: z.string().trim().min(1).max(32).optional(),
  password: z.string().min(1).max(256).optional(),
});
export type LoginStepInput = z.infer<typeof LoginStepInput>;

/** A session driver of the gateway and whether it can take logins (`GET /v1/drivers`). */
export const DriverStatus = z.object({
  connectorId: z.string(),
  ready: z.boolean(),
  /** Why it is not ready: words for the server owner and the env vars that fix it. */
  missing: z.object({ message: z.string(), env: z.array(z.string()) }).optional(),
});
export type DriverStatus = z.infer<typeof DriverStatus>;

/** Operations of the messenger gateway that need the live session. */
export interface GatewayApi {
  resolveRecipient(accountId: string, to: string): Promise<InboundChat>;
  download(
    accountId: string,
    ref: { chatExternalId: string; messageExternalId: string; attachment: StoredAttachment },
  ): Promise<DownloadedFile>;
  /** Loads older messages of a chat from the messenger into the store. */
  backfill(accountId: string, chatExternalId: string, limit: number): Promise<{ ingested: number }>;
  startLogin(accountId: string, input: StartLoginInput): Promise<LoginView>;
  getLogin(accountId: string, loginId: string): Promise<LoginView>;
  submitLogin(accountId: string, loginId: string, input: LoginStepInput): Promise<LoginView>;
  cancelLogin(accountId: string, loginId: string): Promise<void>;
  logout(accountId: string): Promise<void>;
  /** The gateway's session drivers and whether each is set up. */
  drivers(): Promise<DriverStatus[]>;
}

export class GatewayUnavailableError extends ConnectorError {
  constructor(message = 'The messenger gateway is not reachable right now. Try again in a minute.') {
    super('upstream', message);
  }
}

/**
 * One path segment of a gateway URL. Ids reach this client from request paths, so they are encoded
 * (a `/` or `?` inside one stays inside its segment) and a dot segment, which a URL parser would
 * resolve to another account's endpoint, is refused.
 */
function segment(value: string): string {
  if (!value || value === '.' || value === '..') throw new ConnectorError('not_found', 'Not found');
  return encodeURIComponent(value);
}

const accountPath = (accountId: string) => `/v1/accounts/${segment(accountId)}`;

/**
 * HTTP client of the gateway's internal API (private network, bearer token). Requests for an
 * account go to the gateway instance that holds its session, as recorded in its lease.
 */
export class HttpGatewayClient implements GatewayApi {
  constructor(
    private readonly options: {
      baseUrl: string;
      token: string;
      messengerAccounts: MessengerAccounts;
      timeoutMs?: number;
    },
  ) {}

  private async target(accountId: string): Promise<string> {
    const row = await this.options.messengerAccounts.get(accountId);
    if (row?.leaseOwnerUrl && row.leaseExpiresAt && row.leaseExpiresAt > new Date()) return row.leaseOwnerUrl;
    return this.options.baseUrl;
  }

  private async request<T>(accountId: string, method: string, path: string, body?: unknown): Promise<T> {
    return this.send<T>(await this.target(accountId), method, path, body);
  }

  private async send<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
    } catch (_error) {
      throw new GatewayUnavailableError(undefined);
    }
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      const payload = contentType.includes('json')
        ? ((await response.json().catch(() => ({}))) as { error?: { kind?: string; message?: string } })
        : {};
      const kind = (payload.error?.kind ?? 'upstream') as ConstructorParameters<typeof ConnectorError>[0];
      throw new ConnectorError(kind, payload.error?.message ?? `Gateway error ${response.status}`);
    }
    if (!contentType.includes('json')) {
      const data = new Uint8Array(await response.arrayBuffer());
      const name = response.headers.get('x-file-name');
      return { data, mimeType: contentType, ...(name ? { name: decodeURIComponent(name) } : {}) } as T;
    }
    return (await response.json()) as T;
  }

  async drivers(): Promise<DriverStatus[]> {
    const body = await this.send<{ drivers: unknown }>(this.options.baseUrl, 'GET', '/v1/drivers');
    return z.array(DriverStatus).parse(body.drivers);
  }

  resolveRecipient(accountId: string, to: string): Promise<InboundChat> {
    return this.request(accountId, 'POST', `${accountPath(accountId)}/resolve`, { to });
  }

  download(
    accountId: string,
    ref: { chatExternalId: string; messageExternalId: string; attachment: StoredAttachment },
  ): Promise<DownloadedFile> {
    return this.request(accountId, 'POST', `${accountPath(accountId)}/download`, ref);
  }

  backfill(accountId: string, chatExternalId: string, limit: number): Promise<{ ingested: number }> {
    return this.request(accountId, 'POST', `${accountPath(accountId)}/backfill`, { chatExternalId, limit });
  }

  async startLogin(accountId: string, input: StartLoginInput): Promise<LoginView> {
    return LoginView.parse(await this.request(accountId, 'POST', `${accountPath(accountId)}/login`, input));
  }

  async getLogin(accountId: string, loginId: string): Promise<LoginView> {
    return LoginView.parse(
      await this.request(accountId, 'GET', `${accountPath(accountId)}/login/${segment(loginId)}`),
    );
  }

  async submitLogin(accountId: string, loginId: string, input: LoginStepInput): Promise<LoginView> {
    return LoginView.parse(
      await this.request(accountId, 'POST', `${accountPath(accountId)}/login/${segment(loginId)}`, input),
    );
  }

  async cancelLogin(accountId: string, loginId: string): Promise<void> {
    await this.request(accountId, 'DELETE', `${accountPath(accountId)}/login/${segment(loginId)}`);
  }

  async logout(accountId: string): Promise<void> {
    await this.request(accountId, 'POST', `${accountPath(accountId)}/logout`);
  }
}
