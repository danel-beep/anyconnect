import { z } from 'zod';
import { HttpClient } from '../http/client.js';
import { type AccountContext, ConnectorError, compact, defineConnector, page, requireOAuth } from '../sdk.js';

/**
 * Google Sheets API v4 over the shared Google OAuth app: find spreadsheets (Drive metadata), read
 * and write ranges as rows, append rows, add sheets. Values are written as if typed by a person
 * (USER_ENTERED), so formulas and dates work.
 */

type Ctx = AccountContext<Record<string, never>, Record<string, never>>;

const sheets = (ctx: Ctx) => {
  requireOAuth(ctx);
  return new HttpClient(ctx, { baseUrl: API, errorMessagePaths: ['error.message'] });
};
const drive = (ctx: Ctx) => {
  requireOAuth(ctx);
  return new HttpClient(ctx, {
    baseUrl: 'https://www.googleapis.com/drive/v3',
    errorMessagePaths: ['error.message'],
  });
};

/** Accepts a spreadsheet id or its URL (…/spreadsheets/d/<id>/edit). */
const SpreadsheetId = z
  .string()
  .trim()
  .min(10)
  .max(500)
  .transform((value, issue) => {
    const id = value.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? value;
    if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) {
      issue.addIssue({ code: 'custom', message: 'a spreadsheet id or its URL' });
      return z.NEVER;
    }
    return id;
  })
  .describe('Spreadsheet id or URL');
const Range = z.string().trim().min(1).max(200).describe('A1 range, e.g. "Sheet1!A1:D50" or just "Sheet1"');
const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Rows = z.array(z.array(Cell)).min(1).max(1000).describe('Rows of cell values; formulas start with "="');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const url = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
// Absolute URLs: a relative "id:batchUpdate" would be read as a URL scheme.
const values = (id: string, range: string, suffix = '') =>
  `${API}/${id}/values/${encodeURIComponent(range)}${suffix}`;

export default defineConnector({
  id: 'gsheets',
  name: 'Google Sheets',
  description: 'Google Sheets: find spreadsheets, read and write cells, append rows, create spreadsheets.',
  version: '1.0.0',
  homepage: 'https://developers.google.com/workspace/sheets/api',
  instructions:
    'Ranges use A1 notation ("Sheet1!A1:D50"; quote sheet names with spaces: "\'Q4 plan\'!A:C"). Call gsheets_get_spreadsheet first to learn the sheet names.',
  oauth: {
    provider: 'google',
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
    ],
  },
  async test(ctx) {
    const { data } = await drive(ctx).get<{ user?: { emailAddress?: string } }>('about', {
      fields: 'user(emailAddress)',
    });
    return { ok: true, identity: data.user?.emailAddress ?? 'Google' };
  },
  ui: {
    locales: {
      ru: {
        description: 'Google Таблицы: поиск таблиц, чтение и запись ячеек, добавление строк, новые таблицы.',
        setup: {
          oauth: {
            summary: 'Ваш аккаунт Google. Меньше минуты.',
            steps: [
              { text: 'Нажмите «Подключить» и выберите аккаунт Google с нужными таблицами.' },
              {
                text: 'Google попросит разрешить Manyplug смотреть и менять таблицы и видеть список файлов на Диске. Нажмите «Продолжить».',
              },
              { text: 'Готово: ИИ видит все таблицы этого аккаунта, в том числе общие.' },
            ],
          },
        },
        prompts: [
          'Найди таблицу «Бюджет 2027» и покажи итоги по месяцам.',
          'Добавь в «Лиды» строку: ACME, Анна Смит, anna@acme.com, сегодня.',
          'Сколько заказов в листе «Октябрь» со статусом «Оплачен»?',
          'Создай таблицу «План контента» с колонками Дата, Тема, Канал, Ответственный.',
        ],
        actions: {
          find_spreadsheets: { title: 'Поиск таблиц', description: 'Находит таблицы по названию.' },
          get_spreadsheet: { title: 'Структура таблицы', description: 'Листы таблицы и их размеры.' },
          read_range: { title: 'Чтение ячеек', description: 'Читает диапазон строками.' },
          write_range: { title: 'Запись ячеек', description: 'Записывает значения в диапазон.' },
          append_rows: {
            title: 'Новые строки',
            description: 'Добавляет строки после последней заполненной.',
          },
          clear_range: { title: 'Очистка ячеек', description: 'Стирает значения в диапазоне.' },
          create_spreadsheet: {
            title: 'Новая таблица',
            description: 'Создаёт таблицу, при желании с заголовками.',
          },
          add_sheet: { title: 'Новый лист', description: 'Добавляет лист в таблицу.' },
        },
      },
      en: {
        setup: {
          oauth: {
            summary: 'Your Google account. Takes under a minute.',
            steps: [
              { text: 'Click Connect and choose the Google account that has your spreadsheets.' },
              {
                text: 'Google asks to let Manyplug see and edit your spreadsheets and see the list of your Drive files. Click Continue.',
              },
              { text: 'Done: the AI sees every spreadsheet of that account, including shared ones.' },
            ],
          },
        },
        prompts: [
          'Find the “Budget 2027” spreadsheet and show the monthly totals.',
          'Add a row to Leads: ACME, Anna Smith, anna@acme.com, today.',
          'How many orders on the October sheet are marked Paid?',
          'Create a “Content plan” spreadsheet with columns Date, Topic, Channel, Owner.',
        ],
        actions: {
          find_spreadsheets: { title: 'Find spreadsheets', description: 'Finds spreadsheets by name.' },
          get_spreadsheet: {
            title: 'Spreadsheet structure',
            description: 'Sheets of a spreadsheet and their sizes.',
          },
          read_range: { title: 'Read cells', description: 'Reads a range as rows.' },
          write_range: { title: 'Write cells', description: 'Writes values into a range.' },
          append_rows: { title: 'Append rows', description: 'Adds rows after the last filled one.' },
          clear_range: { title: 'Clear cells', description: 'Erases the values in a range.' },
          create_spreadsheet: {
            title: 'Create a spreadsheet',
            description: 'Creates a spreadsheet, optionally with headers.',
          },
          add_sheet: { title: 'Add a sheet', description: 'Adds a sheet to a spreadsheet.' },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'find_spreadsheets',
      title: 'Find spreadsheets',
      description: 'Finds spreadsheets by words in the name, recently changed first.',
      input: z.object({
        query: z.string().trim().max(200).optional().describe('Words in the name; empty lists the latest'),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().max(500).optional().describe('nextCursor from the previous result'),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ query, limit, cursor }, ctx) => {
        const q = ["mimeType = 'application/vnd.google-apps.spreadsheet'", 'trashed = false'];
        if (query) q.push(`name contains '${query.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
        const { data } = await drive(ctx).get<{
          files: { id: string; name: string; modifiedTime?: string }[];
          nextPageToken?: string;
        }>('files', {
          q: q.join(' and '),
          orderBy: 'modifiedTime desc',
          pageSize: limit,
          fields: 'files(id,name,modifiedTime),nextPageToken',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          ...(cursor ? { pageToken: cursor } : {}),
        });
        return page(
          data.files.map((f) =>
            compact({ id: f.id, name: f.name, modified: f.modifiedTime, url: url(f.id) }),
          ),
          { nextCursor: data.nextPageToken },
        );
      },
    }),
    action({
      name: 'get_spreadsheet',
      title: 'Get spreadsheet',
      description: 'Returns the title and the sheets (names and sizes) of a spreadsheet.',
      input: z.object({ spreadsheet_id: SpreadsheetId }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ spreadsheet_id }, ctx) => {
        const { data } = await sheets(ctx).get<{
          properties: { title: string; locale?: string; timeZone?: string };
          sheets: {
            properties: {
              sheetId: number;
              title: string;
              gridProperties?: { rowCount?: number; columnCount?: number };
            };
          }[];
        }>(`${API}/${spreadsheet_id}`, {
          fields: 'properties(title,locale,timeZone),sheets.properties(sheetId,title,gridProperties)',
        });
        return {
          id: spreadsheet_id,
          title: data.properties.title,
          time_zone: data.properties.timeZone,
          sheets: data.sheets.map((s) => ({
            name: s.properties.title,
            rows: s.properties.gridProperties?.rowCount,
            columns: s.properties.gridProperties?.columnCount,
          })),
          url: url(spreadsheet_id),
        };
      },
    }),
    action({
      name: 'read_range',
      title: 'Read cells',
      description: 'Reads a range as rows of formatted values; empty trailing cells are left out.',
      input: z.object({
        spreadsheet_id: SpreadsheetId,
        range: Range,
        max_rows: z.number().int().min(1).max(5000).default(200),
        formulas: z.boolean().default(false).describe('Return formulas instead of their results'),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ spreadsheet_id, range, max_rows, formulas }, ctx) => {
        const { data } = await sheets(ctx).get<{ range: string; values?: unknown[][] }>(
          values(spreadsheet_id, range),
          {
            valueRenderOption: formulas ? 'FORMULA' : 'FORMATTED_VALUE',
          },
        );
        const rows = data.values ?? [];
        return compact({
          range: data.range,
          rows: rows.slice(0, max_rows),
          total_rows: rows.length,
          truncated: rows.length > max_rows || undefined,
        });
      },
    }),
    action({
      name: 'write_range',
      title: 'Write cells',
      description: 'Writes rows into a range starting at its top-left cell, overwriting what is there.',
      input: z.object({ spreadsheet_id: SpreadsheetId, range: Range, values: Rows }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      run: async ({ spreadsheet_id, range, values: rows }, ctx) => {
        const { data } = await sheets(ctx).request<{ updatedRange?: string; updatedCells?: number }>({
          method: 'PUT',
          url: values(spreadsheet_id, range),
          query: { valueInputOption: 'USER_ENTERED' },
          json: { range, majorDimension: 'ROWS', values: rows },
        });
        return compact({ updated_range: data.updatedRange, updated_cells: data.updatedCells });
      },
    }),
    action({
      name: 'append_rows',
      title: 'Append rows',
      description: 'Adds rows after the last filled row of a table (range: the sheet name or its columns).',
      input: z.object({ spreadsheet_id: SpreadsheetId, range: Range, values: Rows }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ spreadsheet_id, range, values: rows }, ctx) => {
        const { data } = await sheets(ctx).request<{
          updates?: { updatedRange?: string; updatedRows?: number };
        }>({
          method: 'POST',
          url: values(spreadsheet_id, range, ':append'),
          query: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
          json: { majorDimension: 'ROWS', values: rows },
        });
        return compact({ updated_range: data.updates?.updatedRange, added_rows: data.updates?.updatedRows });
      },
    }),
    action({
      name: 'clear_range',
      title: 'Clear cells',
      description: 'Erases the values (not formatting) in a range.',
      input: z.object({ spreadsheet_id: SpreadsheetId, range: Range }),
      hints: { readOnly: false, destructive: true, idempotent: true },
      risk: 'dangerous',
      run: async ({ spreadsheet_id, range }, ctx) => {
        const { data } = await sheets(ctx).request<{ clearedRange?: string }>({
          method: 'POST',
          url: values(spreadsheet_id, range, ':clear'),
          json: {},
        });
        return { cleared_range: data.clearedRange ?? range };
      },
    }),
    action({
      name: 'create_spreadsheet',
      title: 'Create spreadsheet',
      description: 'Creates a spreadsheet, optionally with a header row on the first sheet.',
      input: z.object({
        title: z.string().trim().min(1).max(200),
        headers: z.array(z.string().max(200)).max(100).optional(),
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ title, headers }, ctx) => {
        const { data } = await sheets(ctx).request<{
          spreadsheetId: string;
          spreadsheetUrl?: string;
          sheets?: { properties: { title: string } }[];
        }>({ method: 'POST', url: API, json: { properties: { title } } });
        const first = data.sheets?.[0]?.properties.title ?? 'Sheet1';
        if (headers?.length) {
          await sheets(ctx).request({
            method: 'PUT',
            url: values(data.spreadsheetId, `'${first}'!A1`),
            query: { valueInputOption: 'USER_ENTERED' },
            json: { majorDimension: 'ROWS', values: [headers] },
          });
        }
        return { id: data.spreadsheetId, sheet: first, url: data.spreadsheetUrl ?? url(data.spreadsheetId) };
      },
    }),
    action({
      name: 'add_sheet',
      title: 'Add sheet',
      description: 'Adds a sheet (tab) to a spreadsheet.',
      input: z.object({ spreadsheet_id: SpreadsheetId, name: z.string().trim().min(1).max(100) }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ spreadsheet_id, name }, ctx) => {
        const { data } = await sheets(ctx).request<{
          replies?: { addSheet?: { properties?: { sheetId: number; title: string } } }[];
        }>({
          method: 'POST',
          url: `${API}/${spreadsheet_id}:batchUpdate`,
          json: { requests: [{ addSheet: { properties: { title: name } } }] },
        });
        const added = data.replies?.[0]?.addSheet?.properties;
        if (!added) throw new ConnectorError('upstream', 'Google did not confirm the new sheet');
        return { sheet: added.title, sheet_id: added.sheetId };
      },
    }),
  ],
});
