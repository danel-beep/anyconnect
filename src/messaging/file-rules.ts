import type { FileRules, OutboundFile } from '../connectors/messaging.js';
import { ConnectorError } from '../connectors/sdk.js';

/**
 * The file as this transport can send it (see {@link FileRules}): a photo, video or audio the
 * messenger would not show as such (too large, another format) goes as a document, which every
 * messenger shows, instead of failing in the queue. A file larger than the transport takes is
 * refused now, with the limit in the message. Rules apply to what is known: a link the messenger
 * fetches itself has no size yet, so only its type is checked.
 */
export function fitFile(file: OutboundFile, rules: FileRules, service: string): OutboundFile {
  if (file.size !== undefined && file.size > rules.maxBytes) {
    throw new ConnectorError(
      'invalid_input',
      `The file is ${megabytes(file.size)} MB; ${service} sends files up to ${megabytes(rules.maxBytes)} MB.`,
    );
  }
  if (file.kind === 'document') return file;
  const rule = rules[file.kind];
  if (!rule) return file;
  const tooLarge = file.size !== undefined && file.size > rule.maxBytes;
  const otherType =
    rule.mimeTypes !== undefined && file.mimeType !== undefined && !rule.mimeTypes.includes(file.mimeType);
  return tooLarge || otherType ? { ...file, kind: 'document' } : file;
}

function megabytes(bytes: number): string {
  const value = bytes / 1_048_576;
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}
