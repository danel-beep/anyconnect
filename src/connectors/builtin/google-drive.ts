import { z } from 'zod';
import { HttpClient } from '../http/client.js';
import {
  type AccountContext,
  type CapabilityOutput,
  ConnectorError,
  defineConnector,
  requireOAuth,
} from '../sdk.js';

/**
 * Google Drive API v3 over OAuth. Google Docs/Sheets/Slides are exported to text/CSV so the AI can
 * read them in one call; plain text files are downloaded as is.
 */

type Ctx = AccountContext<Record<string, never>, Record<string, never>>;

const api = (ctx: Ctx, upload = false) => {
  requireOAuth(ctx);
  return new HttpClient(ctx, {
    baseUrl: upload ? 'https://www.googleapis.com/upload/drive/v3' : 'https://www.googleapis.com/drive/v3',
    errorMessagePaths: ['error.message'],
  });
};

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
  owners?: { emailAddress?: string }[];
  trashed?: boolean;
}

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,parents';

const FOLDER = 'application/vnd.google-apps.folder';
/** Export formats for Google-native files. */
const EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.drawing': 'image/svg+xml',
};
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|csv|x-ndjson|sql))/;
const SHORT_TYPES: Record<string, string> = {
  'application/vnd.google-apps.document': 'google_doc',
  'application/vnd.google-apps.spreadsheet': 'google_sheet',
  'application/vnd.google-apps.presentation': 'google_slides',
  [FOLDER]: 'folder',
};

const fileSummary = (f: DriveFile) => ({
  id: f.id,
  name: f.name,
  type: SHORT_TYPES[f.mimeType] ?? f.mimeType,
  ...(f.modifiedTime ? { modified: f.modifiedTime } : {}),
  ...(f.size ? { size: Number(f.size) } : {}),
  ...(f.webViewLink ? { url: f.webViewLink } : {}),
});

type Summary = ReturnType<typeof fileSummary>;
const MIME_OF_SHORT = Object.fromEntries(Object.entries(SHORT_TYPES).map(([mime, short]) => [short, mime]));

/** A native file summary as the shared `files.*` item. */
const fileItem = (f: Summary): CapabilityOutput<'files.search'> => ({
  id: f.id,
  name: f.name,
  mime_type: MIME_OF_SHORT[f.type] ?? f.type,
  ...(f.size !== undefined ? { size: f.size } : {}),
  ...(f.modified ? { modified: f.modified } : {}),
  ...(f.url ? { url: f.url } : {}),
});

/** Escapes a value for a Drive query string literal. */
const literal = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function buildQuery(input: {
  text?: string | undefined;
  name?: string | undefined;
  folderId?: string | undefined;
  type?: string | undefined;
  q?: string | undefined;
}): string {
  const parts = ['trashed = false'];
  if (input.text) parts.push(`fullText contains ${literal(input.text)}`);
  if (input.name) parts.push(`name contains ${literal(input.name)}`);
  if (input.folderId) parts.push(`${literal(input.folderId)} in parents`);
  if (input.type) {
    const mime = Object.entries(SHORT_TYPES).find(([, short]) => short === input.type)?.[0] ?? input.type;
    parts.push(`mimeType = ${literal(mime)}`);
  }
  if (input.q) parts.push(`(${input.q})`);
  return parts.join(' and ');
}

const FileId = z.string().trim().min(1).max(200).describe('File id from gdrive_search');

export default defineConnector({
  id: 'gdrive',
  name: 'Google Drive',
  description:
    'Google Drive: find files, read Docs/Sheets/Slides and text files, create, rename, move, trash.',
  version: '1.0.0',
  homepage: 'https://developers.google.com/workspace/drive/api',
  instructions:
    'gdrive_read exports Google Docs and Slides to text and Sheets to CSV (first sheet). Folders are files of type "folder".',
  oauth: { provider: 'google', scopes: ['https://www.googleapis.com/auth/drive'] },
  async test(ctx) {
    const { data } = await api(ctx).get<{ user?: { emailAddress?: string } }>('about', {
      fields: 'user(emailAddress)',
    });
    return { ok: true, ...(data.user?.emailAddress ? { identity: data.user.emailAddress } : {}) };
  },
  ui: {
    locales: {
      ru: {
        setup: {
          oauth: {
            summary: 'Ваш аккаунт Google. Меньше минуты.',
            steps: [
              {
                text: 'Нажмите «Подключить» и выберите аккаунт Google с нужными файлами.',
              },
              {
                text: 'Google попросит разрешить AnyConnect смотреть и менять файлы на Диске. Нажмите «Продолжить».',
              },
              {
                text: 'Готово: ИИ находит файлы и читает Документы, Таблицы и PDF на этом Диске.',
              },
            ],
            tips: [
              'Чтобы закрыть доступ, удалите аккаунт здесь или уберите AnyConnect в аккаунте Google, раздел «Сторонние приложения и сервисы».',
            ],
          },
        },
        prompts: [
          'Найди таблицу с бюджетом на третий квартал и назови итог.',
          'Перескажи последнюю версию документа «Бриф проекта».',
          'Какие документы я правил на этой неделе?',
          'Создай документ «Заметки со встречи 12 ноября» с тем, что мы обсудили.',
        ],
        name: 'Google Диск',
        description:
          'Google Диск: поиск файлов, чтение документов, таблиц, презентаций и текстовых файлов, создание, переименование, перемещение и удаление.',
        actions: {
          search: {
            title: 'Поиск файлов',
            description:
              'Находит файлы по словам в тексте, названию, папке или типу. Без запроса показывает недавно изменённые.',
          },
          read: {
            title: 'Чтение файла',
            description:
              'Возвращает текст Google Документа, Таблицы, Презентации или текстового файла. Длинный текст обрезается.',
          },
          create: {
            title: 'Новый файл',
            description: 'Создаёт Google Документ из текста, текстовый файл или папку.',
          },
          update: {
            title: 'Переименование, перемещение, корзина',
            description:
              'Переименовывает файл, переносит его в другую папку или в корзину, откуда его можно вернуть в течение 30 дней.',
          },
        },
      },
      en: {
        setup: {
          oauth: {
            summary: 'Your Google account. Takes under a minute.',
            steps: [
              {
                text: 'Click Connect and choose the Google account with the files you need.',
              },
              {
                text: 'Google asks to let AnyConnect see and edit your Drive files. Click Continue.',
              },
              {
                text: 'Done: the AI can find files and read Docs, Sheets and PDFs on that Drive.',
              },
            ],
            tips: [
              'To cut access, delete the account here or remove AnyConnect in your Google Account under Third-party connections.',
            ],
          },
        },
        prompts: [
          'Find the Q3 budget spreadsheet and tell me the total.',
          'Summarise the latest version of “Project brief”.',
          'Which documents did I edit this week?',
          'Create a doc “Meeting notes 12 Nov” with the points we just discussed.',
        ],
        actions: {
          search: {
            title: 'Search files',
            description:
              'Finds files by words in their text, name, folder or type. Without a query, recently modified first.',
          },
          read: {
            title: 'Read a file',
            description:
              'Returns the text of a Google Doc, Sheet, Slides deck or text file. Long text is cut.',
          },
          create: {
            title: 'Create a file',
            description: 'Creates a Google Doc from text, a plain text file or a folder.',
          },
          update: {
            title: 'Rename, move or trash',
            description:
              'Renames a file, moves it to another folder, or moves it to the trash (restorable for 30 days).',
          },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'search',
      title: 'Search files',
      description:
        'Finds files by content words, name, folder or type; recently modified first when no text is given.',
      input: z.object({
        text: z.string().trim().max(500).optional().describe('Words inside the files'),
        name: z.string().trim().max(500).optional().describe('Part of the file name'),
        folderId: z.string().trim().max(200).optional().describe('Only files directly in this folder'),
        type: z
          .string()
          .max(200)
          .optional()
          .describe('google_doc, google_sheet, google_slides, folder or a MIME type like application/pdf'),
        q: z
          .string()
          .max(2000)
          .optional()
          .describe('Extra raw Drive query, e.g. "modifiedTime > \'2026-11-01\'"'),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().max(500).optional(),
      }),
      hints: { readOnly: true, idempotent: true },
      capability: {
        id: 'files.search',
        mapInput: ({ query, limit }) => ({ text: query, limit }),
        mapOutput: (result) => {
          const { files, nextCursor } = result as { files: Summary[]; nextCursor?: string };
          return { items: files.map(fileItem), ...(nextCursor ? { nextCursor } : {}) };
        },
      },
      run: async ({ limit, cursor, ...filters }, ctx) => {
        const { data } = await api(ctx).get<{ files: DriveFile[]; nextPageToken?: string }>('files', {
          q: buildQuery(filters),
          pageSize: limit,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          // Drive refuses orderBy together with fullText search (results are by relevance then).
          ...(filters.text ? {} : { orderBy: 'modifiedTime desc' }),
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          ...(cursor ? { pageToken: cursor } : {}),
        });
        return {
          files: data.files.map(fileSummary),
          ...(data.nextPageToken ? { nextCursor: data.nextPageToken } : {}),
        };
      },
    }),
    action({
      name: 'read',
      title: 'Read file',
      description: 'Returns the text of a Google Doc/Sheet/Slides or a text file (cut to maxChars).',
      input: z.object({ id: FileId, maxChars: z.number().int().min(500).max(200_000).default(10_000) }),
      hints: { readOnly: true, idempotent: true },
      capability: {
        id: 'files.read',
        mapInput: ({ id, max_chars }) => ({ id, maxChars: Math.max(500, Number(max_chars)) }),
        mapOutput: (result): CapabilityOutput<'files.read'> => {
          const r = result as Summary & { text: string; truncated?: boolean };
          return { ...fileItem(r), text: r.text, ...(r.truncated ? { truncated: true } : {}) };
        },
      },
      run: async ({ id, maxChars }, ctx) => {
        const client = api(ctx);
        const { data: file } = await client.get<DriveFile>(`files/${encodeURIComponent(id)}`, {
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        let text: string;
        const exportAs = EXPORTS[file.mimeType];
        if (file.mimeType === FOLDER) {
          throw new ConnectorError('invalid_input', 'This is a folder; list it with gdrive_search folderId.');
        } else if (exportAs) {
          const { data } = await client.get<string>(`files/${encodeURIComponent(id)}/export`, {
            mimeType: exportAs,
          });
          text = typeof data === 'string' ? data : JSON.stringify(data);
        } else if (TEXT_TYPES.test(file.mimeType)) {
          if (Number(file.size ?? 0) > 5 * 1024 * 1024) {
            throw new ConnectorError('invalid_input', 'The file is larger than 5 MB; open it in Drive.');
          }
          const { data } = await client.get<unknown>(`files/${encodeURIComponent(id)}`, {
            alt: 'media',
            supportsAllDrives: true,
          });
          text = typeof data === 'string' ? data : JSON.stringify(data, null, 1);
        } else {
          throw new ConnectorError(
            'invalid_input',
            `Reading ${file.mimeType} files is not supported yet; the link is ${file.webViewLink ?? 'in Drive'}.`,
          );
        }
        const totalChars = text.length;
        return {
          ...fileSummary(file),
          text: totalChars > maxChars ? `${text.slice(0, maxChars)}…` : text,
          ...(totalChars > maxChars ? { truncated: true, totalChars } : {}),
        };
      },
    }),
    action({
      name: 'create',
      title: 'Create file',
      description: 'Creates a Google Doc (from text), a plain text file or a folder.',
      input: z.object({
        name: z.string().trim().min(1).max(500),
        kind: z.enum(['google_doc', 'text', 'folder']).default('google_doc'),
        content: z.string().max(1_000_000).default('').describe('Text content (ignored for folders)'),
        folderId: z.string().trim().max(200).optional().describe('Parent folder; default: My Drive root'),
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      undo: { kind: 'action', action: 'update', note: 'Move it to trash with trash: true' },
      run: async ({ name, kind, content, folderId }, ctx) => {
        const metadata = {
          name,
          ...(folderId ? { parents: [folderId] } : {}),
          mimeType:
            kind === 'folder'
              ? FOLDER
              : kind === 'google_doc'
                ? 'application/vnd.google-apps.document'
                : 'text/plain',
        };
        if (kind === 'folder') {
          const { data } = await api(ctx).request<DriveFile>({
            method: 'POST',
            url: 'files',
            query: { fields: FILE_FIELDS, supportsAllDrives: true },
            json: metadata,
          });
          return fileSummary(data);
        }
        const boundary = `anyconnect-${crypto.randomUUID()}`;
        const body = [
          `--${boundary}`,
          'Content-Type: application/json; charset=UTF-8',
          '',
          JSON.stringify(metadata),
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          '',
          content,
          `--${boundary}--`,
          '',
        ].join('\r\n');
        const { data } = await api(ctx, true).request<DriveFile>({
          method: 'POST',
          url: 'files',
          query: { uploadType: 'multipart', fields: FILE_FIELDS, supportsAllDrives: true },
          headers: { 'content-type': `multipart/related; boundary=${boundary}` },
          body,
        });
        return fileSummary(data);
      },
    }),
    action({
      name: 'update',
      title: 'Rename / move / trash',
      description:
        'Renames a file, moves it to another folder, or moves it to trash (restorable for 30 days).',
      input: z.object({
        id: FileId,
        name: z.string().trim().min(1).max(500).optional(),
        moveToFolderId: z.string().trim().max(200).optional(),
        trash: z.boolean().optional().describe('true moves to trash, false restores'),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      // Trash is restorable for 30 days.
      risk: 'write',
      run: async ({ id, name, moveToFolderId, trash }, ctx) => {
        if (name === undefined && moveToFolderId === undefined && trash === undefined) {
          throw new ConnectorError('invalid_input', 'Pass name, moveToFolderId or trash.');
        }
        const client = api(ctx);
        let removeParents: string | undefined;
        if (moveToFolderId) {
          const { data } = await client.get<DriveFile>(`files/${encodeURIComponent(id)}`, {
            fields: 'parents',
            supportsAllDrives: true,
          });
          removeParents = data.parents?.join(',');
        }
        const { data } = await client.request<DriveFile>({
          method: 'PATCH',
          url: `files/${encodeURIComponent(id)}`,
          query: {
            fields: `${FILE_FIELDS},trashed`,
            supportsAllDrives: true,
            ...(moveToFolderId ? { addParents: moveToFolderId } : {}),
            ...(removeParents ? { removeParents } : {}),
          },
          json: { ...(name ? { name } : {}), ...(trash !== undefined ? { trashed: trash } : {}) },
        });
        return { ...fileSummary(data), ...(data.trashed ? { trashed: true } : {}) };
      },
    }),
  ],
});
