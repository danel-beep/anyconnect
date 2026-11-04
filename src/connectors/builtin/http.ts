import { z } from 'zod';
import { HttpClient, type HttpResponse, type QueryValue } from '../http/client.js';
import { getPath, pickFields } from '../http/json-path.js';
import { type AccountContext, ConnectorError, defineConnector } from '../sdk.js';

/**
 * Generic HTTP: any REST/JSON API as an account (base URL + how to authenticate). It is the escape
 * hatch for services that have no connector yet: the AI calls endpoints by path, while the base
 * URL and the secret never leave the hub and requests cannot be sent to other hosts.
 */

const Config = z.object({
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .describe('API root, e.g. https://api.example.com/v1. Requests can only go below it'),
  auth: z
    .enum(['none', 'bearer', 'header', 'query', 'basic'])
    .default('bearer')
    .describe(
      'bearer: Authorization: Bearer <token>; header/query: the token in a custom header or query parameter',
    ),
  authName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/)
    .optional()
    .describe('Header or query parameter name for auth=header/query (default X-API-Key / api_key)'),
  headers: z
    .record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().max(1000))
    .default({})
    .describe('Non-secret headers sent with every request, e.g. API version'),
});

const Credentials = z.object({
  token: z.string().min(1).max(10_000).optional().describe('API key or token (auth=bearer/header/query)'),
  username: z.string().max(500).optional().describe('auth=basic'),
  password: z.string().max(10_000).optional().describe('auth=basic'),
});

type Ctx = AccountContext<z.output<typeof Config>, z.output<typeof Credentials>>;

const Path = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe('Path relative to the base URL, e.g. "/users/42" (no host)');
const Query = z
  .record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
  )
  .optional()
  .describe('Query parameters');
const Shape = {
  root: z.string().max(200).optional().describe('Return only this part of the JSON, e.g. "data.items"'),
  // `fields` is the hub's own argument; this one takes dot paths into any JSON.
  select: z
    .array(z.string().max(200))
    .max(50)
    .optional()
    .describe('Keep only these fields of the object (or of each item), e.g. ["id","name","owner.email"]'),
  maxChars: z.number().int().min(200).max(100_000).default(8000).describe('Cut the result to this size'),
};

/** Joins a relative path to the base URL and refuses anything that leaves it. */
export function resolveWithinBase(baseUrl: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
    throw new ConnectorError('invalid_input', 'Pass a path relative to the API base URL, not a full URL.');
  }
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const url = new URL(path.replace(/^\/+/, ''), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new ConnectorError('invalid_input', `The path must stay under ${base.pathname}.`);
  }
  return url.toString();
}

function client(ctx: Ctx): HttpClient {
  const { auth, authName, headers } = ctx.config;
  const { token, username, password } = ctx.credentials;
  const needToken = auth === 'bearer' || auth === 'header' || auth === 'query';
  if (needToken && !token) throw new ConnectorError('auth', 'No API token is saved for this account.');
  const authHeaders: Record<string, string> = {};
  const authQuery: Record<string, QueryValue> = {};
  if (auth === 'bearer') authHeaders.authorization = `Bearer ${token}`;
  if (auth === 'header') authHeaders[authName ?? 'X-API-Key'] = token!;
  if (auth === 'query') authQuery[authName ?? 'api_key'] = token!;
  if (auth === 'basic') {
    authHeaders.authorization = `Basic ${Buffer.from(`${username ?? ''}:${password ?? ''}`).toString('base64')}`;
  }
  return new HttpClient(ctx, {
    headers: { ...headers, ...authHeaders },
    query: authQuery,
  });
}

/** Response headers that help the AI page or follow up; everything else is noise. */
const USEFUL_HEADERS = ['content-type', 'link', 'location', 'x-total-count', 'x-next-cursor', 'retry-after'];

/** Shapes a response for the AI: optional root/select projection, then a size cap. */
export function shapeResponse(
  response: HttpResponse,
  options: { root?: string | undefined; select?: string[] | undefined; maxChars: number },
): Record<string, unknown> {
  const headers: Record<string, string> = {};
  for (const name of USEFUL_HEADERS) {
    const value = response.headers.get(name);
    if (value && !(name === 'content-type' && value.includes('json'))) headers[name] = value;
  }
  let data: unknown = response.data;
  if (typeof data !== 'string' && data !== undefined) {
    data = pickFields(getPath(data, options.root), options.select);
  }
  const out: Record<string, unknown> = {
    status: response.status,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
  if (data === undefined) return out;
  if (typeof data === 'string') {
    out.data = data.length > options.maxChars ? `${data.slice(0, options.maxChars)}…` : data;
    if (data.length > options.maxChars) out.truncated = { totalChars: data.length };
    return out;
  }
  const size = JSON.stringify(data).length;
  if (size <= options.maxChars) {
    out.data = data;
    return out;
  }
  if (Array.isArray(data)) {
    // Keep whole items that fit, so the AI gets valid objects plus a count of the rest.
    const kept: unknown[] = [];
    let used = 2;
    for (const item of data) {
      const length = JSON.stringify(item).length + 1;
      if (used + length > options.maxChars) break;
      kept.push(item);
      used += length;
    }
    out.data = kept;
    out.truncated = {
      shownItems: kept.length,
      totalItems: data.length,
      hint: 'Use select/root or paging parameters to get the rest',
    };
    return out;
  }
  const text = JSON.stringify(data);
  out.data = `${text.slice(0, options.maxChars)}…`;
  out.truncated = { totalChars: size, hint: 'Use select/root to choose what you need' };
  return out;
}

export default defineConnector({
  id: 'http',
  name: 'HTTP API',
  description:
    'Any REST/JSON API saved as an account (base URL + key). For services without a dedicated connector.',
  version: '1.0.0',
  instructions:
    'Paths are relative to the account base URL; see the account description for API notes. Use root/select to keep responses small.',
  config: Config,
  credentials: Credentials,
  async test(ctx) {
    const response = await client(ctx).request({ method: 'GET', url: ctx.config.baseUrl });
    return { ok: true, identity: new URL(ctx.config.baseUrl).host, message: `HTTP ${response.status}` };
  },
  ui: {
    primaryFields: ['baseUrl', 'auth', 'token'],
    locales: {
      ru: {
        description: 'Любой REST/JSON API как аккаунт: адрес и ключ. Для сервисов без готового коннектора.',
        fields: {
          baseUrl: {
            label: 'Адрес API',
            hint: 'Запросы будут уходить только по адресам внутри него',
            placeholder: 'https://api.example.com/v1',
          },
          auth: {
            label: 'Авторизация',
            hint: 'Логин и пароль для Basic вводятся в разделе «Дополнительно»',
            options: {
              none: 'Без авторизации',
              bearer: 'Токен в заголовке Authorization (Bearer)',
              header: 'Ключ в отдельном заголовке',
              query: 'Ключ в параметре адреса',
              basic: 'Логин и пароль (Basic)',
            },
          },
          authName: {
            label: 'Имя заголовка или параметра',
            hint: 'Для ключа в отдельном заголовке или в параметре адреса. По умолчанию X-API-Key или api_key.',
            placeholder: 'X-API-Key',
          },
          headers: {
            label: 'Заголовки запросов',
            hint: 'Несекретные заголовки для каждого запроса в формате JSON, например {"X-Api-Version": "2"}',
          },
          token: { label: 'Ключ API или токен', hint: 'Нужен для всех способов авторизации, кроме Basic' },
          username: { label: 'Логин', hint: 'Для авторизации по логину и паролю (Basic)' },
          password: { label: 'Пароль', hint: 'Для авторизации по логину и паролю (Basic)' },
        },
        actions: {
          get: {
            title: 'GET-запрос',
            description:
              'Читает данные из API: GET-запрос с параметрами. Возвращает код ответа и JSON или текст.',
          },
          request: {
            title: 'Запрос на изменение',
            description: 'Меняет данные через API: запрос POST, PUT, PATCH или DELETE с телом в JSON.',
          },
        },
      },
      en: {
        fields: {
          baseUrl: {
            label: 'API base URL',
            hint: 'Requests can only go to addresses below it',
            placeholder: 'https://api.example.com/v1',
          },
          auth: {
            label: 'Authentication',
            hint: 'The username and password for Basic go under “Advanced”',
            options: {
              none: 'None',
              bearer: 'Token in the Authorization header (Bearer)',
              header: 'Key in a custom header',
              query: 'Key in a query parameter',
              basic: 'Username and password (Basic)',
            },
          },
          authName: {
            label: 'Header or parameter name',
            hint: 'For a key in a custom header or query parameter. Default: X-API-Key or api_key.',
            placeholder: 'X-API-Key',
          },
          headers: {
            label: 'Request headers',
            hint: 'Non-secret headers sent with every request, as JSON, e.g. {"X-Api-Version": "2"}',
          },
          token: { label: 'API key or token', hint: 'Needed for every method except Basic' },
          username: { label: 'Username', hint: 'For username and password authentication (Basic)' },
          password: { label: 'Password', hint: 'For username and password authentication (Basic)' },
        },
        actions: {
          get: {
            title: 'GET request',
            description:
              'Reads from the API: a GET request with query parameters. Returns the status and JSON or text.',
          },
          request: {
            title: 'Write request',
            description:
              'Changes data through the API: a POST, PUT, PATCH or DELETE request with a JSON body.',
          },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'get',
      title: 'GET request',
      description: 'Reads from the API: GET a path with query parameters. Returns status and JSON or text.',
      input: z.object({ path: Path, query: Query, ...Shape }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ path, query, ...shape }, ctx) => {
        const response = await client(ctx).request({
          method: 'GET',
          url: resolveWithinBase(ctx.config.baseUrl, path),
          ...(query ? { query } : {}),
        });
        return shapeResponse(response, shape);
      },
    }),
    action({
      name: 'request',
      title: 'Write request',
      description: 'Changes data through the API: POST, PUT, PATCH or DELETE a path with a JSON body.',
      input: z.object({
        method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
        path: Path,
        query: Query,
        body: z.unknown().optional().describe('JSON body'),
        ...Shape,
      }),
      hints: { readOnly: false, destructive: true, idempotent: false },
      // An unknown API: a write is a write, and a DELETE always asks for confirmation.
      risk: 'write',
      assessRisk: ({ method }) =>
        method === 'DELETE' ? { risk: 'dangerous', reason: 'DELETE request to the API' } : undefined,
      run: async ({ method, path, query, body, ...shape }, ctx) => {
        const response = await client(ctx).request({
          method,
          url: resolveWithinBase(ctx.config.baseUrl, path),
          ...(query ? { query } : {}),
          ...(body !== undefined ? { json: body } : {}),
        });
        return shapeResponse(response, shape);
      },
    }),
  ],
});
