import type {
  FetchMessageObject,
  ImapFlow,
  ListResponse,
  MessageAddressObject,
  SearchObject,
} from 'imapflow';
import { type ParsedMail, simpleParser } from 'mailparser';
import { ConnectorError } from '../../sdk.js';
import {
  decodePart,
  findTextPart,
  htmlToPreviewText,
  listAttachments,
  type StructureNode,
  toSnippet,
} from './mime.js';

/** Folder roles the AI can use instead of provider-specific names ("Sent Items", "Отправленные"). */
export const FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'all'] as const;
export type FolderRole = (typeof FOLDER_ROLES)[number];

const SPECIAL_USE: Record<Exclude<FolderRole, 'inbox'>, string> = {
  sent: '\\Sent',
  drafts: '\\Drafts',
  trash: '\\Trash',
  junk: '\\Junk',
  archive: '\\Archive',
  all: '\\All',
};

/** Fallback when the server does not announce SPECIAL-USE (lower-cased last path segment). */
const ROLE_NAMES: Record<Exclude<FolderRole, 'inbox' | 'all'>, string[]> = {
  sent: ['sent', 'sent items', 'sent mail', 'sent messages', 'отправленные'],
  drafts: ['drafts', 'draft', 'черновики'],
  trash: [
    'trash',
    'deleted',
    'deleted items',
    'deleted messages',
    'bin',
    'корзина',
    'удаленные',
    'удалённые',
  ],
  junk: ['junk', 'spam', 'junk e-mail', 'junk email', 'спам'],
  archive: ['archive', 'archives', 'архив'],
};

const FOLDER_CACHE_MS = 5 * 60_000;
const folderCache = new WeakMap<ImapFlow, { at: number; folders: ListResponse[] }>();

export async function listFolders(client: ImapFlow, fresh = false): Promise<ListResponse[]> {
  const cached = folderCache.get(client);
  if (!fresh && cached && Date.now() - cached.at < FOLDER_CACHE_MS) return cached.folders;
  const folders = await client.list();
  folderCache.set(client, { at: Date.now(), folders });
  return folders;
}

export function roleOf(folder: ListResponse): FolderRole | undefined {
  if (folder.path.toUpperCase() === 'INBOX') return 'inbox';
  for (const [role, flag] of Object.entries(SPECIAL_USE)) {
    if (folder.specialUse === flag) return role as FolderRole;
  }
  return undefined;
}

/** Resolves a role ("sent") or a folder path ("Projects/2026") to an existing folder path. */
export async function resolveFolder(client: ImapFlow, folder: string): Promise<string> {
  const wanted = folder.trim();
  if (!wanted || wanted.toLowerCase() === 'inbox') return 'INBOX';
  const folders = await listFolders(client);
  const exact =
    folders.find((f) => f.path === wanted) ??
    folders.find((f) => f.path.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact.path;
  const role = wanted.toLowerCase() as FolderRole;
  if ((FOLDER_ROLES as readonly string[]).includes(role)) {
    const bySpecialUse = folders.find((f) => roleOf(f) === role);
    if (bySpecialUse) return bySpecialUse.path;
    const names = ROLE_NAMES[role as keyof typeof ROLE_NAMES] ?? [];
    const byName = folders.find((f) => names.includes(f.name.toLowerCase()));
    if (byName) return byName.path;
  }
  throw new ConnectorError(
    'not_found',
    `Folder "${folder}" not found. Use a role (${FOLDER_ROLES.join(', ')}) or a path from imap_list_folders.`,
  );
}

// Message ids are "<folder path>:<uid>", e.g. "INBOX:4521". Short for the AI, stable per folder.
export function encodeId(folder: string, uid: number): string {
  return `${folder}:${uid}`;
}

export function decodeId(id: string): { folder: string; uid: number } {
  const at = id.lastIndexOf(':');
  const uid = Number(id.slice(at + 1));
  if (at <= 0 || !Number.isInteger(uid) || uid <= 0) {
    throw new ConnectorError(
      'invalid_input',
      `"${id}" is not a message id; use ids returned by imap_search.`,
    );
  }
  return { folder: id.slice(0, at), uid };
}

/** Groups message ids by folder, keeping UIDs as numbers. */
export function groupIds(ids: string[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const id of ids) {
    const { folder, uid } = decodeId(id);
    groups.set(folder, [...(groups.get(folder) ?? []), uid]);
  }
  return groups;
}

export const formatAddress = (a: MessageAddressObject | { name?: string; address?: string }): string =>
  a.name && a.address ? `${a.name} <${a.address}>` : (a.address ?? a.name ?? '');

const formatAddresses = (list: MessageAddressObject[] | undefined, max = 5): string[] | undefined => {
  if (!list?.length) return undefined;
  const shown = list.slice(0, max).map(formatAddress);
  if (list.length > max) shown.push(`+${list.length - max} more`);
  return shown;
};

const isoDate = (value: Date | string | undefined): string | undefined => {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

export interface SearchFilters {
  query?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  since?: string | undefined;
  before?: string | undefined;
  unread?: boolean | undefined;
  flagged?: boolean | undefined;
  hasAttachments?: boolean | undefined;
}

export function toSearchObject(filters: SearchFilters, gmail: boolean): SearchObject {
  const criteria: SearchObject = {};
  if (filters.query) {
    if (gmail) criteria.gmraw = filters.query;
    else criteria.text = filters.query;
  }
  if (filters.from) criteria.from = filters.from;
  if (filters.to) criteria.to = filters.to;
  if (filters.subject) criteria.subject = filters.subject;
  if (filters.since) criteria.since = new Date(filters.since);
  if (filters.before) criteria.before = new Date(filters.before);
  if (filters.unread !== undefined) criteria.seen = !filters.unread;
  if (filters.flagged !== undefined) criteria.flagged = filters.flagged;
  if (Object.keys(criteria).length === 0) criteria.all = true;
  return criteria;
}

export interface MessageSummary {
  id: string;
  date?: string;
  from?: string;
  to?: string[];
  subject: string;
  snippet?: string;
  unread?: true;
  flagged?: true;
  attachments?: number;
}

export interface SearchPage {
  folder: string;
  total: number;
  messages: MessageSummary[];
  /** Pass back as `cursor` to get older messages. */
  nextCursor?: string;
}

const SNIPPET_BYTES = 2048;

/** Fetches the beginning of the text part of each message and turns it into a one-line preview. */
async function fetchSnippets(client: ImapFlow, messages: FetchMessageObject[]): Promise<Map<number, string>> {
  type Group = { uids: number[]; nodes: Map<number, StructureNode> };
  const byPart = new Map<string, Group>();
  for (const message of messages) {
    const node = findTextPart(message.bodyStructure as StructureNode | undefined);
    if (!node) continue;
    // A single-part message has no part number; its body is section "1".
    const key = node.part ?? '1';
    const group: Group = byPart.get(key) ?? { uids: [], nodes: new Map() };
    group.uids.push(message.uid);
    group.nodes.set(message.uid, node);
    byPart.set(key, group);
  }
  const snippets = new Map<number, string>();
  for (const [key, group] of byPart) {
    for await (const message of client.fetch(
      group.uids,
      { uid: true, bodyParts: [{ key, maxLength: SNIPPET_BYTES }] },
      { uid: true },
    )) {
      const raw = message.bodyParts?.get(key) ?? [...(message.bodyParts?.values() ?? [])][0];
      const node = group.nodes.get(message.uid);
      if (!raw || !node) continue;
      const binary = message.binaryParts?.has(key) ?? false;
      let text = decodePart(raw, binary ? undefined : node.encoding, node.parameters?.charset);
      if (node.type === 'text/html') text = htmlToPreviewText(text);
      const snippet = toSnippet(text);
      if (snippet) snippets.set(message.uid, snippet);
    }
  }
  return snippets;
}

export async function searchFolder(
  client: ImapFlow,
  folder: string,
  criteria: SearchObject,
  options: { limit: number; cursor?: string | undefined; snippets: boolean },
): Promise<SearchPage> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const found: number[] = (await client.search(criteria, { uid: true })) || [];
    const sorted = [...found].sort((a, b) => b - a);
    const before = options.cursor ? Number(options.cursor) : undefined;
    if (options.cursor && (!Number.isInteger(before) || before! <= 0)) {
      throw new ConnectorError('invalid_input', 'Invalid cursor; pass nextCursor from the previous result.');
    }
    const older = before ? sorted.filter((uid) => uid < before) : sorted;
    const pageUids = older.slice(0, options.limit);
    const fetched: FetchMessageObject[] = [];
    if (pageUids.length) {
      for await (const message of client.fetch(
        pageUids,
        { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true },
        { uid: true },
      )) {
        fetched.push(message);
      }
    }
    fetched.sort((a, b) => b.uid - a.uid);
    const snippets = options.snippets && fetched.length ? await fetchSnippets(client, fetched) : new Map();
    const messages = fetched.map((m): MessageSummary => {
      const env = m.envelope ?? {};
      const attachments = listAttachments(m.bodyStructure as StructureNode | undefined).length;
      const from = env.from?.[0];
      const to = formatAddresses(env.to, 3);
      const date = isoDate(env.date ?? m.internalDate);
      const snippet = snippets.get(m.uid);
      return {
        id: encodeId(folder, m.uid),
        ...(date ? { date } : {}),
        ...(from ? { from: formatAddress(from) } : {}),
        ...(to ? { to } : {}),
        subject: env.subject || '(no subject)',
        ...(snippet ? { snippet } : {}),
        ...(m.flags?.has('\\Seen') ? {} : { unread: true as const }),
        ...(m.flags?.has('\\Flagged') ? { flagged: true as const } : {}),
        ...(attachments ? { attachments } : {}),
      };
    });
    const last = pageUids.at(-1);
    return {
      folder,
      total: sorted.length,
      messages,
      ...(last !== undefined && older.length > pageUids.length ? { nextCursor: String(last) } : {}),
    };
  } finally {
    lock.release();
  }
}

/** Above this size only the text part is downloaded, not the whole message with attachments. */
const MAX_FULL_FETCH_BYTES = 15 * 1024 * 1024;

export interface FullMessage {
  parsed: ParsedMail;
  flags: Set<string>;
  size: number;
}

export async function fetchMessage(client: ImapFlow, folder: string, uid: number): Promise<FullMessage> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const meta =
      (await client.fetchOne(
        String(uid),
        { uid: true, size: true, flags: true, bodyStructure: true },
        { uid: true },
      )) || undefined;
    if (!meta)
      throw new ConnectorError(
        'not_found',
        `Message ${encodeId(folder, uid)} not found (it may have been moved).`,
      );
    let source: Buffer;
    if ((meta.size ?? 0) <= MAX_FULL_FETCH_BYTES) {
      const full =
        (await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true })) || undefined;
      source = full ? (full.source ?? Buffer.alloc(0)) : Buffer.alloc(0);
    } else {
      const headers =
        (await client.fetchOne(String(uid), { uid: true, headers: true }, { uid: true })) || undefined;
      const part = findTextPart(meta.bodyStructure as StructureNode | undefined);
      let body = '';
      if (part?.part) {
        const { content } = await client.download(String(uid), part.part, {
          uid: true,
          maxBytes: 1024 * 1024,
        });
        const chunks: Buffer[] = [];
        if (content) for await (const chunk of content) chunks.push(chunk as Buffer);
        body = Buffer.concat(chunks).toString('utf8');
      }
      const type = part?.type ?? 'text/plain';
      source = Buffer.concat([
        headers?.headers ?? Buffer.alloc(0),
        Buffer.from(`Content-Type: ${type}; charset=utf-8\r\n\r\n${body}`),
      ]);
    }
    const parsed = await simpleParser(source, {
      skipImageLinks: true,
      skipTextToHtml: true,
      skipTextLinks: true,
    });
    return { parsed, flags: meta.flags ?? new Set(), size: meta.size ?? source.length };
  } finally {
    lock.release();
  }
}

export async function fetchRaw(client: ImapFlow, folder: string, uid: number): Promise<Buffer> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const message =
      (await client.fetchOne(String(uid), { uid: true, source: true, size: true }, { uid: true })) ||
      undefined;
    if (!message?.source)
      throw new ConnectorError('not_found', `Message ${encodeId(folder, uid)} not found.`);
    if (message.source.length > MAX_FULL_FETCH_BYTES) {
      throw new ConnectorError('invalid_input', 'The message is too large to forward from here.');
    }
    return message.source;
  } finally {
    lock.release();
  }
}

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
