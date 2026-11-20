import type { FileRules } from '../../messaging.js';

const MB = 1_048_576;

/**
 * What Telegram shows as a photo, video or audio, for bots and personal accounts alike: photos up
 * to 10 MB, MPEG-4 videos, MP3/M4A music and OGG voice notes. Other files still go, as documents.
 * `maxBytes` is the account's own upload limit (bots 50 MB, personal accounts 2 GB).
 */
export function telegramFileRules(maxBytes: number): FileRules {
  return {
    maxBytes,
    photo: { maxBytes: 10 * MB, mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] },
    video: { maxBytes, mimeTypes: ['video/mp4'] },
    audio: { maxBytes, mimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/ogg'] },
  };
}

/** Bot API uploads (multipart) go up to 50 MB. */
export const TELEGRAM_BOT_FILES = telegramFileRules(50 * MB);

/** Personal accounts (MTProto) upload files up to 2 GB. */
export const TELEGRAM_USER_FILES = telegramFileRules(2000 * MB);
