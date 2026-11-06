/**
 * Contract between the messenger gateway and a messenger implementation (a "driver"):
 * Telegram over MTProto, a WhatsApp transport, and later anything else that needs a long-lived
 * connection. The gateway owns everything around the connection — exactly one session per
 * account, encrypted state, message storage, the outbox, pacing, reconnects, status — so a
 * driver only speaks its protocol.
 */
import type {
  DownloadedFile,
  InboundChat,
  InboundMessage,
  OutboundJob,
  SentReceipt,
} from '../../connectors/messaging.js';
import type { ConnectorLogger, NetworkAccess } from '../../connectors/sdk.js';
import type { MessengerProblem } from '../../db/schema.js';
import type { LoginStepInput, LoginView, StartLoginInput } from '../../messaging/gateway-client.js';
import type { StoredAttachment } from '../../messaging/store.js';

/** Encrypted key-value state of one account. Writes are rejected once the lease is lost. */
export interface SessionState {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** All keys starting with `prefix`. */
  list<T = unknown>(prefix: string): Promise<{ key: string; value: T }[]>;
  /** Removes everything (after a logout). */
  clear(): Promise<void>;
}

export interface DriverSession {
  account: { id: string; name: string; config: unknown; credentials: unknown };
  state: SessionState;
  /** Stores messages (deduplicated, encrypted); call for live updates and for catch-up after a restart. */
  ingest(messages: InboundMessage[]): Promise<void>;
  /** Updates chat titles and unread counters (dialog list sync). */
  upsertChats(chats: InboundChat[]): Promise<void>;
  /** Aborted when the session must stop: lease lost, shutdown, account disabled. */
  signal: AbortSignal;
  logger: ConnectorLogger;
  /** Outbound network policy for raw sockets. */
  network: NetworkAccess;
}

/** A connection that is up. */
export interface LiveSession {
  /**
   * Settles when the connection ends: resolves after {@link LiveSession.stop}, rejects with a
   * {@link SessionError} when the connection is lost or the messenger ends the session.
   */
  closed: Promise<void>;
  /** Who the account is logged in as (phone, @username), shown to the user and the AI. */
  identity?: string;
  /** True when re-sending an interrupted job cannot create a duplicate (the messenger deduplicates). */
  idempotentSend: boolean;
  /** Sends a job; throw `DeliveryError` from `connectors/messaging.ts` on failure. */
  send(job: OutboundJob): Promise<SentReceipt | undefined>;
  /** Shows "typing..." for about `durationMs`, resolving when it is time to send. */
  typing?(chatExternalId: string, durationMs: number): Promise<void>;
  resolveRecipient?(to: string): Promise<InboundChat>;
  download?(ref: {
    chatExternalId: string;
    messageExternalId: string;
    attachment: StoredAttachment;
  }): Promise<DownloadedFile>;
  /** Fetches older messages of a chat into the store; returns how many were ingested. */
  backfill?(chatExternalId: string, limit: number): Promise<number>;
  /** Ends the session on the messenger side too (the device disappears from "linked devices"). */
  logout?(): Promise<void>;
  stop(): Promise<void>;
}

/** A classified connection failure. Fatal problems stop the account until the user acts. */
export class SessionError extends Error {
  constructor(
    readonly problem: MessengerProblem,
    message: string,
    readonly options: { retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'SessionError';
  }
}

/** An interactive login in progress (QR code, phone code, 2FA password). */
export interface LoginFlow {
  /** Current step; the host adds id, account and expiry. */
  view(): Omit<LoginView, 'id' | 'accountId' | 'expiresAt'>;
  submit(input: LoginStepInput): Promise<void>;
  cancel(): Promise<void>;
  /** Resolves with the connected session once the user finished, rejects when the login failed. */
  done: Promise<LiveSession>;
}

/** A setup gap of a session driver, in words for the server owner and the env vars that close it. */
export interface DriverMissing {
  message: string;
  env: string[];
}

export interface SessionDriver {
  /** The connector whose `session` transport this driver serves. */
  connectorId: string;
  /**
   * What this gateway still lacks before accounts of the connector can log in (e.g. the service's
   * API keys); undefined when the driver is ready. The hub shows it instead of a dead login page.
   */
  missing?: DriverMissing | undefined;
  /** Connects with saved state; throw `SessionError('logged_out')` when there is none or it is invalid. */
  connect(session: DriverSession): Promise<LiveSession>;
  login?(session: DriverSession, input: StartLoginInput): Promise<LoginFlow>;
}
