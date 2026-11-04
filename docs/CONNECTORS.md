# Как писать коннекторы

Коннектор описывает один *сервис*. Хаб хранит сколько угодно аккаунтов этого сервиса, превращает
действия в MCP-инструменты, шифрует ключи, ведёт журнал. Есть три способа добавить сервис:

| Способ | Когда | Где |
| --- | --- | --- |
| HTTP-манифест | REST/JSON API (большинство сервисов) | `defineManifestConnector({...})` |
| Код | Нестандартный протокол (IMAP, SMTP), сложная логика | `defineConnector({...})` |
| Внешний MCP | У сервиса уже есть удалённый MCP-сервер | см. этап «внешний MCP» |

Новый встроенный коннектор регистрируется в `src/connectors/index.ts`.

## Что коннектор получает в контексте

| Поле | Что это |
| --- | --- |
| `ctx.account` | Какой аккаунт обслуживается (`id`, `name`, `label`, `identity`). |
| `ctx.config`, `ctx.credentials` | Настройки и расшифрованные ключи этого аккаунта, уже проверенные схемой. |
| `ctx.fetch` | Единственный разрешённый HTTP-транспорт. Хаб подставляет транспорт с сетевой политикой, тесты подставляют фикстуры. Глобальный `fetch` в коннекторах не используем. |
| `ctx.network.lookup` | DNS-lookup с той же политикой для библиотек на сокетах (`net`, `tls`, `imapflow`, `nodemailer`, `pg`). Для хоста-IP перед подключением вызвать `ctx.network.assertHostAllowed(host)`: библиотеки не зовут `lookup` для IP-адресов. |
| `ctx.oauth` | Для OAuth-сервисов: свежий `accessToken` (хаб обновляет его сам), `refresh()` для повтора после 401, `extra` (несекретные поля ответа, например команда Slack). |
| `ctx.signal` | Отмена вызова клиентом или таймаут. Передавать во все запросы. |

**Сетевая политика.** В облаке коннекторы не могут ходить на приватные адреса (метаданные облака,
база, внутренние сервисы). Проверка идёт в момент соединения, поэтому её не обходят ни редиректы,
ни DNS-rebinding, ни IP в адресе. `ALLOW_PRIVATE_NETWORK=true` снимает ограничение (локальная
разработка, сервисы в домашней сети); в облаке не включать.

## HTTP-клиент

`new HttpClient(ctx, { baseUrl, headers, errorMessagePaths, rateLimit })` из
`src/connectors/http/client.ts` — общий клиент для кодовых коннекторов и движка манифестов:

- ходит через `ctx.fetch` с `ctx.signal`, добавляет OAuth-токен и при 401 один раз обновляет его;
- ошибки сервиса превращает в `ConnectorError`: 401 → `auth` (аккаунт помечается «переподключить»),
  403 → `permission`, 404 → `not_found`, 429 → `rate_limited` с `Retry-After`, прочие 4xx →
  `invalid_input`, 5xx → `upstream`; текст ошибки берётся из ответа сервиса (HTML-страницы ИИ не
  показываются);
- повторяет идемпотентные запросы один раз при 502/503/504 и сетевых сбоях, короткие 429 пережидает;
- лимит частоты на аккаунт (token bucket): короткое ожидание поглощается, длинное возвращается ИИ
  как «повторите через N секунд».

## HTTP-манифест

Манифест — обычные данные (JSON-совместимые), поэтому тот же формат пойдёт для сервисов без кода
из базы, коннекторов из OpenAPI (этап 4) и составных инструментов. Схема: `src/connectors/manifest/schema.ts`.

```ts
import { defineManifestConnector } from '../manifest/compile.js';

export default defineManifestConnector({
  id: 'tasks',
  name: 'Tasks',
  description: 'Трекер задач',
  baseUrl: 'https://{{config.region}}.tasks.example/api/v1',
  config: { type: 'object', properties: { region: { type: 'string', default: 'eu' } } },
  auth: { type: 'api_key', in: 'header', name: 'X-Api-Key' }, // ключ: credentials.apiKey
  headers: { 'X-Api-Version': '2026-01' },
  rateLimit: { requests: 50, perSeconds: 60 },
  errorMessagePaths: ['error.detail'],
  pagination: { type: 'cursor', param: 'after', nextPath: 'meta.next' },
  test: { request: { method: 'GET', path: '/me' }, identity: '{{response.email}}' },
  actions: [
    {
      name: 'list_tasks',
      description: 'Lists tasks of a project.',
      input: {
        type: 'object',
        properties: { project_id: { type: 'string', description: 'Project id' } },
        required: ['project_id'],
      },
      hints: { readOnly: true },
      request: { method: 'GET', path: '/projects/{project_id}/tasks' },
      response: { root: 'data', fields: ['id', 'title', 'due.date'] },
      pagination: true,
    },
  ],
});
```

### Авторизация (`auth`)

| `type` | Что делает | Ключи по умолчанию |
| --- | --- | --- |
| `none` | Без авторизации | — |
| `api_key` | Ключ в заголовке или query (`in`, `name`, `value`) | `credentials.apiKey` |
| `bearer` | `Authorization: Bearer …` (`token`) | `credentials.token` |
| `basic` | `username` / `password` — шаблоны | задать `credentials` |
| `oauth2` | `provider` (id из реестра или описание), `scopes`; хаб проводит OAuth и обновляет токены | — |

### Шаблоны

`{{input.x}}`, `{{config.x}}`, `{{credentials.x}}`, `{{account.name}}`, в `test.identity` —
`{{response.x}}`. Строка из одного шаблона сохраняет тип значения (число остаётся числом);
отсутствующее значение убирает ключ целиком. Выполнения кода нет, только пути через точку.

### Запрос

- `path`: сегменты `{field}` берутся из входа и URL-кодируются.
- `query` и `body` — шаблоны. Если не заданы: у GET/DELETE остальные поля входа идут в query,
  у POST/PUT/PATCH — в тело. В запрос попадают только поля, объявленные во входной схеме.
- `bodyType`: `json` (по умолчанию) или `form`.

### Ответ

`root` — какую часть ответа вернуть, `fields` — какие поля оставить (у объекта или каждого
элемента массива): ИИ не платит токенами за лишнее. `empty` — текст для пустого ответа (204).

### Пагинация

Действие с `pagination` (или `pagination: true` — взять общую из манифеста) получает аргумент
`cursor` и возвращает `{ items, nextCursor }`: ИИ запрашивает следующую страницу, только когда она
нужна. Варианты: `cursor` (курсор из ответа), `page` (номер страницы), `offset` (смещение/лимит),
`link` (заголовок `Link: rel="next"`), `next_url` (URL следующей страницы в ответе). Курсор
непрозрачный; URL-курсоры принимаются только на домене API, так что подделанный курсор не уведёт
ключи аккаунта на чужой сервер.

Ошибки в манифесте (параметр пути не объявлен во входе, `pagination: true` без общей пагинации,
неверное имя действия, вход `account`) обнаруживаются при регистрации коннектора, а не при вызове.

## OAuth-провайдеры

Провайдер — это сервер авторизации: адреса authorize/token/revoke, PKCE, способ аутентификации
клиента, разделитель scopes, особенности (`tokenPath` у Slack, `access_type=offline` у Google).
Реестр — `src/connectors/oauth/providers.ts`: `google`, `microsoft`, `slack`, `notion`, `github`,
`todoist`. Коннектор только ссылается на провайдера и перечисляет свои scopes:

```ts
oauth: { provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.modify'] }
```

Так одно OAuth-приложение Google обслуживает Gmail, Календарь и Диск. Новый провайдер — одна
запись в реестре.
