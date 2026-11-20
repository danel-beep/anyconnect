/**
 * Files as tool inputs, shared by every tool that sends or attaches a file (messengers today, mail
 * next). The AI gives a file one of three ways:
 *
 * - `file_url`: a public https link;
 * - `file_id`: a file the hub keeps, returned by another tool (e.g. `get_attachment` of any
 *   messenger account), so a photo goes from one chat or service to another without the AI
 *   carrying its bytes;
 * - `file_base64`: the bytes themselves, for small files the AI made or read (Claude Code, scripts).
 *
 * Bytes are put into the hub's file store (`ctx.files`) at once, so what travels further (the
 * outbox, a pending confirmation) is only an id. Part of the connector SDK: no application imports.
 */
import { z } from 'zod';
import { fileNameFromUrl } from './messaging-http.js';
import { ConnectorError, type HubFileInfo, type HubFiles, requireFiles } from './sdk.js';

/** Base64 the AI may pass inline (about 7 MB of file; the request body limit is usually lower). */
const MAX_BASE64_CHARS = 10_000_000;

/** Input fields of a tool that takes one file. Spread into the tool's `z.object({...})`. */
export const fileInputFields = {
  file_url: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional()
    .describe('https link to a file'),
  file_id: z.string().max(64).optional().describe('file_id from get_attachment (any account)'),
  file_base64: z
    .string()
    .max(MAX_BASE64_CHARS)
    .optional()
    .describe('Small file as base64 (prefer file_id or file_url)'),
  file_name: z.string().trim().min(1).max(200).optional().describe('Shown file name'),
};

export type FileInput = {
  file_url?: string | undefined;
  file_id?: string | undefined;
  file_base64?: string | undefined;
  file_name?: string | undefined;
};

/** A file input, resolved: a link, or a file the hub keeps. */
export type ResolvedFile =
  | { source: 'url'; url: string; name: string; mimeType?: string }
  | { source: 'kept'; fileId: string; name: string; mimeType: string; size: number };

/** Whether the input names a file at all. */
export function hasFileInput(input: FileInput): boolean {
  return Boolean(input.file_url || input.file_id || input.file_base64);
}

/**
 * Turns the file fields of a tool call into one file (or undefined when none is given). Checks that
 * a `file_id` exists, and stores `file_base64` so only its id travels on.
 */
export async function resolveFileInput(
  input: FileInput,
  ctx: { files?: HubFiles | undefined },
): Promise<ResolvedFile | undefined> {
  const given = [input.file_url, input.file_id, input.file_base64].filter((v) => v !== undefined && v !== '');
  if (given.length === 0) return undefined;
  if (given.length > 1) {
    throw new ConnectorError('invalid_input', 'Pass one of file_url, file_id or file_base64, not several.');
  }
  if (input.file_url) {
    const name = input.file_name ?? fileNameFromUrl(input.file_url);
    const mimeType = mimeOfName(name);
    return { source: 'url', url: input.file_url, name, ...(mimeType ? { mimeType } : {}) };
  }
  const files = requireFiles(ctx);
  let kept: HubFileInfo;
  if (input.file_id) {
    kept = await files.stat(input.file_id.trim());
  } else {
    const data = decodeBase64(input.file_base64!);
    const name = input.file_name ?? 'file';
    kept = await files.put({ data, name, mimeType: contentType(data, mimeOfName(name)) });
  }
  return {
    source: 'kept',
    fileId: kept.id,
    name: input.file_name ?? kept.name,
    mimeType: kept.mimeType,
    size: kept.size,
  };
}

function decodeBase64(value: string): Uint8Array {
  // Data URLs are fine too: the part after the comma is the file.
  const body = value.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(body) || body.length === 0) {
    throw new ConnectorError('invalid_input', 'file_base64 is not valid base64.');
  }
  return new Uint8Array(Buffer.from(body, /[-_]/.test(body) ? 'base64url' : 'base64'));
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The type a file name suggests, if its extension is a common one. */
export function mimeOfName(name: string): string | undefined {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase();
  return ext ? MIME_BY_EXTENSION[ext] : undefined;
}

/**
 * Types {@link sniffMime} always recognizes: for these the bytes, not a name or a header, decide.
 * MP3 is not one (only files with ID3 tags are recognized), so a claimed MP3 is believed.
 */
const SNIFFED = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'audio/mp4',
  'audio/ogg',
]);

/**
 * The type of a file from its bytes, else the type it claims (a file name's extension, a server's
 * Content-Type). A claimed photo, video or audio type the bytes do not show is not believed: an
 * HTML error page served as "image/jpeg" would fail as a photo, so it goes as a plain file.
 */
export function contentType(data: Uint8Array, claimed?: string): string {
  const sniffed = sniffMime(data);
  if (sniffed) return sniffed;
  const type = claimed?.split(';')[0]?.trim().toLowerCase();
  return type && !SNIFFED.has(type) ? type : 'application/octet-stream';
}

/** The type of common formats by their first bytes (the AI rarely says what it passes). */
export function sniffMime(data: Uint8Array): string | undefined {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  const ascii = (offset: number, text: string) =>
    [...text].every((ch, i) => data[offset + i] === ch.charCodeAt(0));
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, '%PDF')) return 'application/pdf';
  if (ascii(4, 'ftyp')) return ascii(8, 'M4A') ? 'audio/mp4' : 'video/mp4';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (ascii(0, 'ID3')) return 'audio/mpeg';
  return undefined;
}

/**
 * The file fields of tool arguments as a person reads them where they approve a call (confirmation
 * page, Telegram, API): `file_base64` becomes its type and size instead of a wall of characters,
 * and `file_id` the kept file's name, type and size, so the person sees what will be sent. Other
 * arguments are returned as they are. Locale-neutral on purpose: the values sit in pages of both
 * languages.
 */
export async function describeFileArguments(
  args: Record<string, unknown>,
  files?: Pick<HubFiles, 'stat'>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...args };
  const inline = args.file_base64;
  if (typeof inline === 'string' && inline !== '') {
    let data: Uint8Array | undefined;
    try {
      data = decodeBase64(inline);
    } catch {
      data = undefined;
    }
    out.file_base64 = data
      ? fileSummary(sniffMime(data) ?? mimeOfName(String(args.file_name ?? '')), data.byteLength)
      : 'not valid base64';
  }
  const id = args.file_id;
  if (typeof id === 'string' && id !== '') {
    const kept = await files?.stat(id.trim()).catch(() => undefined);
    out.file_id = kept ? `${kept.name} · ${fileSummary(kept.mimeType, kept.size)}` : `${id} (not kept)`;
  }
  return out;
}

function fileSummary(mimeType: string | undefined, bytes: number): string {
  const size =
    bytes >= 1_048_576
      ? `${(bytes / 1_048_576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return mimeType ? `${mimeType} · ${size}` : size;
}
