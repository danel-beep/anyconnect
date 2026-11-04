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
  id: 'tracker',
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

## Метаданные действия

Кроме `name`, `description`, `input` и `run` у действия есть поля, по которым хаб решает, как его
показывать, проверять и исполнять.

| Поле | Зачем | По умолчанию |
| --- | --- | --- |
| `hints` | Подсказки MCP-клиентам (`readOnly`, `destructive`, `idempotent`, `openWorld`) | — |
| `risk` | `read` / `write` / `dangerous`: для политики доступа, подтверждений и журнала | `read`, если `hints.readOnly`; `dangerous`, если `hints.destructive`; иначе `write` |
| `assessRisk(input, ctx)` | Повысить риск конкретного вызова, например первое сообщение новому собеседнику → `dangerous` с причиной. Понизить нельзя; если проверка упала, вызов считается `dangerous` | — |
| `undo` | Как отменить: `{ kind: 'action', action: 'delete_message' }`, `{ kind: 'delay', seconds: 10 }` (окно отмены) или `{ kind: 'none' }` | не указано |
| `capability` | Какую общую операцию реализует действие (`'mail.search'`, можно массив и `{ id, mapInput, mapOutput }`) | — |
| `response.fields` | Поля результата, которые ИИ может выбрать аргументом `fields` (хаб добавит его сам) | аргумента нет |
| `response.maxTokens` | Свой бюджет размера ответа | `TOOL_RESULT_MAX_TOKENS` (2000) |
| `rateLimit` | Лимит на аккаунт для действия `{ requests, perSeconds }`; у коннектора — общий лимит на аккаунт | — |

Правила, которые проверяет реестр при старте:

- имена входов `account` и `fields` зарезервированы хабом;
- id коннектора не может совпадать с именем общего интерфейса (`mail`, `messages`, `calendar`,
  `files`, `tasks`, `contacts`) и со служебными (`anyconnect`, `hub`, `mcp`);
- `undo.action` должен существовать в том же коннекторе;
- читающее действие может реализовать только читающую возможность, пишущее — только пишущую;
- одну возможность в коннекторе реализует одно действие.

Указывайте `risk` явно у всех пишущих действий. Без него запись считается `write`, но в MCP
уходит `destructiveHint: true` (осторожное значение по спецификации), и клиенты будут чаще
спрашивать пользователя.

## Общие интерфейсы (capabilities)

Описаны в `src/connectors/capabilities.ts`: вход и выход каждой операции заданы zod-схемами.

| Интерфейс | Операции |
| --- | --- |
| `messages` | `search`, `list_chats`, `read_chat`, `send` |
| `mail` | `search`, `read`, `send` |
| `calendar` | `list_events`, `create_event` |
| `files` | `search`, `read` |
| `tasks` | `list`, `create` |
| `contacts` | `search` |

Действие получает каноничный вход (или результат `mapInput`), а возвращает каноничный выход:
для списочных операций — массив элементов или `{ items, nextCursor }`, для одиночных — объект
(или результат `mapOutput`). Поля, которых нет в схеме, в едином виде отбрасываются, поэтому
родной результат действия может быть богаче. Хаб собирает из этого единые инструменты
(`messages_search` по всем мессенджерам и ящикам сразу).

Новая операция добавляется в `CAPABILITIES` и сразу доступна всем коннекторам; менять ядро не
нужно.

## Компактные ответы

Каждый токен ответа отнимает контекст у задачи. В SDK есть помощники:

- `htmlToText(html, { maxLength })` — письма и rich text в читаемый текст, ссылки как
  `текст (url)`;
- `truncateText(text, max)` — обрезка по слову с пометкой «ещё N символов»;
- `pickFields(value, fields)` — только нужные поля (пути через точку, `id` сохраняется всегда);
- `page(items, { nextCursor, total })`, `encodeCursor` / `decodeCursor` — постраничная выдача с
  непрозрачным курсором;
- `compact(value)` — без пустых значений.

Хаб дополнительно применяет к каждому ответу бюджет размера: убирает пустые поля, сокращает
длинные строки, оставляет столько элементов списка, сколько помещается, и добавляет пометку
`truncated` с подсказкой, как сузить запрос. JSON отдаётся без отступов.

## Ошибки

Бросайте `ConnectorError(kind, message, { retryAfterSeconds })`. `auth` помечает аккаунт как
требующий переподключения. `rate_limited` и `upstream` у идемпотентных действий хаб сам
повторяет с паузой (до 5 секунд), у неидемпотентных — никогда, чтобы не сделать запись дважды.
