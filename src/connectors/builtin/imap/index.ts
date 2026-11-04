import net from 'node:net';
import type { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { z } from 'zod';
import { type AccountContext, ConnectorError, defineConnector } from '../../sdk.js';
import { type ImapLogin, ImapPool, type ResolveHost, toConnectorError } from './connection.js';
import {
  decodeId,
  encodeId,
  FOLDER_ROLES,
  fetchMessage,
  fetchRaw,
  formatAddress,
  groupIds,
  resolveFolder,
  roleOf,
  searchFolder,
  stripQuotedTail,
  toSearchObject,
} from './mailbox.js';
import { guessProvider, PROVIDER_IDS, PROVIDERS, type Security, type ServerSettings } from './presets.js';
import { composeMessage, sendRaw } from './smtp.js';

const security = z.enum(['tls', 'starttls']);

const Config = z
  .object({
    email: z.email().describe('Mailbox address, e.g. me@yandex.ru'),
    provider: z
      .enum(PROVIDER_IDS)
      .optional()
      .describe('Mail provider; guessed from the address when empty. "custom" requires the server fields'),
    fromName: z.string().trim().max(100).optional().describe('Sender name shown to recipients'),
    username: z.string().trim().max(200).optional().describe('Login, if it differs from the address'),
    imapHost: z.string().trim().max(253).optional().describe('IMAP server (overrides the provider)'),
    imapPort: z.number().int().min(1).max(65535).optional(),
    imapSecurity: security.optional().describe('tls (port 993) or starttls (port 143)'),
    smtpHost: z.string().trim().max(253).optional().describe('SMTP server (overrides the provider)'),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpSecurity: security.optional().describe('tls (port 465) or starttls (port 587)'),
    allowInvalidCertificate: z
      .boolean()
      .default(false)
      .describe('Accept a self-signed server certificate (self-hosted servers, Proton Mail Bridge only)'),
    saveSentCopy: z
      .boolean()
      .optional()
      .describe('Save a copy of sent mail to the Sent folder; the default depends on the provider'),
  })
  .superRefine((config, ctx) => {
    const provider = config.provider ?? guessProvider(config.email);
    if (provider !== 'custom') return;
    if (!config.imapHost)
      ctx.addIssue({ code: 'custom', path: ['imapHost'], message: 'required for a custom provider' });
    if (!config.smtpHost)
      ctx.addIssue({ code: 'custom', path: ['smtpHost'], message: 'required for a custom provider' });
  });

const Credentials = z.object({
  password: z
    .string()
    .min(1)
    .describe('App password of the mailbox (or the regular password if the provider allows it)'),
  smtpPassword: z.string().min(1).optional().describe('Only if SMTP uses a different password'),
});

type ConfigT = z.output<typeof Config>;
type CredentialsT = z.output<typeof Credentials>;
type Ctx = AccountContext<ConfigT, CredentialsT>;

interface ResolvedSettings {
  imap: ServerSettings;
  smtp: ServerSettings;
  saveSentCopy: boolean;
}

export function resolveSettings(config: ConfigT): ResolvedSettings {
  const provider = config.provider ?? guessProvider(config.email);
  const preset = provider === 'custom' ? undefined : PROVIDERS[provider];
  const server = (
    host: string | undefined,
    port: number | undefined,
    sec: Security | undefined,
    fallback: ServerSettings | undefined,
    defaults: { tls: number; starttls: number },
  ): ServerSettings => {
    const chosen = sec ?? fallback?.security ?? 'tls';
    return {
      host: host ?? fallback?.host ?? '',
      port: port ?? (host ? defaults[chosen] : fallback?.port) ?? defaults[chosen],
      security: chosen,
    };
  };
  return {
    imap: server(config.imapHost, config.imapPort, config.imapSecurity, preset?.imap, {
      tls: 993,
      starttls: 143,
    }),
    smtp: server(config.smtpHost, config.smtpPort, config.smtpSecurity, preset?.smtp, {
      tls: 465,
      starttls: 587,
    }),
    saveSentCopy: config.saveSentCopy ?? !(preset?.savesSentCopy ?? false),
  };
}

/**
 * Resolves the configured server under the hub's network policy (no private addresses in the
 * cloud). The connector then connects to the returned address, so the check cannot be bypassed by
 * DNS rebinding; the hostname is still used for TLS verification.
 */
function hostResolver(ctx: Ctx): ResolveHost {
  return (hostname) => {
    if (net.isIP(hostname.replace(/^\[|\]$/g, ''))) {
      ctx.network.assertHostAllowed(hostname);
      return Promise.resolve(hostname);
    }
    return new Promise((resolve, reject) =>
      ctx.network.lookup(hostname, { all: true }, (error, addresses) => {
        if (error) return reject(error);
        const first = Array.isArray(addresses) ? addresses[0]?.address : addresses;
        if (!first) return reject(new Error(`${hostname} has no address`));
        resolve(first);
      }),
    );
  };
}

const pool = new ImapPool();

/** Closes pooled IMAP connections (used by tests and on shutdown). */
export const closeImapConnections = () => pool.closeAll();

function imapLogin(ctx: Ctx): ImapLogin {
  return {
    server: resolveSettings(ctx.config).imap,
    user: ctx.config.username || ctx.config.email,
    password: ctx.credentials.password,
    allowInvalidCertificate: ctx.config.allowInvalidCertificate,
  };
}

async function withImap<T>(ctx: Ctx, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  try {
    return await pool.use(ctx.account.id, imapLogin(ctx), hostResolver(ctx), fn);
  } catch (error) {
    throw toConnectorError(error, 'IMAP');
  }
}

const sender = (ctx: Ctx) =>
  ctx.config.fromName ? { name: ctx.config.fromName, address: ctx.config.email } : ctx.config.email;

/** Sends a composed message over SMTP and, if the provider does not do it itself, saves it to Sent. */
async function deliver(ctx: Ctx, mail: Mail.Options): Promise<Record<string, unknown>> {
  const settings = resolveSettings(ctx.config);
  const raw = await composeMessage({ ...mail, from: sender(ctx) });
  const recipients = [mail.to, mail.cc, mail.bcc]
    .flatMap((list) => (Array.isArray(list) ? list : list ? [list] : []))
    .flatMap((a) => (typeof a === 'string' ? addressparser(a, { flatten: true }) : [a]))
    .flatMap((a) => ('address' in a && a.address ? [a.address] : []));
  const envelope = { from: ctx.config.email, to: recipients };
  const result = await sendRaw(
    {
      server: settings.smtp,
      user: ctx.config.username || ctx.config.email,
      password: ctx.credentials.smtpPassword ?? ctx.credentials.password,
      allowInvalidCertificate: ctx.config.allowInvalidCertificate,
    },
    hostResolver(ctx),
    envelope,
    raw,
  );
  let savedTo: string | undefined;
  if (settings.saveSentCopy) {
    savedTo = await withImap(ctx, async (client) => {
      const sent = await resolveFolder(client, 'sent').catch(() => undefined);
      if (!sent) return undefined;
      await client.append(sent, raw, ['\\Seen']);
      return sent;
    }).catch((error) => {
      ctx.logger.warn({ err: (error as Error).message }, 'could not save the sent copy');
      return undefined;
    });
  }
  return {
    sent: true,
    ...(result.messageId ? { messageId: result.messageId } : {}),
    accepted: result.accepted,
    ...(result.rejected.length ? { rejected: result.rejected } : {}),
    ...(savedTo ? { savedTo } : {}),
  };
}

const MessageId = z.string().min(3).max(500).describe('Message id from imap_search, e.g. "INBOX:4521"');
const Addresses = z
  .array(z.string().trim().min(3).max(320))
  .max(50)
  .describe('Addresses: "a@b.com" or "Name <a@b.com>"');
const Folder = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe(`Folder role (${FOLDER_ROLES.join(', ')}) or a folder path from imap_list_folders`);

const reSubject = (prefix: 'Re' | 'Fwd', subject: string | undefined) => {
  const s = subject?.trim() || '';
  return new RegExp(`^${prefix}:`, 'i').test(s) ? s : `${prefix}: ${s}`.trim();
};

const sameAddress = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

export default defineConnector({
  id: 'imap',
  name: 'Email (IMAP/SMTP)',
  description:
    'Any mailbox over IMAP/SMTP: Gmail, Yandex, Mail.ru, iCloud, Outlook, Fastmail, corporate mail. Search, read, send, reply, forward, move and flag messages.',
  version: '1.0.0',
  homepage: 'https://datatracker.ietf.org/doc/html/rfc9051',
  instructions:
    'Message ids look like "INBOX:4521" (folder:uid). imap_search returns newest first with a short snippet; call imap_read only for messages you need in full. Folders accept roles: inbox, sent, drafts, trash, junk, archive, all. To delete, move to "trash".',
  config: Config,
  credentials: Credentials,
  async test(ctx) {
    const status = await withImap(ctx, async (client) => client.status('INBOX', { messages: true }));
    const count = status ? (status.messages ?? 0) : 0;
    return { ok: true, identity: ctx.config.email, message: `INBOX: ${count} messages` };
  },
  actions: (action) => [
    action({
      name: 'list_folders',
      title: 'List folders',
      description: 'Lists mail folders with their role (inbox, sent, trash, ...) and message/unread counts.',
      input: z.object({}),
      hints: { readOnly: true, idempotent: true },
      run: (_input, ctx) =>
        withImap(ctx, async (client) => {
          const folders = await client.list({ statusQuery: { messages: true, unseen: true } });
          return {
            folders: folders
              .filter((f) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'))
              .map((f) => {
                const role = roleOf(f);
                return {
                  path: f.path,
                  ...(role ? { role } : {}),
                  ...(f.status?.messages !== undefined ? { messages: f.status.messages } : {}),
                  ...(f.status?.unseen ? { unread: f.status.unseen } : {}),
                };
              }),
          };
        }),
    }),
    action({
      name: 'search',
      title: 'Search mail',
      description:
        'Finds messages in one folder, newest first. Returns id, date, from, subject, snippet, unread flag. Combine filters; all are optional.',
      input: z.object({
        folder: Folder.default('inbox'),
        query: z
          .string()
          .trim()
          .max(500)
          .optional()
          .describe('Text in subject, body or addresses. On Gmail, full Gmail search syntax works'),
        from: z.string().trim().max(320).optional().describe('Sender address or name contains'),
        to: z.string().trim().max(320).optional().describe('Recipient address or name contains'),
        subject: z.string().trim().max(500).optional().describe('Subject contains'),
        since: z.iso.date().optional().describe('Received on or after (YYYY-MM-DD)'),
        before: z.iso.date().optional().describe('Received before (YYYY-MM-DD)'),
        unread: z.boolean().optional().describe('true: only unread; false: only read'),
        flagged: z.boolean().optional().describe('true: only starred/flagged'),
        limit: z.number().int().min(1).max(50).default(15),
        cursor: z.string().max(20).optional().describe('nextCursor from the previous page'),
      }),
      hints: { readOnly: true, idempotent: true },
      run: ({ folder, limit, cursor, ...filters }, ctx) =>
        withImap(ctx, async (client) => {
          const path = await resolveFolder(client, folder);
          const gmail = client.capabilities.has('X-GM-EXT-1');
          return searchFolder(client, path, toSearchObject(filters, gmail), {
            limit,
            cursor,
            snippets: true,
          });
        }),
    }),
    action({
      name: 'read',
      title: 'Read message',
      description:
        'Returns one message as plain text (HTML converted, quoted history removed by default) with headers and the attachment list.',
      input: z.object({
        id: MessageId,
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(100_000)
          .default(6000)
          .describe('Cut the body after this many characters'),
        includeQuoted: z.boolean().default(false).describe('Keep the quoted previous messages at the end'),
        markRead: z.boolean().default(false).describe('Also mark the message as read'),
      }),
      hints: { readOnly: true, idempotent: true },
      run: ({ id, maxChars, includeQuoted, markRead }, ctx) =>
        withImap(ctx, async (client) => {
          const { folder, uid } = decodeId(id);
          const { parsed, flags } = await fetchMessage(client, folder, uid);
          let text = (parsed.text ?? '').trim();
          let quotedRemoved = false;
          if (!includeQuoted) ({ text, removed: quotedRemoved } = stripQuotedTail(text));
          const totalChars = text.length;
          const truncated = totalChars > maxChars;
          if (truncated) text = `${text.slice(0, maxChars)}…`;
          if (markRead && !flags.has('\\Seen')) {
            const lock = await client.getMailboxLock(folder);
            try {
              await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            } finally {
              lock.release();
            }
          }
          const list = (value: typeof parsed.to) =>
            (Array.isArray(value) ? value : value ? [value] : [])
              .flatMap((group) => group.value)
              .map(formatAddress);
          const to = list(parsed.to);
          const cc = list(parsed.cc);
          const replyTo = list(parsed.replyTo);
          return {
            id,
            ...(parsed.date ? { date: parsed.date.toISOString().replace(/\.\d{3}Z$/, 'Z') } : {}),
            from: list(parsed.from)[0] ?? '',
            ...(to.length ? { to } : {}),
            ...(cc.length ? { cc } : {}),
            ...(replyTo.length && replyTo[0] !== list(parsed.from)[0] ? { replyTo } : {}),
            subject: parsed.subject ?? '(no subject)',
            ...(flags.has('\\Seen') || markRead ? {} : { unread: true }),
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
        }),
    }),
    action({
      name: 'send',
      title: 'Send email',
      description: 'Sends a new email from this mailbox. The body is plain text.',
      input: z.object({
        to: Addresses.min(1),
        cc: Addresses.optional(),
        bcc: Addresses.optional(),
        subject: z.string().trim().max(998),
        body: z.string().max(200_000).describe('Plain-text body'),
      }),
      hints: { readOnly: false, destructive: false, idempotent: false },
      run: ({ to, cc, bcc, subject, body }, ctx) => deliver(ctx, { to, cc, bcc, subject, text: body }),
    }),
    action({
      name: 'reply',
      title: 'Reply',
      description:
        'Replies to a message in the same thread (sets Re:, In-Reply-To and References). replyAll also copies the other recipients.',
      input: z.object({
        id: MessageId,
        body: z.string().max(200_000).describe('Plain-text reply, without the quoted original'),
        replyAll: z.boolean().default(false),
        cc: Addresses.optional().describe('Extra recipients in copy'),
      }),
      hints: { readOnly: false, destructive: false, idempotent: false },
      run: async ({ id, body, replyAll, cc }, ctx) => {
        const { folder, uid } = decodeId(id);
        const original = await withImap(ctx, (client) => fetchMessage(client, folder, uid));
        const p = original.parsed;
        const addresses = (value: typeof p.to) =>
          (Array.isArray(value) ? value : value ? [value] : [])
            .flatMap((g) => g.value)
            .filter((a) => a.address);
        const me = ctx.config.email;
        const primary = addresses(p.replyTo).length ? addresses(p.replyTo) : addresses(p.from);
        const to = primary.filter((a) => !sameAddress(a.address, me)).map(formatAddress);
        const others = replyAll
          ? [...addresses(p.to), ...addresses(p.cc)]
              .filter(
                (a) =>
                  !sameAddress(a.address, me) && !primary.some((x) => sameAddress(x.address, a.address!)),
              )
              .map(formatAddress)
          : [];
        const ccList = [...others, ...(cc ?? [])];
        if (!to.length) {
          // Replying to own message: answer the original recipients.
          to.push(
            ...addresses(p.to)
              .filter((a) => !sameAddress(a.address, me))
              .map(formatAddress),
          );
        }
        if (!to.length) throw new ConnectorError('invalid_input', 'The message has no one to reply to.');
        const references = [
          ...(Array.isArray(p.references) ? p.references : p.references ? [p.references] : []),
          ...(p.messageId ? [p.messageId] : []),
        ];
        const result = await deliver(ctx, {
          to,
          ...(ccList.length ? { cc: ccList } : {}),
          subject: reSubject('Re', p.subject),
          text: body,
          ...(p.messageId ? { inReplyTo: p.messageId } : {}),
          ...(references.length ? { references } : {}),
        });
        await withImap(ctx, async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            await client.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true });
          } finally {
            lock.release();
          }
        }).catch(() => {});
        return { ...result, to, ...(ccList.length ? { cc: ccList } : {}) };
      },
    }),
    action({
      name: 'forward',
      title: 'Forward',
      description:
        'Forwards a message with all its attachments (attached as the original email) and an optional note.',
      input: z.object({
        id: MessageId,
        to: Addresses.min(1),
        body: z.string().max(200_000).default('').describe('Note above the forwarded message'),
      }),
      hints: { readOnly: false, destructive: false, idempotent: false },
      run: async ({ id, to, body }, ctx) => {
        const { folder, uid } = decodeId(id);
        const raw = await withImap(ctx, (client) => fetchRaw(client, folder, uid));
        const parsed = await simpleParser(raw, {
          skipHtmlToText: true,
          skipTextToHtml: true,
          skipImageLinks: true,
        });
        return deliver(ctx, {
          to,
          subject: reSubject('Fwd', parsed.subject),
          text: body,
          attachments: [
            {
              filename: `${(parsed.subject || 'message').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.eml`,
              content: raw,
              contentType: 'message/rfc822',
              contentDisposition: 'attachment',
            },
          ],
        });
      },
    }),
    action({
      name: 'move',
      title: 'Move messages',
      description: 'Moves messages to another folder: archive, trash (delete), junk or any folder path.',
      input: z.object({
        ids: z.array(MessageId).min(1).max(200),
        to: Folder,
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      run: ({ ids, to }, ctx) =>
        withImap(ctx, async (client) => {
          const destination = await resolveFolder(client, to);
          const moved: Record<string, string> = {};
          for (const [folder, uids] of groupIds(ids)) {
            if (folder === destination) continue;
            const lock = await client.getMailboxLock(folder);
            try {
              const result = (await client.messageMove(uids, destination, { uid: true })) || undefined;
              if (result?.uidMap) {
                for (const [from, next] of result.uidMap)
                  moved[encodeId(folder, from)] = encodeId(destination, next);
              }
            } finally {
              lock.release();
            }
          }
          return {
            moved: ids.length,
            to: destination,
            ...(Object.keys(moved).length ? { newIds: moved } : {}),
          };
        }),
    }),
    action({
      name: 'mark',
      title: 'Mark messages',
      description: 'Marks messages as read/unread and/or flagged (starred)/unflagged.',
      input: z.object({
        ids: z.array(MessageId).min(1).max(500),
        read: z.boolean().optional(),
        flagged: z.boolean().optional(),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      run: ({ ids, read, flagged }, ctx) => {
        if (read === undefined && flagged === undefined) {
          throw new ConnectorError('invalid_input', 'Pass "read" and/or "flagged".');
        }
        return withImap(ctx, async (client) => {
          for (const [folder, uids] of groupIds(ids)) {
            const lock = await client.getMailboxLock(folder);
            try {
              const apply = async (flag: string, on: boolean | undefined) => {
                if (on === undefined) return;
                if (on) await client.messageFlagsAdd(uids, [flag], { uid: true });
                else await client.messageFlagsRemove(uids, [flag], { uid: true });
              };
              await apply('\\Seen', read);
              await apply('\\Flagged', flagged);
            } finally {
              lock.release();
            }
          }
          return { updated: ids.length };
        });
      },
    }),
  ],
});
