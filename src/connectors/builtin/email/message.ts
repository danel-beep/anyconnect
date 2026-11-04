import { type AddressObject, type EmailAddress, type ParsedMail, simpleParser } from 'mailparser';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { z } from 'zod';
import { ConnectorError } from '../../sdk.js';

/**
 * Email helpers shared by every mail connector (IMAP/SMTP, Gmail, ...): parsing raw RFC 5322
 * messages into compact results for the AI, building replies and forwards, composing messages.
 */

export const Addresses = z
  .array(z.string().trim().min(3).max(320))
  .max(50)
  .describe('Addresses: "a@b.com" or "Name <a@b.com>"');

/** Shared inputs of the "read" action of mail connectors. */
export const ReadOptions = {
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(100_000)
    .default(6000)
    .describe('Cut the body after this many characters'),
  includeQuoted: z.boolean().default(false).describe('Keep the quoted previous messages at the end'),
};

export const formatAddress = (a: { name?: string | undefined; address?: string | undefined }): string =>
  a.name && a.address ? `${a.name} <${a.address}>` : (a.address ?? a.name ?? '');

export const isoDate = (value: Date | string | number | undefined): string | undefined => {
  if (value === undefined || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

export function parseRaw(raw: Buffer | string): Promise<ParsedMail> {
  return simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
}

const addressList = (value: AddressObject | AddressObject[] | undefined): EmailAddress[] =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((group) => group.value)
    .filter((a) => a.address);

/** Removes the quoted history at the end of a reply ("> ..." lines and the "On ... wrote:" line). */
export function stripQuotedTail(text: string): { text: string; removed: boolean } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === '') end--;
  let cut = end;
  while (cut > 0 && (lines[cut - 1]!.trimStart().startsWith('>') || lines[cut - 1]!.trim() === '')) cut--;
  if (cut === end) return { text, removed: false };
  const intro = lines[cut - 1];
  if (intro && /(wrote|написал[аи]?|пишет|schrieb|a écrit|escribió):?\s*$/i.test(intro.trim())) cut--;
  if (cut <= 0) return { text, removed: false };
  return { text: lines.slice(0, cut).join('\n').trimEnd(), removed: true };
}

/** The result of a "read" action: headers, plain-text body (cut), attachment list. */
export function readResult(
  parsed: ParsedMail,
  options: {
    id: string;
    maxChars: number;
    includeQuoted: boolean;
    unread?: boolean;
    extra?: Record<string, unknown>;
  },
): Record<string, unknown> {
  let text = (parsed.text ?? '').trim();
  let quotedRemoved = false;
  if (!options.includeQuoted) ({ text, removed: quotedRemoved } = stripQuotedTail(text));
  const totalChars = text.length;
  const truncated = totalChars > options.maxChars;
  if (truncated) text = `${text.slice(0, options.maxChars)}…`;
  const from = addressList(parsed.from).map(formatAddress);
  const to = addressList(parsed.to).map(formatAddress);
  const cc = addressList(parsed.cc).map(formatAddress);
  const replyTo = addressList(parsed.replyTo).map(formatAddress);
  const date = isoDate(parsed.date);
  return {
    id: options.id,
    ...options.extra,
    ...(date ? { date } : {}),
    from: from[0] ?? '',
    ...(to.length ? { to } : {}),
    ...(cc.length ? { cc } : {}),
    ...(replyTo.length && replyTo[0] !== from[0] ? { replyTo } : {}),
    subject: parsed.subject ?? '(no subject)',
    ...(options.unread ? { unread: true } : {}),
    text,
    ...(truncated ? { truncated: true, totalChars } : {}),
    ...(quotedRemoved ? { quotedHistoryRemoved: true } : {}),
    ...(parsed.attachments.length
      ? {
          attachments: parsed.attachments.map((a) => ({
            filename: a.filename ?? 'attachment',
            contentType: a.contentType,
            size: a.size,
          })),
        }
      : {}),
  };
}

export const reSubject = (prefix: 'Re' | 'Fwd', subject: string | undefined) => {
  const s = subject?.trim() || '';
  return new RegExp(`^${prefix}:`, 'i').test(s) ? s : `${prefix}: ${s}`.trim();
};

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

/**
 * Builds a reply to `original` sent from `me`: recipients (Reply-To, else From; with replyAll the
 * other recipients in copy, never yourself), Re: subject and threading headers.
 */
export function buildReply(
  original: ParsedMail,
  options: { me: string; body: string; replyAll: boolean; cc?: string[] | undefined },
): Mail.Options & { to: string[]; cc?: string[] } {
  const { me } = options;
  const primary = addressList(original.replyTo).length
    ? addressList(original.replyTo)
    : addressList(original.from);
  const to = primary.filter((a) => !same(a.address, me)).map(formatAddress);
  const others = options.replyAll
    ? [...addressList(original.to), ...addressList(original.cc)]
        .filter((a) => !same(a.address, me) && !primary.some((x) => same(x.address, a.address!)))
        .map(formatAddress)
    : [];
  // Replying to your own message answers its original recipients.
  if (!to.length)
    to.push(
      ...addressList(original.to)
        .filter((a) => !same(a.address, me))
        .map(formatAddress),
    );
  if (!to.length) throw new ConnectorError('invalid_input', 'The message has no one to reply to.');
  const cc = [...others, ...(options.cc ?? [])];
  const previous = Array.isArray(original.references)
    ? original.references
    : original.references
      ? [original.references]
      : [];
  const references = [...previous, ...(original.messageId ? [original.messageId] : [])];
  return {
    to,
    ...(cc.length ? { cc } : {}),
    subject: reSubject('Re', original.subject),
    text: options.body,
    ...(original.messageId ? { inReplyTo: original.messageId } : {}),
    ...(references.length ? { references } : {}),
  };
}

/** A forward that carries the original message (with all its attachments) as an .eml attachment. */
export function buildForward(
  raw: Buffer,
  subject: string | undefined,
  options: { to: string[]; body: string },
): Mail.Options {
  return {
    to: options.to,
    subject: reSubject('Fwd', subject),
    text: options.body,
    attachments: [
      {
        filename: `${(subject || 'message').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.eml`,
        content: raw,
        contentType: 'message/rfc822',
        contentDisposition: 'attachment',
      },
    ],
  };
}

/** Builds the raw RFC 5322 message once, so the very same bytes are sent and saved. */
export function composeMessage(mail: Mail.Options): Promise<Buffer> {
  return new MailComposer(mail).compile().build();
}

/** Bare addresses of all recipients (To, Cc, Bcc) for the SMTP envelope. */
export function envelopeRecipients(mail: Mail.Options): string[] {
  return [mail.to, mail.cc, mail.bcc]
    .flatMap((list) => (Array.isArray(list) ? list : list ? [list] : []))
    .flatMap((a) => (typeof a === 'string' ? addressparser(a, { flatten: true }) : [a]))
    .flatMap((a) => ('address' in a && a.address ? [a.address] : []));
}
