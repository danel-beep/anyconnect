import addressparser from 'nodemailer/lib/addressparser/index.js';
import type { CapabilityBinding, CapabilityInput, CapabilityOutput } from '../../sdk.js';
import { formatAddress } from './message.js';

/**
 * Bindings of mail connectors to the shared `mail.*` capabilities: canonical input → native
 * action input, native result → canonical items. Each connector only says how to turn the
 * canonical search into its own query; the result shapes are shared.
 */

type SearchInput = CapabilityInput<'mail.search'>;
type Summary = CapabilityOutput<'mail.search'>;

/** "A <a@x>, b@y" or a list of such strings → one formatted address per entry. */
export function addressList(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
  return parts.flatMap((part) =>
    typeof part !== 'string'
      ? []
      : addressparser(part, { flatten: true }).flatMap((a) =>
          'address' in a && a.address ? [formatAddress(a)] : [],
        ),
  );
}

/** Native summaries of all mail connectors share these names (see each connector's search). */
interface NativeSummary {
  id: string;
  threadId?: string;
  date?: string;
  from?: string;
  to?: string | string[];
  subject?: string;
  snippet?: string;
  unread?: boolean;
  attachments?: boolean | number;
  bulk?: boolean;
  url?: string;
}

export function toMailSummary(m: NativeSummary): Summary {
  const to = addressList(m.to);
  return {
    id: m.id,
    ...(m.threadId ? { thread_id: m.threadId } : {}),
    ...(m.from ? { from: m.from } : {}),
    ...(to.length ? { to } : {}),
    ...(m.subject ? { subject: m.subject } : {}),
    ...(m.date ? { date: m.date } : {}),
    ...(m.snippet ? { snippet: m.snippet } : {}),
    unread: Boolean(m.unread),
    has_attachments: Boolean(m.attachments),
    ...(m.bulk ? { bulk: true } : {}),
    ...(m.url ? { url: m.url } : {}),
  };
}

/** Keeps the items inside [since, until]: services filter by day, the capability by moment. */
const inRange = (input: SearchInput) => (item: Summary) => {
  if (!item.date) return true;
  const at = Date.parse(item.date);
  if (input.since && at < Date.parse(input.since)) return false;
  if (input.until && at > Date.parse(input.until)) return false;
  return true;
};

/** `mail.search` for a connector whose search returns `{ messages, nextCursor }`. */
export function mailSearch(mapInput: (input: SearchInput) => Record<string, unknown>): CapabilityBinding {
  return {
    id: 'mail.search',
    mapInput: (input) => mapInput(input as SearchInput),
    mapOutput: (result, input) => {
      const { messages, nextCursor } = result as { messages: NativeSummary[]; nextCursor?: string };
      return {
        items: messages.map(toMailSummary).filter(inRange(input as SearchInput)),
        ...(nextCursor ? { nextCursor } : {}),
      };
    },
  };
}

interface NativeMessage extends NativeSummary {
  cc?: string[];
  text?: string;
  attachments?: never;
}

/** `mail.read` for a connector whose read returns the shared `readResult` shape. */
export const mailRead: CapabilityBinding = {
  id: 'mail.read',
  mapInput: ({ id }) => ({ id }),
  mapOutput: (result): CapabilityOutput<'mail.read'> => {
    const r = result as Omit<NativeMessage, 'attachments'> & {
      attachments?: { filename: string; contentType?: string; size?: number }[];
    };
    const summary = toMailSummary({ ...r, attachments: Boolean(r.attachments?.length) });
    const { snippet: _snippet, ...rest } = summary;
    return {
      ...rest,
      ...(r.cc?.length ? { cc: r.cc } : {}),
      body: r.text ?? '',
      ...(r.attachments?.length
        ? {
            attachments: r.attachments.map((a, index) => ({
              id: String(index + 1),
              name: a.filename,
              ...(a.contentType ? { mime_type: a.contentType } : {}),
              ...(a.size !== undefined ? { size: a.size } : {}),
            })),
          }
        : {}),
    };
  },
};

/** `mail.send` for a connector whose send takes `replyToId` and returns `{ id }` or `{ messageId }`. */
export const mailSend: CapabilityBinding = {
  id: 'mail.send',
  mapInput: ({ reply_to_id, ...rest }) => ({ ...rest, ...(reply_to_id ? { replyToId: reply_to_id } : {}) }),
  mapOutput: (result): CapabilityOutput<'mail.send'> => {
    const r = result as { id?: string; messageId?: string; url?: string };
    return { id: r.id ?? r.messageId ?? '', ...(r.url ? { url: r.url } : {}) };
  },
};

/** Quotes a search value for Gmail/Outlook syntax when it has spaces. */
export const quoted = (value: string) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value);

/** Date part (YYYY-MM-DD) of an ISO date or date-time. */
export const day = (value: string) => value.slice(0, 10);

/** The day after an ISO date or date-time: exclusive "before" bounds that keep `until` itself. */
export const dayAfter = (value: string) => {
  const d = new Date(`${day(value)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
