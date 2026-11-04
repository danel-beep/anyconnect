# AnyConnect

Один облачный MCP-хаб для всех ваших сервисов и аккаунтов. Подключаете хаб к ChatGPT, Claude
или другому ИИ-клиенту один раз, а дальше ИИ видит всё, что подключено к хабу, в том числе
сервисы без своего MCP и **несколько аккаунтов одного сервиса** (две почты, два Telegram и т.д.).

```
ChatGPT / Claude / Claude Code / Cursor
            │  MCP по HTTPS + OAuth 2.1
            ▼
   ┌───────────────────── AnyConnect ─────────────────────┐
   │  OAuth-сервер · MCP-эндпоинт · каталог инструментов   │
   │  коннекторы:  gmail(work, personal) · telegram(main,  │
   │               shop) · любой API · любой MCP ...        │
   │  Postgres: аккаунты, зашифрованные ключи, аудит        │
   └───────────────────────────────────────────────────────┘
```

## Что уже есть (этап 1: фундамент)

- **Удалённый MCP-сервер** (`/mcp`) на официальном SDK v2: спецификация 2026-07-28 и
  обратная совместимость с клиентами 2025 года (сегодняшние Claude и ChatGPT). Работает без
  состояния, поэтому деплой не обрывает подключения и можно запускать несколько инстансов.
- **Свой OAuth 2.1 сервер** под требования Claude и ChatGPT: PKCE (S256), Client ID Metadata
  Documents и Dynamic Client Registration, RFC 8707 (токены привязаны к адресу хаба), RFC 9207
  (`iss`), ротация refresh-токенов с обнаружением повторного использования, отзыв доступа.
- **Мультиаккаунтность в основе модели данных**: сервис → много именованных аккаунтов. ИИ видит
  инструмент `gmail_search` с аргументом `account: "work" | "personal"` (или, по настройке,
  отдельные инструменты на каждый аккаунт).
- **Подключаемые коннекторы**: новый сервис = один файл с zod-схемами. Хаб сам делает
  маршрутизацию по аккаунтам, шифрование, таймауты, ошибки и аудит.
- **Шифрование ключей** сервисов (AES-256-GCM, ключ только в переменной окружения, ротация ключа).
- Страницы входа и согласия (RU/EN), главная страница с адресом MCP и списком подключений,
  REST API `/api/v1`, CLI, личные токены для клиентов со статическими заголовками.
- Встроенный тестовый сервис **Demo** с двумя аккаунтами, чтобы сразу проверить подключение.
- Docker, Render Blueprint, CI (lint, типы, 46 тестов включая сквозной OAuth через официальный
  MCP-клиент, сборка Docker).

Дальше по плану: почта (Gmail OAuth + IMAP/SMTP) и Telegram → веб-панель → подключение любого
API без программирования (по OpenAPI).

## Быстрый старт локально

Нужны Node.js 22+ и Postgres (проще всего через Docker).

```bash
npm install
docker compose up -d db
cp .env.example .env        # задайте ADMIN_EMAIL и ADMIN_PASSWORD
npm run dev
```

Откройте http://localhost:3000, войдите. На главной странице будет адрес MCP-сервера.
Для локальной проверки с Claude Code:

```bash
claude mcp add --transport http anyconnect http://localhost:3000/mcp
```

Claude Code откроет браузер для входа и согласия, после чего увидит инструменты `demo_*`.

## Деплой на Render

1. В Render: **New → Blueprint**, выберите этот репозиторий. Blueprint (`render.yaml`) создаст
   веб-сервис (Docker, план Starter, Франкфурт) и Postgres.
2. Укажите `ADMIN_EMAIL` и `ADMIN_PASSWORD` (пароль от 12 символов).
3. `ENCRYPTION_KEY` сгенерируется сам. **Сохраните его копию**: без него сохранённые ключи
   сервисов не расшифровать.
4. После деплоя адрес будет вида `https://anyconnect-xxxx.onrender.com`. `PUBLIC_URL` указывать
   не нужно: хаб берёт `RENDER_EXTERNAL_URL`. Для своего домена задайте `PUBLIC_URL`.

Бесплатный план Render засыпает через 15 минут простоя, а ИИ-клиенты не ждут холодный старт,
поэтому в Blueprint стоит Starter. Хаб работает и на любой другой платформе с Docker и Postgres.

## Подключение ИИ-клиентов

Адрес MCP: `https://<ваш-хаб>/mcp`. При подключении клиент откроет страницу входа в хаб и
страницу согласия, где видно, какое приложение просит доступ и куда вы вернётесь.

| Клиент | Как подключить |
| --- | --- |
| Claude (web, desktop, mobile) | Настройки → Коннекторы → Добавить свой коннектор → адрес MCP |
| ChatGPT | Настройки → Приложения и коннекторы → Расширенные → Режим разработчика → Создать, аутентификация OAuth |
| Claude Code | `claude mcp add --transport http anyconnect https://<хаб>/mcp` |
| Скрипты, клиенты со статическим заголовком | личный токен: `Authorization: Bearer ac_pat_...` |

Подключённые приложения видны на главной странице хаба, доступ можно отозвать одной кнопкой.

## Управление аккаунтами (до веб-панели)

CLI выбирает пользователя из `ADMIN_EMAIL`. Локально: `npm run cli -- <команда>`, в Shell на
Render (в собранном образе): `node dist/cli/index.js <команда>`.

```bash
npm run cli -- connectors:list
npm run cli -- accounts:add --connector demo --label "Третий аккаунт" --credentials '{"secret":"x"}'
npm run cli -- accounts:list
npm run cli -- tools:list                      # что именно видит ИИ
npm run cli -- exposure:set --mode per_account # отдельный инструмент на каждый аккаунт
npm run cli -- tokens:create --name "laptop"   # личный токен для REST API / MCP
```

REST API (`Authorization: Bearer ac_pat_...`):

| Метод | Путь | Что делает |
| --- | --- | --- |
| GET | `/api/v1/connectors` | сервисы и JSON-схемы их настроек и ключей |
| GET/POST | `/api/v1/accounts` | список / добавить аккаунт (ключи шифруются, наружу не отдаются) |
| GET/PATCH/DELETE | `/api/v1/accounts/:id` | аккаунт: переименовать, выключить, скрыть действия, сменить ключи |
| POST | `/api/v1/accounts/:id/test` | проверить подключение |
| POST | `/api/v1/connect` | начать подключение аккаунта через OAuth, ответ — `authorizationUrl` |
| GET | `/api/v1/oauth/providers` | OAuth-провайдеры, redirect URI для их консолей, настроенные приложения |
| GET/POST/DELETE | `/api/v1/oauth/apps[/:id]` | свои OAuth-приложения (client id + secret) |
| GET/POST/DELETE | `/api/v1/services[/:id]` | свои сервисы без кода: внешние MCP-серверы и HTTP-манифесты |
| POST | `/api/v1/services/:id/refresh` | обновить список инструментов внешнего MCP-сервера |
| GET | `/api/v1/tools` | инструменты так, как их видит ИИ |
| POST | `/api/v1/tools/:name/call` | вызвать инструмент (для отладки) |
| GET/DELETE | `/api/v1/grants[/:id]` | подключённые ИИ-приложения |
| GET/POST/DELETE | `/api/v1/tokens[/:id]` | личные токены |
| GET | `/api/v1/tool-calls` | журнал вызовов |
| PATCH | `/api/v1/workspace` | настройки, например `{"settings":{"toolExposure":"per_account"}}` |

### Подключение через OAuth (Google, Microsoft, Slack, Notion, GitHub, Todoist…)

1. Зарегистрируйте OAuth-приложение у провайдера с redirect URI `https://<хаб>/connect/callback`
   (один адрес на все сервисы; точный адрес — в `GET /api/v1/oauth/providers`).
2. Передайте его хабу: переменными окружения `OAUTH_APP_GOOGLE_CLIENT_ID` /
   `OAUTH_APP_GOOGLE_CLIENT_SECRET` (для всего хаба) или через `POST /api/v1/oauth/apps`
   (своё приложение в пространстве, секрет шифруется).
3. Откройте в браузере `https://<хаб>/connect/<сервис>?label=Рабочая` и разрешите доступ. Аккаунт
   появится с адресом почты из проверки подключения. Повторное подключение того же аккаунта:
   `/connect/<сервис>?account=<id>`.

Дальше хаб сам обновляет токены (заранее, фоновой задачей, и при ответе 401), а если провайдер
отозвал доступ, помечает аккаунт «нужно переподключить». Сервисы, где можно обойтись личным токеном
(GitHub, Todoist, Notion, Slack), принимают его в `credentials.token` без OAuth-приложения.

## Как добавить сервис

### Внешний MCP-сервер без кода

```bash
curl -X POST https://<хаб>/api/v1/services -H "authorization: Bearer ac_pat_..." \
  -H "content-type: application/json" \
  -d '{"kind":"mcp","url":"https://mcp.linear.app/mcp","name":"Linear","id":"linear"}'
```

Хаб сам найдёт OAuth сервера и зарегистрируется у него как клиент; затем откройте
`https://<хаб>/connect/linear` и войдите. Инструменты сервера появятся у ИИ как `linear_…` с
выбором аккаунта. Сервер со статическим ключом: `"auth":"bearer"` и аккаунт с
`credentials.token`.

### Свой коннектор

Подробное руководство — [docs/CONNECTORS.md](docs/CONNECTORS.md). REST-сервисы проще всего
описывать HTTP-манифестом, без кода. Кодовый коннектор описывает сервис и его действия; про MCP,
аккаунты, шифрование и сеть он не знает:

```ts
// src/connectors/builtin/weather.ts
import { z } from 'zod';
import { HttpClient } from '../http/client.js';
import { defineConnector } from '../sdk.js';

export default defineConnector({
  id: 'weather',
  name: 'Weather',
  description: 'Weather forecasts',
  version: '1.0.0',
  credentials: z.object({ apiKey: z.string().describe('API key from the weather provider') }),
  actions: (action) => [
    action({
      name: 'forecast',
      description: 'Forecast for a city for the next days',
      input: z.object({ city: z.string().describe('City name') }),
      hints: { readOnly: true },
      run: async ({ city }, ctx) => {
        // ctx.fetch: сетевая политика хаба; HttpClient сам превращает 401/404/429 в ошибки хаба.
        const api = new HttpClient(ctx, {
          baseUrl: 'https://api.example',
          headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
        });
        return (await api.get('/forecast', { q: city })).data;
      },
    }),
  ],
});
```

Затем зарегистрируйте его в `src/connectors/index.ts`. ИИ сразу получит `weather_forecast`
с выбором аккаунта.

## Разработка

```bash
npm run check        # lint + типы + тесты
npm test             # нужен Postgres: TEST_DATABASE_URL (по умолчанию postgres://postgres@localhost:5432/anyconnect_test)
npm run db:generate  # после изменения src/db/schema.ts — создать миграцию
```

Подробно об устройстве: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Безопасность

- Секреты только в переменных окружения, в репозитории их нет. `.env` в `.gitignore`.
- Ключи сервисов зашифрованы AES-256-GCM и привязаны к аккаунту (скопировать шифротекст в
  другую строку не получится). Через API и ИИ они не возвращаются.
- Токены (OAuth, личные, сессии) хранятся только как SHA-256-хэши.
- Страница согласия защищена от встраивания во фрейм, формы — CSRF-токеном и проверкой Origin,
  вход — ограничением попыток. Загрузка внешних метаданных клиентов защищена от SSRF.
- Ошибки коннекторов не раскрывают внутренние детали ИИ-клиенту; аргументы вызовов не логируются.
