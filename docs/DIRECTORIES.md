# Manyplug в каталогах ИИ-приложений

Цель: чтобы Manyplug находили и подключали в один клик из Claude, ChatGPT, Cursor, VS Code и
реестров MCP. Здесь: что требует каждый каталог, что уже сделано в коде, что подано и что остаётся
владельцу. Требования проверены 4–5 ноября 2026 года.

## Что есть в коде

| Требование каталогов | Где |
| --- | --- |
| У каждого инструмента `title` и явные `readOnlyHint`, `destructiveHint`, `openWorldHint` | `annotationsFor` в `src/hub/catalog.ts` |
| Автопроверка инструментов: имена, аннотации, описания без prompt-injection, нет «универсального HTTP-инструмента» | `src/hub/directory-lint.ts`, тест проходит по всем встроенным сервисам |
| Нет инструментов, которые запрещены правилами каталога (переводы денег, продажи, тестовые) | `tags` у действий + `src/hub/client-policies.ts`, переменная `CLIENT_POLICIES` |
| OAuth 2.1: PKCE S256, CIMD + DCR, `token_endpoint_auth_method: none`, ротация refresh, `invalid_grant`, 401 с `resource_metadata`, loopback-redirect без порта | `src/oauth/`, уже было |
| Политика конфиденциальности, условия, поддержка | `/privacy`, `/terms`, `/support` |
| Иконки | `/icon.svg`, `/icon-48.png`, `/icon-96.png`, `/icon-192.png`, `/icon-512.png` (рисуются кодом, `src/web/brand-raster.ts`) |
| Иконка и сайт в `serverInfo` MCP | `src/mcp/handler.ts` |
| Карточка сервера для сканеров (Smithery и др.) | `/.well-known/mcp/server-card.json` |
| Подтверждение владения доменом | `/.well-known/<имя>` из переменных `WELL_KNOWN_<ИМЯ>` |
| Аккаунт для ревьюеров | `REVIEW_ACCOUNT_EMAIL` / `REVIEW_ACCOUNT_PASSWORD` |
| Файлы каталогов из одного источника | `src/distribution/listing.ts` → `npm run distribution` |

### Тексты и файлы каталогов

Название, описания, категории, примеры запросов и сценарии для ревьюеров лежат в
`src/distribution/listing.ts`. Длины проверяются тестом по самым строгим лимитам. Из них
`npm run distribution` собирает:

- `server.json` — запись в официальном MCP Registry (`com.manyplug/manyplug`);
- `glama.json` — сопровождающие для Glama;
- `.claude-plugin/marketplace.json` и `integrations/claude/` — плагин Claude Code и каталога плагинов Claude;
- `.cursor-plugin/marketplace.json` и `integrations/cursor/` — плагин Cursor;
- `integrations/openai/` — плагин для ChatGPT и Codex (папку упаковать в ZIP);
- `integrations/assets/` — иконки для форм.

Руками эти файлы не править: тест упадёт, пока они не совпадают с `listing.ts`.

### Правила каталогов для клиентов (`CLIENT_POLICIES`)

Хаб узнаёт приложение по хосту, который оно контролирует (CIMD `https://claude.ai/...` или redirect
`https://chatgpt.com/...`), и убирает из его каталога то, что запрещают правила его каталога:

| Правило | Кому | Что убирается |
| --- | --- | --- |
| `claude` | Claude, Claude Code | `moves_money` (возвраты Stripe), `generates_media`, `test_only` (`demo_fail`) |
| `chatgpt` | ChatGPT | `moves_money`, `commerce` (тарифы и покупки), `test_only`; нет `manyplug_call_tool`, `call_tools`, `search_tools`, `describe_tool`, список всегда полный |

По умолчанию включено только `claude`. `chatgpt` включить (`CLIENT_POLICIES=claude,chatgpt`)
перед подачей в ChatGPT: без поиска инструментов большой набор сервисов занимает больше контекста.
Новый каталог со своими правилами — ещё одна запись в `CLIENT_POLICIES`, новое ограничение — ещё
один тег в `ACTION_TAGS` (`src/connectors/sdk.ts`).

## Официальный MCP Registry

Имя `com.manyplug/manyplug`, вход по HTTP: хаб отдаёт открытый ключ на
`https://manyplug.com/.well-known/mcp-registry-auth` (переменная `WELL_KNOWN_MCP_REGISTRY_AUTH`),
скрипт подписывает закрытым. Из реестра записи забирают VS Code, GitHub MCP Registry, PulseMCP,
Glama и другие агрегаторы.

Новая версия (после смены `version` в `package.json` и `npm run distribution`):

```bash
node scripts/mcp-registry.mjs keygen      # если закрытого ключа нет: новая пара
# первую строку — в переменные Render (WELL_KNOWN_MCP_REGISTRY_AUTH), дождаться деплоя
MCP_REGISTRY_PRIVATE_KEY=<hex> node scripts/mcp-registry.mjs publish
```

Ключ можно менять сколько угодно: реестр сверяет подпись с тем, что сейчас отдаёт сайт. Если
положить ключ в секрет репозитория `MCP_REGISTRY_PRIVATE_KEY`, workflow `MCP Registry` публикует
сам при каждом изменении `server.json` в `main`.

## Каталоги и что нужно от владельца

### Каталог коннекторов Claude

Подача: [claude.ai/directory/manage](https://claude.ai/directory/manage) → Submit new → MCP
connector. Нужен любой платный план Claude. Требования:
[submission](https://claude.com/docs/connectors/building/submission),
[review criteria](https://claude.com/docs/connectors/building/review-criteria).

- Адрес: `https://manyplug.com/mcp`, Universal URL.
- Authentication: OAuth, «Always required». Клиент не вводить: Claude сам выберет CIMD (хаб его
  объявляет). Redirect `https://claude.ai/api/mcp/auth_callback` и loopback уже принимаются.
- Listing: тексты из `listing.ts` (name, oneLiner, description, categories), docs
  `https://manyplug.com/docs`, privacy `https://manyplug.com/privacy`, support
  `https://manyplug.com/support`, иконка `integrations/assets/icon-512.png`.
- Data handling: API подключаемых сервисов — сторонние (Gmail, Slack...), Manyplug обращается к ним
  от имени пользователя по его OAuth. Это главный риск отказа: требование «own first-party APIs or
  APIs you legitimately proxy». Отвечать честно; при отказе — уточнить у `mcp-review@anthropic.com`.
- Test & launch: вход ревьюера (`REVIEW_ACCOUNT_*`), сценарии из `LISTING.review`.
- Плагин (Claude Code + Cowork): там же, Submit new → Plugin, репозиторий с
  `.claude-plugin/marketplace.json`. Уже работает без подачи:
  `/plugin marketplace add danel-beep/anyconnect`.

### ChatGPT (OpenAI)

Подача: OpenAI Platform → Apps / Plugins, ZIP папки `integrations/openai`. Нужна верификация
организации или физлица в OpenAI. Требования:
[submission](https://developers.openai.com/apps-sdk/deploy/submission),
[guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines).

- Домен: токен из формы → переменная `WELL_KNOWN_OPENAI_APPS_CHALLENGE` (отдаётся на
  `/.well-known/openai-apps-challenge`).
- Перед подачей `CLIENT_POLICIES=claude,chatgpt`.
- Видео-демо (обязательно): запись экрана, где ChatGPT выполняет сценарии из `LISTING.review`.
- Риски отказа: правило «unofficial connectors to third-party services» и запрет на регистрацию
  отдельного аккаунта внутри сценария. Путь без каталога работает уже сейчас: режим разработчика
  ChatGPT и адрес `https://manyplug.com/mcp`.

### Cursor Marketplace

Подача: [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish), ссылка на
репозиторий (должен быть публичным; плагин — `integrations/cursor`, корень —
`.cursor-plugin/marketplace.json`). Нужен вход в Cursor.

### VS Code и GitHub MCP Registry

Галерея VS Code берёт серверы из GitHub MCP Registry, а он — из официального реестра после
ручного отбора. Попросить включить: обсуждение в
[github/github-mcp-server](https://github.com/github/github-mcp-server/discussions) (нужен вход в
GitHub). Без галереи уже работает кнопка на `/docs` (`vscode:mcp/install`).

### Smithery

[smithery.ai/new](https://smithery.ai/new) → адрес `https://manyplug.com/mcp`. Нужен вход. Сканер
войдёт по OAuth или прочитает `/.well-known/mcp/server-card.json`.

### Glama, PulseMCP, mcp.so

Glama и PulseMCP подтягивают записи из официального реестра сами; `glama.json` даёт право заявить
сервер аккаунтом GitHub `danel-beep`. mcp.so — форма на сайте, нужен вход.
