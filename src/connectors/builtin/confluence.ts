import { z } from 'zod';
import { HttpClient, type QueryValue } from '../http/client.js';
import {
  type AccountContext,
  type CapabilityOutput,
  ConnectorError,
  compact,
  defineConnector,
  htmlToText,
  page,
  truncateText,
} from '../sdk.js';

/**
 * Confluence Cloud with the same Atlassian email + API token as Jira. Pages are read as text (the
 * rendered HTML converted), search uses CQL, and edits need the current version number, so this
 * is a code connector.
 */

const Config = z.object({
  site: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/, 'only the site name, e.g. "acme" for acme.atlassian.net')
    .describe('Your Atlassian site name: the part before .atlassian.net, e.g. "acme"'),
  email: z.email().describe('Email you sign in to Atlassian with'),
});
const Credentials = z.object({
  apiToken: z
    .string()
    .trim()
    .min(1)
    .describe('API token: https://id.atlassian.com/manage-profile/security/api-tokens'),
});

type Ctx = AccountContext<z.output<typeof Config>, z.output<typeof Credentials>>;

const siteUrl = (ctx: Ctx) => `https://${ctx.config.site}.atlassian.net/wiki`;

const client = (ctx: Ctx) =>
  new HttpClient(ctx, {
    baseUrl: siteUrl(ctx),
    headers: {
      authorization: `Basic ${Buffer.from(`${ctx.config.email}:${ctx.credentials.apiToken}`).toString('base64')}`,
      accept: 'application/json',
    },
    errorMessagePaths: ['message', 'errors.0.title', 'errorMessages.0'],
  });

async function get<T>(ctx: Ctx, url: string, query: Record<string, QueryValue> = {}): Promise<T> {
  const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined));
  return (await client(ctx).request<T>({ method: 'GET', url, query: clean })).data;
}

async function send<T>(ctx: Ctx, method: 'POST' | 'PUT' | 'DELETE', url: string, json?: unknown): Promise<T> {
  return (await client(ctx).request<T>({ method, url, ...(json !== undefined ? { json } : {}) })).data;
}

/** CQL string literal. */
const cqlString = (value: string) => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** Plain text (paragraphs split by blank lines) or ready storage XHTML. */
function storageBody(body: string): string {
  if (/^\s*</.test(body)) return body;
  const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return body
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeXml(p.trim()).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

interface SearchResult {
  content?: { id: string; type: string; title: string; space?: { key?: string; name?: string } };
  title?: string;
  excerpt?: string;
  url?: string;
  lastModified?: string;
}

const PageId = z.string().trim().regex(/^\d+$/, 'a Confluence page id is a number').describe('Page id');
const Limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);

type FileItem = CapabilityOutput<'files.search'>;

async function readPage(ctx: Ctx, id: string, maxChars: number) {
  const p = await get<{
    id: string;
    title: string;
    spaceId?: string;
    version?: { number: number; createdAt?: string; authorId?: string };
    body?: { view?: { value?: string } };
    _links?: { webui?: string };
  }>(ctx, `/api/v2/pages/${id}`, { 'body-format': 'view' });
  const text = htmlToText(p.body?.view?.value ?? '');
  return {
    id: p.id,
    title: p.title,
    version: p.version?.number,
    modified: p.version?.createdAt,
    url: p._links?.webui ? `${siteUrl(ctx)}${p._links.webui}` : undefined,
    text: truncateText(text, maxChars),
    truncated: text.length > maxChars,
  };
}

export default defineConnector({
  id: 'confluence',
  name: 'Confluence',
  description: 'Confluence Cloud pages and spaces: search, read as text, create, update, comment.',
  version: '1.0.0',
  homepage: 'https://developer.atlassian.com/cloud/confluence/rest/v2/',
  instructions:
    'confluence_search takes words or CQL (e.g. "space = ENG AND type = page AND lastmodified > now(\\"-7d\\")"). Page bodies are written as plain text paragraphs or Confluence storage XHTML.',
  config: Config,
  credentials: Credentials,
  rateLimit: { requests: 100, perSeconds: 60 },
  async test(ctx) {
    const user = await get<{ email?: string; displayName?: string }>(ctx, '/rest/api/user/current');
    return { ok: true, identity: user.email || user.displayName || `${ctx.config.site}.atlassian.net` };
  },
  ui: {
    primaryFields: ['site', 'email', 'apiToken'],
    locales: {
      ru: {
        description:
          'Страницы и пространства Confluence Cloud: поиск, чтение, создание, изменение и комментарии.',
        setup: {
          form: {
            summary: 'Вы создаёте API-токен Atlassian и вставляете его сюда вместе с именем сайта и почтой.',
            minutes: 2,
            needs: ['Аккаунт Confluence Cloud', 'Почта, с которой вы входите в Atlassian'],
            steps: [
              {
                text: 'Откройте страницу API-токенов Atlassian и нажмите **Create API token** (без прав).',
                link: {
                  label: 'Открыть токены Atlassian',
                  url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
                },
              },
              { text: 'Назовите токен Manyplug, выберите срок действия и нажмите **Create**.' },
              {
                text: 'Нажмите **Copy**: Atlassian показывает токен только один раз. Подойдёт и токен, созданный для Jira.',
                fills: ['apiToken'],
              },
              {
                text: 'В форме укажите имя сайта (acme для acme.atlassian.net) и почту, с которой входите в Atlassian.',
                fills: ['site', 'email'],
              },
            ],
            tips: [
              'ИИ видит в Confluence то же, что и вы.',
              'Чтобы закрыть доступ, отзовите токен на той же странице.',
            ],
            problems: [
              {
                problem: 'Форма пишет, что почта или токен не подходят',
                fix: 'Укажите почту аккаунта Atlassian и токен, созданный через **Create API token**, а не **Create API token with scopes**.',
              },
              {
                problem: 'Форма не находит сайт',
                fix: 'Укажите только первую часть адреса: acme для acme.atlassian.net.',
              },
              {
                problem: 'Через какое-то время ИИ перестаёт работать',
                fix: 'Срок токена истёк. Создайте новый и вставьте его через **Переподключить**.',
              },
            ],
          },
        },
        prompts: [
          'Найди в Confluence, как у нас устроен онбординг новых сотрудников.',
          'Перескажи страницу «План релиза 3.0».',
          'Создай в пространстве ENG страницу «Итоги ретро» с тем, что мы обсудили.',
          'Какие страницы в пространстве PRODUCT менялись за неделю?',
        ],
        fields: {
          site: {
            label: 'Сайт Atlassian',
            hint: 'Часть адреса до .atlassian.net: для acme.atlassian.net — acme.',
          },
          email: { label: 'Почта Atlassian', hint: 'Та, с которой вы входите в Confluence.' },
          apiToken: { label: 'Токен API', hint: 'Создаётся на id.atlassian.com → Security → API tokens.' },
        },
        actions: {
          search: { title: 'Поиск', description: 'Ищет страницы по словам или запросу CQL.' },
          get_page: { title: 'Страница', description: 'Показывает страницу текстом.' },
          list_spaces: { title: 'Список пространств', description: 'Пространства с их ключами.' },
          create_page: { title: 'Новая страница', description: 'Создаёт страницу в пространстве.' },
          update_page: { title: 'Изменение страницы', description: 'Меняет название или текст страницы.' },
          add_comment: { title: 'Новый комментарий', description: 'Добавляет комментарий к странице.' },
        },
      },
      en: {
        setup: {
          form: {
            summary: 'You create an Atlassian API token and paste it here with your site name and email.',
            minutes: 2,
            needs: ['A Confluence Cloud account', 'The email you sign in to Atlassian with'],
            steps: [
              {
                text: 'Open your Atlassian API tokens page and click **Create API token** (the one without scopes).',
                link: {
                  label: 'Open Atlassian API tokens',
                  url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
                },
              },
              { text: 'Name it Manyplug, pick an expiry date and click **Create**.' },
              {
                text: 'Click **Copy**: Atlassian shows the token only once. A token you made for Jira works too.',
                fills: ['apiToken'],
              },
              {
                text: 'In the form, enter your site name (acme for acme.atlassian.net) and the email you sign in to Atlassian with.',
                fills: ['site', 'email'],
              },
            ],
            tips: [
              'The AI sees in Confluence what you see.',
              'To cut access, revoke the token on the same page.',
            ],
            problems: [
              {
                problem: 'The form says the email or token is wrong',
                fix: 'Use the email of your Atlassian account and a token made with **Create API token**, not **Create API token with scopes**.',
              },
              {
                problem: 'The form cannot find the site',
                fix: 'Enter only the first part of the address: acme for acme.atlassian.net.',
              },
              {
                problem: 'The AI stops working after a while',
                fix: 'The token has expired. Create a new one and paste it with **Reconnect**.',
              },
            ],
          },
        },
        prompts: [
          'Find how our new-hire onboarding works in Confluence.',
          'Summarize the “Release 3.0 plan” page.',
          'Create a page “Retro notes” in the ENG space with what we discussed.',
          'Which pages in the PRODUCT space changed this week?',
        ],
        fields: {
          site: {
            label: 'Atlassian site',
            hint: 'The part before .atlassian.net: for acme.atlassian.net, acme.',
          },
          email: { label: 'Atlassian email', hint: 'The one you sign in to Confluence with.' },
          apiToken: { label: 'API token', hint: 'Create it at id.atlassian.com → Security → API tokens.' },
        },
        actions: {
          search: { title: 'Search', description: 'Finds pages by words or a CQL query.' },
          get_page: { title: 'Get a page', description: 'Shows a page as text.' },
          list_spaces: { title: 'List spaces', description: 'Spaces with their keys.' },
          create_page: { title: 'Create a page', description: 'Creates a page in a space.' },
          update_page: { title: 'Update a page', description: 'Changes the title or text of a page.' },
          add_comment: { title: 'Add a comment', description: 'Adds a comment to a page.' },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'search',
      title: 'Search',
      description: 'Finds pages by words (in title and text) or by a CQL query, best matches first.',
      input: z.object({
        query: z.string().trim().min(1).max(500).describe('Words, or CQL when cql is true'),
        cql: z.boolean().default(false),
        space: z.string().trim().max(50).optional().describe('Only this space key'),
        limit: Limit(50, 20),
        cursor: z.string().max(2000).optional().describe('nextCursor from the previous result'),
      }),
      hints: { readOnly: true, idempotent: true },
      capability: {
        id: 'files.search',
        mapInput: ({ query, limit }) => ({ query, limit }),
        mapOutput: (result) => {
          const { items, nextCursor } = result as { items: Record<string, string>[]; nextCursor?: string };
          return {
            items: items.map(
              (i): FileItem => ({
                id: i.id!,
                name: i.title!,
                ...(i.space ? { path: i.space } : {}),
                mime_type: 'text/html',
                ...(i.modified ? { modified: i.modified } : {}),
                ...(i.url ? { url: i.url } : {}),
              }),
            ),
            ...(nextCursor ? { nextCursor } : {}),
          };
        },
      },
      run: async ({ query, cql, space, limit, cursor }, ctx) => {
        const clauses = [cql ? `(${query})` : `(title ~ ${cqlString(query)} OR text ~ ${cqlString(query)})`];
        if (!cql) clauses.push('type = page');
        if (space) clauses.push(`space = ${cqlString(space)}`);
        const result = await get<{ results: SearchResult[]; _links?: { next?: string } }>(
          ctx,
          '/rest/api/search',
          { cql: clauses.join(' AND '), limit, ...(cursor ? { cursor } : {}) },
        );
        const next = result._links?.next
          ? new URL(result._links.next, 'https://x').searchParams.get('cursor')
          : null;
        return page(
          result.results
            .filter((r) => r.content)
            .map((r) =>
              compact({
                id: r.content!.id,
                type: r.content!.type,
                title: r.content!.title,
                space: r.content!.space?.key,
                excerpt: r.excerpt ? truncateText(htmlToText(r.excerpt), 300) : undefined,
                modified: r.lastModified,
                url: r.url ? `${siteUrl(ctx)}${r.url}` : undefined,
              }),
            ),
          { nextCursor: next },
        );
      },
    }),
    action({
      name: 'get_page',
      title: 'Get page',
      description: 'Returns a page as plain text with its version number.',
      input: z.object({ id: PageId, max_chars: z.number().int().min(100).max(100_000).default(20_000) }),
      hints: { readOnly: true, idempotent: true },
      capability: {
        id: 'files.read',
        mapOutput: (result) => {
          const p = result as Awaited<ReturnType<typeof readPage>>;
          return compact({
            id: p.id,
            name: p.title,
            mime_type: 'text/html',
            modified: p.modified,
            url: p.url,
            text: p.text,
            truncated: p.truncated || undefined,
          });
        },
      },
      run: async ({ id, max_chars }, ctx) => compact(await readPage(ctx, id, max_chars)),
    }),
    action({
      name: 'list_spaces',
      title: 'List spaces',
      description: 'Lists spaces with their keys.',
      input: z.object({ limit: Limit(250, 50), cursor: z.string().max(2000).optional() }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ limit, cursor }, ctx) => {
        const result = await get<{
          results: { id: string; key: string; name: string; type?: string }[];
          _links?: { next?: string };
        }>(ctx, '/api/v2/spaces', { limit, status: 'current', ...(cursor ? { cursor } : {}) });
        const next = result._links?.next
          ? new URL(result._links.next, 'https://x').searchParams.get('cursor')
          : null;
        return page(
          result.results.map((s) => ({ id: s.id, key: s.key, name: s.name, type: s.type })),
          { nextCursor: next },
        );
      },
    }),
    action({
      name: 'create_page',
      title: 'Create page',
      description: 'Creates a page in a space, optionally under a parent page.',
      input: z.object({
        space: z.string().trim().min(1).max(50).describe('Space key, e.g. "ENG"'),
        title: z.string().trim().min(1).max(255),
        body: z.string().max(200_000).describe('Plain text paragraphs or storage XHTML'),
        parent_id: PageId.optional(),
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ space, title, body, parent_id }, ctx) => {
        const spaces = await get<{ results: { id: string }[] }>(ctx, '/api/v2/spaces', { keys: space });
        const spaceId = spaces.results[0]?.id;
        if (!spaceId)
          throw new ConnectorError(
            'not_found',
            `No Confluence space "${space}". Use confluence_list_spaces.`,
          );
        const created = await send<{ id: string; title: string; _links?: { webui?: string } }>(
          ctx,
          'POST',
          '/api/v2/pages',
          {
            spaceId,
            status: 'current',
            title,
            ...(parent_id ? { parentId: parent_id } : {}),
            body: { representation: 'storage', value: storageBody(body) },
          },
        );
        return compact({
          id: created.id,
          title: created.title,
          url: created._links?.webui ? `${siteUrl(ctx)}${created._links.webui}` : undefined,
        });
      },
    }),
    action({
      name: 'update_page',
      title: 'Update page',
      description: 'Changes the title and/or replaces the text of a page.',
      input: z.object({
        id: PageId,
        title: z.string().trim().min(1).max(255).optional(),
        body: z.string().max(200_000).optional().describe('New full text: plain paragraphs or storage XHTML'),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      run: async ({ id, title, body }, ctx) => {
        if (title === undefined && body === undefined)
          throw new ConnectorError('invalid_input', 'Nothing to change.');
        const current = await get<{
          id: string;
          title: string;
          status: string;
          version: { number: number };
          body?: { storage?: { value?: string } };
        }>(ctx, `/api/v2/pages/${id}`, { 'body-format': 'storage' });
        const updated = await send<{ id: string; version?: { number: number }; _links?: { webui?: string } }>(
          ctx,
          'PUT',
          `/api/v2/pages/${id}`,
          {
            id,
            status: 'current',
            title: title ?? current.title,
            body: {
              representation: 'storage',
              value: body !== undefined ? storageBody(body) : (current.body?.storage?.value ?? ''),
            },
            version: { number: current.version.number + 1 },
          },
        );
        return compact({
          id: updated.id,
          version: updated.version?.number,
          url: updated._links?.webui ? `${siteUrl(ctx)}${updated._links.webui}` : undefined,
        });
      },
    }),
    action({
      name: 'add_comment',
      title: 'Add comment',
      description: 'Adds a comment at the bottom of a page.',
      input: z.object({ id: PageId, text: z.string().trim().min(1).max(50_000) }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ id, text }, ctx) => {
        const comment = await send<{ id: string }>(ctx, 'POST', '/api/v2/footer-comments', {
          pageId: id,
          body: { representation: 'storage', value: storageBody(text) },
        });
        return { id: comment.id };
      },
    }),
  ],
});
