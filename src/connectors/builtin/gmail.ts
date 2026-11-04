import type Mail from 'nodemailer/lib/mailer/index.js';
import { z } from 'zod';
import { HttpClient } from '../http/client.js';
import { type AccountContext, ConnectorError, defineConnector, requireOAuth } from '../sdk.js';
import { mailRead, mailSearch, mailSend, quoted } from './email/capability.js';
import {
  Addresses,
  buildForward,
  buildReply,
  composeMessage,
  isoDate,
  parseRaw,
  ReadOptions,
  readResult,
  threadingHeaders,
} from './email/message.js';
import { mapLimit } from './shared/concurrency.js';

/**
 * Gmail API over OAuth (Google). Search uses Gmail's own query syntax, results come with snippets
 * from one metadata request per message (run in parallel), full messages are parsed from the raw
 * source with the same code as IMAP mail.
 */

type Ctx = AccountContext<Record<string, never>, Record<string, never>>;

const api = (ctx: Ctx) => {
  requireOAuth(ctx);
  return new HttpClient(ctx, {
    baseUrl: 'https://gmail.googleapis.com/gmail/v1/users/me',
    errorMessagePaths: ['error.message'],
  });
};

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  raw?: string;
  payload?: {
    headers?: GmailHeader[];
    parts?: { filename?: string; parts?: unknown[] }[];
    filename?: string;
  };
}

const header = (message: GmailMessage, name: string) =>
  message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };
/** Gmail snippets are HTML-escaped. */
const unescapeSnippet = (snippet: string | undefined) =>
  (snippet ?? '').replace(/&(amp|lt|gt|quot|#39|apos);/g, (_m, e: string) => ENTITIES[e] ?? _m).trim();

function hasAttachments(message: GmailMessage): boolean {
  const visit = (parts: { filename?: string; parts?: unknown[] }[] | undefined): boolean =>
    (parts ?? []).some((p) => Boolean(p.filename) || visit(p.parts as never));
  return visit(message.payload?.parts);
}

const SUMMARY_HEADERS = ['From', 'To', 'Subject', 'Date'];

function summary(message: GmailMessage) {
  const to = header(message, 'To');
  const date = isoDate(message.internalDate ? Number(message.internalDate) : header(message, 'Date'));
  const labels = message.labelIds ?? [];
  return {
    id: message.id,
    threadId: message.threadId,
    ...(date ? { date } : {}),
    from: header(message, 'From') ?? '',
    ...(to ? { to } : {}),
    subject: header(message, 'Subject') || '(no subject)',
    snippet: unescapeSnippet(message.snippet),
    ...(labels.includes('UNREAD') ? { unread: true } : {}),
    ...(labels.includes('STARRED') ? { starred: true } : {}),
    ...(hasAttachments(message) ? { attachments: true } : {}),
  };
}

async function getRaw(ctx: Ctx, id: string): Promise<{ message: GmailMessage; raw: Buffer }> {
  const { data } = await api(ctx).get<GmailMessage>(`messages/${encodeURIComponent(id)}`, { format: 'raw' });
  if (!data.raw) throw new ConnectorError('not_found', `Message ${id} has no content`);
  return { message: data, raw: Buffer.from(data.raw, 'base64url') };
}

async function sendMessage(ctx: Ctx, mail: Mail.Options, threadId?: string) {
  const raw = await composeMessage(mail);
  const { data } = await api(ctx).post<GmailMessage>('messages/send', {
    raw: raw.toString('base64url'),
    ...(threadId ? { threadId } : {}),
  });
  return { sent: true, id: data.id, threadId: data.threadId };
}

// Label names → ids, cached per account (system labels keep their names as ids).
const labelCache = new Map<string, { at: number; labels: { id: string; name: string; type: string }[] }>();

async function labels(ctx: Ctx, fresh = false) {
  const cached = labelCache.get(ctx.account.id);
  if (!fresh && cached && Date.now() - cached.at < 5 * 60_000) return cached.labels;
  const { data } = await api(ctx).get<{ labels: { id: string; name: string; type: string }[] }>('labels');
  labelCache.set(ctx.account.id, { at: Date.now(), labels: data.labels });
  return data.labels;
}

async function labelIds(ctx: Ctx, names: string[]): Promise<string[]> {
  if (!names.length) return [];
  const all = await labels(ctx);
  return names.map((name) => {
    const found = all.find((l) => l.id === name || l.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new ConnectorError('invalid_input', `Unknown label "${name}". Use gmail_list_labels.`);
    return found.id;
  });
}

const MessageId = z.string().trim().min(1).max(100).describe('Message id from gmail_search');

export default defineConnector({
  id: 'gmail',
  name: 'Gmail',
  description:
    'Gmail over the Google API: search with Gmail syntax, read, send, reply, forward, label, archive, drafts.',
  version: '1.0.0',
  homepage: 'https://developers.google.com/workspace/gmail/api',
  instructions:
    'gmail_search takes Gmail search syntax: from:, to:, subject:, is:unread, has:attachment, newer_than:7d, label:, in:anywhere.',
  oauth: { provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
  async test(ctx) {
    const { data } = await api(ctx).get<{ emailAddress: string; messagesTotal?: number }>('profile');
    return { ok: true, identity: data.emailAddress };
  },
  actions: (action) => [
    action({
      name: 'search',
      title: 'Search mail',
      description: 'Finds messages, newest first, with sender, subject and snippet. Default: inbox.',
      input: z.object({
        query: z
          .string()
          .trim()
          .max(1000)
          .default('in:inbox')
          .describe('Gmail search, e.g. "from:bank is:unread"'),
        limit: z.number().int().min(1).max(50).default(15),
        cursor: z.string().max(200).optional().describe('nextCursor from the previous page'),
      }),
      hints: { readOnly: true, idempotent: true },
      capability: mailSearch((input) => ({
        query: [
          input.query,
          input.from && `from:${quoted(input.from)}`,
          input.to && `to:${quoted(input.to)}`,
          input.since && `after:${Math.floor(Date.parse(input.since) / 1000)}`,
          input.until && `before:${Math.ceil(Date.parse(input.until) / 1000)}`,
          input.unread_only && 'is:unread',
          input.folder && `in:${quoted(input.folder)}`,
        ]
          .filter(Boolean)
          .join(' '),
        limit: input.limit,
      })),
      run: async ({ query, limit, cursor }, ctx) => {
        const client = api(ctx);
        const { data } = await client.get<{
          messages?: { id: string }[];
          nextPageToken?: string;
          resultSizeEstimate?: number;
        }>('messages', { q: query, maxResults: limit, ...(cursor ? { pageToken: cursor } : {}) });
        const ids = (data.messages ?? []).map((m) => m.id);
        const messages = await mapLimit(ids, 10, async (id) => {
          const { data: message } = await client.get<GmailMessage>(`messages/${id}`, {
            format: 'metadata',
            metadataHeaders: SUMMARY_HEADERS,
          });
          return summary(message);
        });
        return {
          ...(data.resultSizeEstimate !== undefined ? { estimatedTotal: data.resultSizeEstimate } : {}),
          messages,
          ...(data.nextPageToken ? { nextCursor: data.nextPageToken } : {}),
        };
      },
    }),
    action({
      name: 'read',
      title: 'Read message',
      description:
        'Returns a message as plain text (quoted history removed by default) with the attachment list.',
      input: z.object({ id: MessageId, ...ReadOptions }),
      hints: { readOnly: true, idempotent: true },
      capability: mailRead,
      run: async ({ id, maxChars, includeQuoted }, ctx) => {
        const { message, raw } = await getRaw(ctx, id);
        const parsed = await parseRaw(raw);
        const labels = message.labelIds ?? [];
        return readResult(parsed, {
          id,
          maxChars,
          includeQuoted,
          unread: labels.includes('UNREAD'),
          extra: { threadId: message.threadId, labels },
        });
      },
    }),
    action({
      name: 'send',
      title: 'Send email',
      description: 'Sends a new email. The body is plain text.',
      input: z.object({
        to: Addresses.min(1),
        cc: Addresses.optional(),
        bcc: Addresses.optional(),
        subject: z.string().trim().max(998).default('').describe('Default for replies: Re: original subject'),
        body: z.string().max(200_000),
        replyToId: MessageId.optional().describe('Send as a reply in the thread of this message'),
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      capability: mailSend,
      run: async ({ to, cc, bcc, subject, body, replyToId }, ctx) => {
        if (!replyToId) return sendMessage(ctx, { to, cc, bcc, subject, text: body });
        const { message, raw } = await getRaw(ctx, replyToId);
        const threading = threadingHeaders(await parseRaw(raw));
        const mail = { ...threading, to, cc, bcc, ...(subject ? { subject } : {}), text: body };
        return sendMessage(ctx, mail, message.threadId);
      },
    }),
    action({
      name: 'reply',
      title: 'Reply',
      description: 'Replies in the same thread. replyAll also copies the other recipients.',
      input: z.object({
        id: MessageId,
        body: z.string().max(200_000).describe('Plain-text reply, without the quoted original'),
        replyAll: z.boolean().default(false),
        cc: Addresses.optional(),
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ id, body, replyAll, cc }, ctx) => {
        const [{ message, raw }, me] = await Promise.all([getRaw(ctx, id), profileEmail(ctx)]);
        const reply = buildReply(await parseRaw(raw), { me, body, replyAll, cc });
        const result = await sendMessage(ctx, reply, message.threadId);
        return { ...result, to: reply.to, ...(reply.cc ? { cc: reply.cc } : {}) };
      },
    }),
    action({
      name: 'forward',
      title: 'Forward',
      description: 'Forwards a message with all attachments (as the original email) and an optional note.',
      input: z.object({ id: MessageId, to: Addresses.min(1), body: z.string().max(200_000).default('') }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ id, to, body }, ctx) => {
        const { raw } = await getRaw(ctx, id);
        const parsed = await parseRaw(raw);
        return sendMessage(ctx, buildForward(raw, parsed.subject, { to, body }));
      },
    }),
    action({
      name: 'create_draft',
      title: 'Create draft',
      description: 'Saves a draft (optionally a reply in a thread) for the user to review and send.',
      input: z.object({
        to: Addresses.default([]),
        cc: Addresses.optional(),
        subject: z.string().trim().max(998).default(''),
        body: z.string().max(200_000),
        replyToId: MessageId.optional().describe('Make the draft a reply to this message'),
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ to, cc, subject, body, replyToId }, ctx) => {
        let mail: Mail.Options = { to, cc, subject, text: body };
        let threadId: string | undefined;
        if (replyToId) {
          const [{ message, raw }, me] = await Promise.all([getRaw(ctx, replyToId), profileEmail(ctx)]);
          const reply = buildReply(await parseRaw(raw), { me, body, replyAll: false, cc });
          mail = { ...reply, ...(to.length ? { to } : {}) };
          threadId = message.threadId;
        }
        const raw = await composeMessage(mail);
        const { data } = await api(ctx).post<{ id: string; message: { id: string } }>('drafts', {
          message: { raw: raw.toString('base64url'), ...(threadId ? { threadId } : {}) },
        });
        return { draftId: data.id, messageId: data.message.id };
      },
    }),
    action({
      name: 'modify',
      title: 'Label / archive / mark',
      description:
        'Changes messages: mark read/unread, star, archive (remove from inbox), add or remove labels by name.',
      input: z.object({
        ids: z.array(MessageId).min(1).max(500),
        read: z.boolean().optional(),
        starred: z.boolean().optional(),
        archive: z.boolean().optional().describe('true removes from inbox, false moves back to inbox'),
        addLabels: z.array(z.string().max(200)).max(20).default([]),
        removeLabels: z.array(z.string().max(200)).max(20).default([]),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      run: async ({ ids, read, starred, archive, addLabels, removeLabels }, ctx) => {
        const add = await labelIds(ctx, addLabels);
        const remove = await labelIds(ctx, removeLabels);
        if (read === true) remove.push('UNREAD');
        if (read === false) add.push('UNREAD');
        if (starred === true) add.push('STARRED');
        if (starred === false) remove.push('STARRED');
        if (archive === true) remove.push('INBOX');
        if (archive === false) add.push('INBOX');
        if (!add.length && !remove.length) throw new ConnectorError('invalid_input', 'Nothing to change.');
        await api(ctx).post('messages/batchModify', { ids, addLabelIds: add, removeLabelIds: remove });
        return { updated: ids.length };
      },
    }),
    action({
      name: 'trash',
      title: 'Move to trash',
      description: 'Moves messages to Trash (Gmail deletes them after 30 days; restore with untrash).',
      input: z.object({ ids: z.array(MessageId).min(1).max(100), untrash: z.boolean().default(false) }),
      hints: { readOnly: false, destructive: true, idempotent: true },
      // Restorable for 30 days with untrash.
      risk: 'write',
      undo: { kind: 'action', action: 'trash', note: 'Call again with untrash: true' },
      run: async ({ ids, untrash }, ctx) => {
        const client = api(ctx);
        await mapLimit(ids, 5, (id) => client.post(`messages/${id}/${untrash ? 'untrash' : 'trash'}`));
        return { [untrash ? 'restored' : 'trashed']: ids.length };
      },
    }),
    action({
      name: 'list_labels',
      title: 'List labels',
      description: 'Lists Gmail labels (system and user) with unread counts for user labels.',
      input: z.object({}),
      hints: { readOnly: true, idempotent: true },
      run: async (_input, ctx) => ({
        labels: (await labels(ctx, true)).map((l) => ({
          name: l.name,
          ...(l.type === 'system' ? { system: true } : {}),
        })),
      }),
    }),
  ],
});

const profileCache = new Map<string, string>();

/** The mailbox address, needed to leave yourself out of reply recipients. */
async function profileEmail(ctx: Ctx): Promise<string> {
  const cached = profileCache.get(ctx.account.id) ?? ctx.account.identity;
  if (cached) return cached;
  const { data } = await api(ctx).get<{ emailAddress: string }>('profile');
  profileCache.set(ctx.account.id, data.emailAddress);
  return data.emailAddress;
}
