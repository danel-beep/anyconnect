# Встроенные сервисы

Двенадцать коннекторов идут в коробке. У каждого может быть сколько угодно аккаунтов: две почты
Gmail, рабочий и личный Outlook, пять ящиков на Яндексе. ИИ видит один набор инструментов на сервис
и выбирает аккаунт аргументом `account` (или, по настройке пространства, видит отдельные инструменты
на каждый аккаунт).

| Сервис | id | Как подключить | Что умеет |
| --- | --- | --- | --- |
| Почта IMAP/SMTP | `imap` | адрес + пароль приложения | папки, поиск, чтение, отправка, ответ, пересылка, перенос, флаги |
| Gmail | `gmail` | OAuth Google | поиск в синтаксисе Gmail, чтение, отправка, ответ в цепочке, пересылка, черновики, ярлыки, архив, корзина |
| Outlook / Microsoft 365 | `outlook` | OAuth Microsoft | почта (как у Gmail) и календарь: события, приглашения, Teams-ссылки, отмена встреч |
| Google Calendar | `gcal` | OAuth Google | календари, события в диапазоне, создание по фразе, изменение, удаление, занятость |
| Google Drive | `gdrive` | OAuth Google | поиск файлов, чтение Docs/Sheets/Slides и текстовых файлов, создание, переименование, перенос, корзина |
| Slack | `slack` | OAuth Slack или токен `xoxp-`/`xoxb-` | поиск сообщений, каналы, чтение канала и треда, отправка, поиск людей |
| Notion | `notion` | OAuth Notion или токен интеграции | поиск, чтение страниц в Markdown, запросы к базам, создание и изменение страниц |
| GitHub | `github` | OAuth GitHub или личный токен | задачи и PR: поиск, чтение, создание, комментарии; репозитории; уведомления |
| Todoist | `todoist` | OAuth Todoist или API-токен | задачи по фильтрам Todoist, проекты, добавление, изменение, выполнение |
| Stripe | `stripe` | секретный или ограниченный ключ | баланс, поиск клиентов, платежей и счетов, подписки, возвраты |
| Любой HTTP API | `http` | базовый адрес + способ авторизации | GET и запросы с телом в пределах базового адреса |
| Demo | `demo` | ничего | тестовый сервис, чтобы проверить подключение ИИ |

Как добавить аккаунт: через OAuth — `https://<хаб>/connect/<id>?label=Рабочая` (подробно в
README, раздел «Подключение через OAuth»), с ключом — `POST /api/v1/accounts` или CLI:

```bash
npm run cli -- accounts:add --connector imap --label "Яндекс" \
  --config '{"email":"me@yandex.ru"}' --credentials '{"password":"пароль приложения"}'
```

Схемы настроек (`config`) и ключей (`credentials`) каждого сервиса отдаёт `GET /api/v1/connectors`.

## Почта IMAP/SMTP

Подходит для любого почтового сервера. Для Gmail, Яндекса, Mail.ru, iCloud, Outlook.com и Fastmail
серверы подставляются сами по адресу почты (`provider` можно указать явно), для остальных
`provider: "custom"` и `imapHost` / `smtpHost` (порты и шифрование по умолчанию 993/TLS и 465/TLS).

- Нужен **пароль приложения**, а не основной пароль: Яндекс — «Управление аккаунтом → Безопасность →
  Пароли приложений» (и включить IMAP в настройках почты); Mail.ru — «Безопасность → Пароли для
  внешних приложений»; Gmail — пароль приложения при включённой двухэтапной проверке; iCloud —
  appleid.apple.com → «Пароли приложений».
- Отправленные письма сохраняются в «Отправленные» (`saveSentCopy`), кроме Gmail и Outlook.com,
  которые делают это сами.
- Идентификатор письма — `папка:uid`; он меняется при переносе в другую папку.
- Соединение IMAP держится минуту после последнего вызова и переиспользуется.
- `allowInvalidCertificate` — только для своего сервера с самоподписанным сертификатом.
- Серверы во внутренней сети недоступны, пока хаб не запущен с `ALLOW_PRIVATE_NETWORK=true`.

## Google: Gmail, Calendar, Drive

Одно OAuth-приложение Google на все три сервиса (каждый спрашивает только свои права).

1. В [Google Cloud Console](https://console.cloud.google.com/apis/credentials) создайте проект и
   включите Gmail API, Google Calendar API и Google Drive API.
2. «OAuth consent screen»: тип External; пока приложение в статусе Testing, добавьте свои адреса в
   Test users. В Testing refresh-токен живёт 7 дней; для постоянной работы переведите приложение в
   Production (для личного использования проверка Google не обязательна, будет предупреждение на
   экране согласия).
3. «Credentials → Create credentials → OAuth client ID», тип Web application, Authorized redirect
   URI `https://<хаб>/connect/callback`.
4. `OAUTH_APP_GOOGLE_CLIENT_ID` и `OAUTH_APP_GOOGLE_CLIENT_SECRET` в переменные окружения хаба.

Права: Gmail — `gmail.modify` (чтение, отправка, ярлыки; без безвозвратного удаления), Calendar —
`calendar`, Drive — `drive`.

- **Gmail**: поиск принимает синтаксис Gmail (`from:bank is:unread newer_than:7d`). Ответ уходит в
  ту же цепочку, пересылка прикладывает оригинал со всеми вложениями.
- **Calendar**: времена в RFC 3339 со смещением (`2026-11-05T15:00:00+03:00`), повторяющиеся
  события разворачиваются в отдельные. Приглашения рассылаются, только если `sendUpdates: "all"`.
- **Drive**: Google Docs и Slides читаются как текст, Sheets — как CSV (первый лист), обычные
  текстовые файлы до 5 МБ — как есть. Удаление — перенос в корзину (восстанавливается 30 дней).

## Microsoft: Outlook

1. В [Microsoft Entra](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
   «New registration»: Supported account types — «Accounts in any organizational directory and
   personal Microsoft accounts», Redirect URI (Web) `https://<хаб>/connect/callback`.
2. «Certificates & secrets → New client secret».
3. `OAUTH_APP_MICROSOFT_CLIENT_ID` и `OAUTH_APP_MICROSOFT_CLIENT_SECRET` в окружение хаба.

Права: `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `MailboxSettings.Read`. В рабочих
аккаунтах организация может требовать согласия администратора.

- Поиск принимает синтаксис Outlook (`from:ann subject:invoice hasattachments:true`). Папки:
  `inbox`, `sent`, `drafts`, `trash`, `junk`, `archive`, `all` или id из `outlook_list_folders`.
- Ответ и пересылка идут штатными средствами Outlook, поэтому письма остаются в одной беседе.
- После переноса письмо получает новый id (действие его возвращает).
- Часовой пояс календаря задаётся в настройках аккаунта (`timeZone`, по умолчанию UTC). Время
  события можно передать со смещением, без смещения (тогда в поясе аккаунта) или датой для
  события на весь день.

## Slack

Через OAuth: приложение на [api.slack.com/apps](https://api.slack.com/apps), в «OAuth &
Permissions» redirect URL `https://<хаб>/connect/callback`, затем `OAUTH_APP_SLACK_CLIENT_ID` /
`_SECRET`. Хаб просит пользовательские права (поиск работает только с пользовательским токеном).

Без OAuth: токен пользователя `xoxp-…` или бота `xoxb-…` в `credentials.token`. Бот не умеет
искать сообщения и видит только каналы, куда его добавили.

Канал можно указать id, `#название` или `@пользователь` (личные сообщения).

## Notion

Проще всего — внутренняя интеграция: [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
→ «New integration», токен в `credentials.token`, затем на нужных страницах «⋯ → Connections →
добавить интеграцию». Интеграция видит только страницы, к которым её подключили.

Через OAuth: публичная интеграция с redirect URI `https://<хаб>/connect/callback` и
`OAUTH_APP_NOTION_CLIENT_ID` / `_SECRET`; страницы выбираются на экране согласия.

Страницы читаются в Markdown, принимаются id и ссылки notion.so. Свойства базы задаются простыми
значениями: `{"Status": "Готово", "Срок": "2026-11-05", "Теги": ["работа"]}`.

## GitHub

Без OAuth: [личный токен](https://github.com/settings/personal-access-tokens) (fine-grained:
доступ к нужным репозиториям, права Issues и Pull requests на чтение и запись, Metadata на чтение;
для уведомлений нужен classic-токен с `notifications`).

Через OAuth: OAuth App на [github.com/settings/developers](https://github.com/settings/developers)
с callback `https://<хаб>/connect/callback` и `OAUTH_APP_GITHUB_CLIENT_ID` / `_SECRET`. Права:
`repo`, `notifications`, `read:user`.

## Todoist

Без OAuth: API-токен из «Настройки → Интеграции → Для разработчиков». Через OAuth: приложение в
[консоли Todoist](https://developer.todoist.com/appconsole.html) с redirect URI
`https://<хаб>/connect/callback`, права `data:read_write,data:delete`.

Поиск задач принимает фильтры Todoist: `today`, `overdue`, `7 days`, `#Работа & p1`, `search: текст`.

## Stripe

Ключ `sk_live_…`/`sk_test_…` или, лучше, ограниченный `rk_…` с правами только на нужное
(Customers, Charges/PaymentIntents, Invoices, Subscriptions — чтение; Refunds — запись, если
нужны возвраты). Отдельный аккаунт на каждый режим или каждую компанию.

## Любой HTTP API

Для сервиса, у которого нет своего коннектора, но есть REST API. В настройках — `baseUrl`
(например `https://api.example.com/v2`), способ авторизации (`none`, `bearer`, `header`, `query`,
`basic`) и постоянные заголовки. ИИ передаёт путь относительно базового адреса: выйти за его
пределы, обратиться к другому хосту или во внутреннюю сеть нельзя. Большие ответы обрезаются по
целым элементам, можно попросить только нужные поля (`select`) или вложенный массив (`root`).

Для постоянного использования сервиса лучше описать его HTTP-манифестом (см.
[CONNECTORS.md](CONNECTORS.md), «Сервисы без кода»): у ИИ будут понятные отдельные инструменты.

## Единые инструменты

Коннекторы реализуют общие интерфейсы хаба, поэтому, когда подключено два сервиса одного рода, ИИ
получает один инструмент на все сразу: например, `mail_search` ищет и в Gmail, и в Outlook, и в
Яндексе.

| Интерфейс | Сервисы |
| --- | --- |
| почта (`mail_search`, `mail_read`, `mail_send`) | IMAP/SMTP, Gmail, Outlook |
| календарь (`calendar_list_events`, `calendar_create_event`) | Google Calendar, Outlook |
| файлы и документы (`files_search`, `files_read`) | Google Drive, Notion |
| задачи (`tasks_list`, `tasks_create`) | Todoist |
| сообщения (`messages_search`, `messages_list_chats`, `messages_read_chat`, `messages_send`) | Slack (дальше Telegram, WhatsApp) |

Ограничения сервисов в едином виде: IMAP ищет в одной папке (по умолчанию «Входящие»), Gmail и
Outlook — во всей почте; Todoist отдаёт только открытые задачи, а проект в `tasks_create` пока не
задаётся (Todoist нужен id проекта, а не название); Slack не сообщает число непрочитанных, поэтому
`unread_only` в списке чатов не работает.

## Проверка и лимиты

- `POST /api/v1/accounts/:id/test` проверяет подключение и записывает, чей это аккаунт (адрес почты,
  логин). Хаб делает это и сам раз в сутки.
- Ошибки сервисов приходят ИИ короткими понятными сообщениями: «нет доступа», «не найдено»,
  «превышен лимит, повторите через N секунд». Истёкший OAuth хаб обновляет сам.
- Длинные письма и документы обрезаются (`maxChars`), в ответе тогда есть `truncated` и полный
  размер, чтобы ИИ мог дочитать.
