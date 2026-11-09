/**
 * Helpers for reading MIME structures without downloading whole messages: finding the text part
 * and the attachments in a BODYSTRUCTURE, and decoding a (possibly cut) body part for snippets.
 */

import { snippetText } from '../../shape.js';

export interface StructureNode {
  part?: string | undefined;
  type: string;
  parameters?: Record<string, string> | undefined;
  encoding?: string | undefined;
  size?: number | undefined;
  disposition?: string | undefined;
  dispositionParameters?: Record<string, string> | undefined;
  childNodes?: StructureNode[] | undefined;
}

export interface AttachmentInfo {
  filename: string;
  contentType: string;
  size?: number;
}

const filenameOf = (node: StructureNode): string | undefined =>
  node.dispositionParameters?.filename ?? node.parameters?.name;

function isAttachment(node: StructureNode): boolean {
  if (node.childNodes?.length) return false;
  if (node.disposition?.toLowerCase() === 'attachment') return true;
  if (node.type === 'message/rfc822') return true;
  // Inline images and other non-text parts with a name are attachments too.
  return !node.type.startsWith('text/') && Boolean(filenameOf(node));
}

/** The best part to read the message from: the first text/plain, otherwise the first text/html. */
export function findTextPart(root: StructureNode | undefined): StructureNode | undefined {
  if (!root) return undefined;
  let html: StructureNode | undefined;
  const visit = (node: StructureNode): StructureNode | undefined => {
    if (node.childNodes?.length) {
      for (const child of node.childNodes) {
        const found = visit(child);
        if (found) return found;
      }
      return undefined;
    }
    if (isAttachment(node)) return undefined;
    if (node.type === 'text/plain') return node;
    if (node.type === 'text/html' && !html) html = node;
    return undefined;
  };
  return visit(root) ?? html;
}

export function listAttachments(root: StructureNode | undefined): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  const visit = (node: StructureNode) => {
    if (node.childNodes?.length) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    if (!isAttachment(node)) return;
    out.push({
      filename: filenameOf(node) ?? (node.type === 'message/rfc822' ? 'message.eml' : 'attachment'),
      contentType: node.type,
      ...(node.size ? { size: node.size } : {}),
    });
  };
  if (root) visit(root);
  return out;
}

function decodeQuotedPrintable(input: string): Buffer {
  const bytes: number[] = [];
  const text = input.replace(/=\r?\n/g, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '=') {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
      // A cut-off escape at the end of a partial fetch.
      if (i >= text.length - 2) break;
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

/** Decodes a body part that may have been cut at an arbitrary byte (partial FETCH). */
export function decodePart(raw: Buffer, encoding: string | undefined, charset: string | undefined): string {
  let bytes: Buffer;
  switch (encoding?.toLowerCase()) {
    case 'base64': {
      const clean = raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
      bytes = Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), 'base64');
      break;
    }
    case 'quoted-printable':
      bytes = decodeQuotedPrintable(raw.toString('latin1'));
      break;
    default:
      bytes = raw;
  }
  let decoder: InstanceType<typeof TextDecoder>;
  try {
    decoder = new TextDecoder(charset || 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  // A multi-byte character cut in half at the end becomes U+FFFD; drop it.
  return decoder.decode(bytes).replace(/�+$/, '');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

/** Rough HTML → text, good enough for previews. Full bodies are converted by mailparser. */
export function htmlToPreviewText(html: string): string {
  return html
    .replace(/<(head|style|script|title)[\s\S]*?(<\/\1>|$)/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>?/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] === '#') {
        const code =
          entity[1]?.toLowerCase() === 'x'
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    });
}

/** One line of text for result lists: no quotes, no whitespace runs, at most `max` characters. */
export function toSnippet(text: string, max = 160): string {
  return snippetText(
    text
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith('>'))
      .join(' '),
    max,
  );
}
