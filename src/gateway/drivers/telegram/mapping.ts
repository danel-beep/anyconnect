/**
 * Turns mtcute's objects into the gateway's messenger shapes. Pure functions, so the rules (chat
 * kinds, what counts as an attachment, which messages are skipped) are covered by unit tests.
 */
import type { Message, Peer } from '@mtcute/core';
import type {
  AttachmentKind,
  ChatKind,
  InboundAttachment,
  InboundChat,
  InboundMessage,
} from '../../../connectors/messaging.js';

/** Where a stored attachment lives: the message is fetched again to get a fresh file reference. */
export interface TelegramFileLocator {
  messageId: number;
}

export function chatKind(peer: Peer): ChatKind {
  if (peer.type === 'user') return peer.isBot ? 'bot' : 'direct';
  return peer.chatType === 'channel' ? 'channel' : 'group';
}

/** Name of a chat as Telegram shows it; "Saved Messages" for the account itself. */
export function chatTitle(peer: Peer, selfId?: number): string {
  if (peer.type === 'user' && selfId !== undefined && peer.id === selfId) return 'Saved Messages';
  return peer.displayName;
}

export function toInboundChat(peer: Peer, options: { selfId?: number; unread?: number } = {}): InboundChat {
  const username = peer.username;
  return {
    externalId: String(peer.id),
    kind: chatKind(peer),
    title: chatTitle(peer, options.selfId),
    ...(username ? { username: `@${username}` } : {}),
    ...(options.unread !== undefined ? { unread: options.unread } : {}),
  };
}

const MEDIA_KINDS: Record<string, AttachmentKind> = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  document: 'document',
  sticker: 'sticker',
  location: 'location',
  live_location: 'location',
  venue: 'location',
  contact: 'contact',
};

/** Media that is a file the user can download; the rest is described in the text instead. */
const FILE_MEDIA = new Set(['photo', 'video', 'audio', 'voice', 'document', 'sticker']);

function attachmentOf(message: Message): InboundAttachment | undefined {
  const media = message.media;
  if (!media || media.type === 'webpage') return undefined;
  const kind = MEDIA_KINDS[media.type] ?? 'other';
  const attachment: InboundAttachment = { externalId: `${message.id}:0`, kind };
  if (FILE_MEDIA.has(media.type)) {
    const file = media as { fileSize?: number; fileName?: string | null; mimeType?: string };
    if (file.fileName) attachment.name = file.fileName;
    attachment.mimeType =
      media.type === 'photo' ? 'image/jpeg' : (file.mimeType ?? 'application/octet-stream');
    if (typeof file.fileSize === 'number') attachment.size = file.fileSize;
    attachment.locator = { messageId: message.id } satisfies TelegramFileLocator;
  }
  return attachment;
}

/** Text for media without a file (location, contact, poll), so the AI still sees what was sent. */
function mediaText(message: Message): string | undefined {
  const media = message.media;
  if (!media) return undefined;
  switch (media.type) {
    case 'location':
    case 'live_location':
      return `[location ${media.latitude}, ${media.longitude}]`;
    case 'venue':
      return `[place: ${media.title}${media.address ? `, ${media.address}` : ''}]`;
    case 'contact':
      return `[contact: ${[media.firstName, media.lastName].filter(Boolean).join(' ')}${media.phoneNumber ? ` ${media.phoneNumber}` : ''}]`;
    case 'poll':
      return `[poll: ${media.question}]`;
    default:
      return undefined;
  }
}

/**
 * A stored message, or undefined for messages that are not conversation (service messages such
 * as "joined the group", scheduled ones).
 */
export function toInboundMessage(
  message: Message,
  options: { selfId?: number } = {},
): InboundMessage | undefined {
  if (message.isService || message.isScheduled) return undefined;
  const chat = toInboundChat(message.chat, options);
  const attachment = attachmentOf(message);
  const text = [message.text, mediaText(message)].filter(Boolean).join('\n');
  const sender = message.sender;
  const editedAt = message.editDate;
  const replyTo = message.replyToMessage?.id;
  return {
    chat,
    externalId: String(message.id),
    direction: message.isOutgoing ? 'out' : 'in',
    sentAt: message.date,
    ...(editedAt ? { editedAt } : {}),
    ...(chat.kind === 'direct' || chat.kind === 'bot' || message.isOutgoing
      ? {}
      : { sender: { externalId: String(sender.id), name: sender.displayName } }),
    ...(text ? { text } : {}),
    ...(replyTo ? { replyToExternalId: String(replyTo) } : {}),
    ...(attachment ? { attachments: [attachment] } : {}),
  };
}
