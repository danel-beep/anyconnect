import type { Localized } from './types.js';

/**
 * Comparison pages (`/compare/<slug>`). Honest by rule: facts about other products come from their
 * own pages (listed in `sources`, checked on `checked`), a row is left out rather than guessed, and
 * every page says when the other product is the better choice. Prices of other products change
 * often, so pages link to them instead of quoting them. Our own numbers are placeholders filled
 * from the catalogue and the plans when the page renders: `{count}` built-in services, `{from}` the
 * cheapest paid plan.
 */
export interface ComparePage {
  slug: string;
  /** The other side, as people search for it. */
  other: string;
  checked: string;
  body: Localized<CompareBody>;
  sources: { label: string; url: string }[];
}

export interface CompareBody {
  title: string;
  description: string;
  h1: string;
  /** The answer in two or three sentences. */
  summary: string;
  rows: { feature: string; manyplug: string; other: string }[];
  chooseManyplug: string[];
  chooseOther: string[];
  /** How the two work together, if they can. */
  together?: string;
}

export const COMPARE_PAGES: ComparePage[] = [
  {
    slug: 'zapier-mcp',
    other: 'Zapier MCP',
    checked: '2026-11-04',
    sources: [{ label: 'Zapier MCP', url: 'https://zapier.com/mcp' }],
    body: {
      en: {
        title: 'Manyplug vs Zapier MCP: which MCP hub fits you',
        description:
          'Manyplug and Zapier MCP both give Claude, ChatGPT and Cursor one MCP address. Zapier has far more apps; Manyplug focuses on several named accounts per service, approvals for risky actions and per-app rules.',
        h1: 'Manyplug vs Zapier MCP',
        summary:
          'Both are hosted MCP servers that connect AI assistants to your apps through one address. Zapier MCP covers over 9,000 apps and bills each tool call as two tasks of your Zapier plan. Manyplug covers fewer services but is built around several named accounts per service, approvals before risky actions and separate rules for each AI app.',
        rows: [
          {
            feature: 'Apps and services',
            manyplug: '{count} built-in services, plus any remote MCP server and any REST API',
            other: '9,000+ apps (Zapier’s figure)',
          },
          {
            feature: 'How usage is counted',
            manyplug: 'One tool call = one action; free plan with a monthly allowance',
            other: 'Each tool call uses two tasks from your Zapier task quota',
          },
          {
            feature: 'Several accounts of one service',
            manyplug: 'Yes, each with a name; the AI can search one account or all at once',
            other: 'Uses the app connections of your Zapier account',
          },
          {
            feature: 'Approval before risky actions',
            manyplug: 'Sending, deleting and refunds wait for your OK by default',
            other: 'Configured per action in Zapier',
          },
          {
            feature: 'Rules per AI app',
            manyplug: 'Each AI app can be limited to some accounts or to reading only',
            other: 'Per MCP server configuration',
          },
          {
            feature: 'AI clients',
            manyplug:
              'Claude, ChatGPT, Claude Code, Cursor, VS Code, Codex, Gemini CLI, Windsurf and any MCP client',
            other: 'Claude, ChatGPT, Cursor and other MCP clients',
          },
        ],
        chooseManyplug: [
          'You have several mailboxes, workspaces or projects of the same service and want the AI to tell them apart.',
          'You want the AI to ask before it sends, deletes or pays, and different rules for different assistants.',
          'You want simple per-call pricing that does not share a quota with automations.',
        ],
        chooseOther: [
          'You need an app that Manyplug does not have yet: Zapier’s catalogue is far larger.',
          'You already run Zaps and want the AI to use the same connections.',
        ],
        together:
          'They also work together: add your Zapier MCP address in Manyplug as your own MCP server, and its tools get Manyplug’s rules and approvals next to your other accounts.',
      },
      ru: {
        title: 'Manyplug или Zapier MCP: какой MCP-хаб выбрать',
        description:
          'Manyplug и Zapier MCP дают Claude, ChatGPT и Cursor один MCP-адрес. У Zapier намного больше приложений; Manyplug делает ставку на несколько именованных аккаунтов одного сервиса, подтверждение рискованных действий и правила для каждого ИИ.',
        h1: 'Manyplug и Zapier MCP',
        summary:
          'Оба — облачные MCP-серверы, которые подключают ИИ-ассистентов к вашим приложениям через один адрес. Zapier MCP охватывает больше 9000 приложений и списывает каждый вызов инструмента как две задачи вашего тарифа Zapier. В Manyplug сервисов меньше, зато он построен вокруг нескольких именованных аккаунтов одного сервиса, подтверждения перед рискованными действиями и отдельных правил для каждого ИИ-приложения.',
        rows: [
          {
            feature: 'Приложения и сервисы',
            manyplug: 'Встроенных сервисов: {count}, плюс любой удалённый MCP-сервер и любой REST API',
            other: '9000+ приложений (по данным Zapier)',
          },
          {
            feature: 'Как считается использование',
            manyplug: 'Один вызов инструмента — одно действие; бесплатный тариф с месячным лимитом',
            other: 'Каждый вызов инструмента списывает две задачи из лимита Zapier',
          },
          {
            feature: 'Несколько аккаунтов одного сервиса',
            manyplug: 'Да, у каждого своё имя; ИИ ищет в одном аккаунте или сразу во всех',
            other: 'Использует подключения приложений вашего аккаунта Zapier',
          },
          {
            feature: 'Подтверждение рискованных действий',
            manyplug: 'Отправка, удаление и возвраты по умолчанию ждут вашего «да»',
            other: 'Настраивается для каждого действия в Zapier',
          },
          {
            feature: 'Правила для каждого ИИ',
            manyplug: 'Каждому ИИ-приложению можно дать только часть аккаунтов или только чтение',
            other: 'Через настройки MCP-сервера',
          },
          {
            feature: 'ИИ-клиенты',
            manyplug:
              'Claude, ChatGPT, Claude Code, Cursor, VS Code, Codex, Gemini CLI, Windsurf и любой MCP-клиент',
            other: 'Claude, ChatGPT, Cursor и другие MCP-клиенты',
          },
        ],
        chooseManyplug: [
          'У вас несколько ящиков, рабочих пространств или проектов одного сервиса, и ИИ должен их различать.',
          'Нужно, чтобы ИИ спрашивал перед отправкой, удалением или оплатой, и разные правила для разных ассистентов.',
          'Хочется простой цены за вызов, без общего лимита с автоматизациями.',
        ],
        chooseOther: [
          'Нужно приложение, которого в Manyplug пока нет: каталог Zapier намного больше.',
          'У вас уже работают Zap’ы, и ИИ должен пользоваться теми же подключениями.',
        ],
        together:
          'Их можно совместить: добавьте адрес Zapier MCP в Manyplug как свой MCP-сервер, и его инструменты получат правила и подтверждения Manyplug рядом с остальными аккаунтами.',
      },
    },
  },
  {
    slug: 'composio',
    other: 'Composio',
    checked: '2026-11-04',
    sources: [
      { label: 'Composio', url: 'https://composio.dev' },
      { label: 'Composio pricing', url: 'https://composio.dev/pricing' },
    ],
    body: {
      en: {
        title: 'Manyplug vs Composio: MCP for people or for developers',
        description:
          'Composio is a developer platform for giving agents tools through SDKs and an MCP gateway. Manyplug is a ready MCP hub for people who use Claude, ChatGPT and Cursor, with several accounts per service and approvals.',
        h1: 'Manyplug vs Composio',
        summary:
          'Composio is a platform for developers who build AI agents and products: SDKs, managed sign-in for their own users, triggers and an MCP gateway, priced by tool calls. Manyplug is for people who use AI assistants themselves: sign in with Google, connect your accounts and paste one address into Claude, ChatGPT or Cursor, with no code.',
        rows: [
          {
            feature: 'Made for',
            manyplug: 'People and small teams using AI assistants',
            other: 'Developers building agents and AI products',
          },
          {
            feature: 'Setup',
            manyplug: 'Website or chat, no code',
            other: 'SDKs and APIs, plus an MCP gateway',
          },
          {
            feature: 'Several accounts of one service',
            manyplug: 'Yes, named accounts; the AI can use one or all at once',
            other: 'Connected accounts per user of your app',
          },
          {
            feature: 'Approval before risky actions',
            manyplug: 'Built in, on by default for sending and deleting',
            other: 'Up to the developer’s app',
          },
          {
            feature: 'Pricing',
            manyplug: 'Free plan, then from {from} a month',
            other: 'Free tier, then usage-based (see Composio’s pricing page)',
          },
        ],
        chooseManyplug: [
          'You want your own assistant to work with your mail, tasks and docs today, without writing code.',
          'You need several accounts per service and approvals before the AI acts.',
        ],
        chooseOther: [
          'You are building a product whose users connect their own accounts to your agent.',
          'You need SDK-level control, triggers and white-label sign-in.',
        ],
      },
      ru: {
        title: 'Manyplug или Composio: MCP для людей или для разработчиков',
        description:
          'Composio — платформа для разработчиков, которые дают агентам инструменты через SDK и MCP-шлюз. Manyplug — готовый MCP-хаб для тех, кто пользуется Claude, ChatGPT и Cursor, с несколькими аккаунтами и подтверждениями.',
        h1: 'Manyplug и Composio',
        summary:
          'Composio — платформа для разработчиков ИИ-агентов и продуктов: SDK, вход для их собственных пользователей, триггеры и MCP-шлюз, оплата за вызовы инструментов. Manyplug — для тех, кто сам пользуется ИИ-ассистентами: вход через Google, подключение аккаунтов и один адрес для Claude, ChatGPT или Cursor, без кода.',
        rows: [
          {
            feature: 'Для кого',
            manyplug: 'Люди и небольшие команды с ИИ-ассистентами',
            other: 'Разработчики агентов и ИИ-продуктов',
          },
          { feature: 'Настройка', manyplug: 'Сайт или чат, без кода', other: 'SDK и API, плюс MCP-шлюз' },
          {
            feature: 'Несколько аккаунтов одного сервиса',
            manyplug: 'Да, именованные аккаунты; ИИ работает с одним или сразу со всеми',
            other: 'Подключённые аккаунты каждого пользователя вашего приложения',
          },
          {
            feature: 'Подтверждение рискованных действий',
            manyplug: 'Встроено, для отправки и удаления включено по умолчанию',
            other: 'На стороне приложения разработчика',
          },
          {
            feature: 'Цена',
            manyplug: 'Бесплатный тариф, дальше от {from} в месяц',
            other: 'Бесплатный уровень, дальше по использованию (см. страницу цен Composio)',
          },
        ],
        chooseManyplug: [
          'Нужно, чтобы ваш ассистент уже сегодня работал с почтой, задачами и документами, без кода.',
          'Нужны несколько аккаунтов одного сервиса и подтверждения перед действиями ИИ.',
        ],
        chooseOther: [
          'Вы делаете продукт, пользователи которого подключают к вашему агенту свои аккаунты.',
          'Нужен контроль на уровне SDK, триггеры и вход под вашим брендом.',
        ],
      },
    },
  },
  {
    slug: 'separate-mcp-servers',
    other: 'separate MCP servers',
    checked: '2026-11-04',
    sources: [
      {
        label: 'Claude: custom connectors',
        url: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
      },
      { label: 'Model Context Protocol', url: 'https://modelcontextprotocol.io' },
    ],
    body: {
      en: {
        title: 'One MCP hub or a separate MCP server per service?',
        description:
          'Many services ship their own MCP server. Here is when adding each one to every AI client is fine, and when one hub like Manyplug saves setup, keeps several accounts apart and adds approvals.',
        h1: 'One MCP hub or separate MCP servers',
        summary:
          'A separate MCP server per service works when you use one or two services in one AI client. With more services, several accounts or several AI clients, every server has to be added and signed in to in every client, usually for one account each. A hub such as Manyplug is added once per client and holds all your services and accounts behind one address with the same rules.',
        rows: [
          {
            feature: 'Setup per AI client',
            manyplug: 'Add one address once',
            other: 'Add and sign in to every server in every client',
          },
          {
            feature: 'Several accounts of one service',
            manyplug: 'Named accounts behind one address',
            other: 'Usually one account per server entry',
          },
          {
            feature: 'Services without their own MCP server',
            manyplug: 'Built-in connectors, any IMAP mailbox, any REST API',
            other: 'Not available',
          },
          {
            feature: 'Approvals and rules',
            manyplug: 'Same approvals and per-app rules for every service',
            other: 'Whatever each server and client offer',
          },
          {
            feature: 'Tool list in the AI’s context',
            manyplug: 'Compact catalogue, details on demand',
            other: 'All tools of all servers at once',
          },
          {
            feature: 'Claude free plan',
            manyplug: 'Counts as one custom connector',
            other: 'One custom connector in total',
          },
        ],
        chooseManyplug: [
          'You use more than a couple of services, several accounts of one service, or more than one AI client.',
          'You want one place to see what the AI did and to approve risky actions.',
        ],
        chooseOther: [
          'You need one service in one client, and its official server has a tool Manyplug lacks.',
        ],
        together:
          'You can have both: add an official remote MCP server inside Manyplug by its address, and every AI client gets it through Manyplug with the same rules and approvals.',
      },
      ru: {
        title: 'Один MCP-хаб или отдельный MCP-сервер для каждого сервиса?',
        description:
          'У многих сервисов есть свой MCP-сервер. Когда достаточно добавить каждый в каждый ИИ-клиент, а когда один хаб вроде Manyplug экономит настройку, разделяет аккаунты и добавляет подтверждения.',
        h1: 'Один MCP-хаб или отдельные MCP-серверы',
        summary:
          'Отдельный MCP-сервер для каждого сервиса подходит, если у вас один-два сервиса в одном ИИ-клиенте. Когда сервисов, аккаунтов или клиентов больше, каждый сервер приходится добавлять и подключать в каждом клиенте, обычно для одного аккаунта. Хаб вроде Manyplug добавляется в клиент один раз и держит все сервисы и аккаунты за одним адресом с одинаковыми правилами.',
        rows: [
          {
            feature: 'Настройка в каждом ИИ-клиенте',
            manyplug: 'Один адрес, один раз',
            other: 'Добавить и подключить каждый сервер в каждом клиенте',
          },
          {
            feature: 'Несколько аккаунтов одного сервиса',
            manyplug: 'Именованные аккаунты за одним адресом',
            other: 'Обычно один аккаунт на запись сервера',
          },
          {
            feature: 'Сервисы без своего MCP-сервера',
            manyplug: 'Встроенные коннекторы, любая почта IMAP, любой REST API',
            other: 'Недоступны',
          },
          {
            feature: 'Подтверждения и правила',
            manyplug: 'Одни подтверждения и правила для всех сервисов',
            other: 'Что предлагает каждый сервер и клиент',
          },
          {
            feature: 'Список инструментов в контексте ИИ',
            manyplug: 'Компактный каталог, подробности по запросу',
            other: 'Все инструменты всех серверов сразу',
          },
          {
            feature: 'Бесплатный тариф Claude',
            manyplug: 'Считается одним своим коннектором',
            other: 'Всего один свой коннектор',
          },
        ],
        chooseManyplug: [
          'У вас больше пары сервисов, несколько аккаунтов одного сервиса или больше одного ИИ-клиента.',
          'Нужно одно место, где видно, что делал ИИ, и где подтверждаются рискованные действия.',
        ],
        chooseOther: [
          'Нужен один сервис в одном клиенте, и у его официального сервера есть инструмент, которого нет в Manyplug.',
        ],
        together:
          'Можно и то и другое: добавьте официальный удалённый MCP-сервер в Manyplug по адресу, и все ИИ-клиенты получат его через Manyplug с теми же правилами и подтверждениями.',
      },
    },
  },
  {
    slug: 'claude-built-in-connectors',
    other: 'Claude’s built-in Google connectors',
    checked: '2026-11-04',
    sources: [
      {
        label: 'Claude: Google Workspace connectors',
        url: 'https://support.claude.com/en/articles/10166901',
      },
    ],
    body: {
      en: {
        title: 'Manyplug vs Claude’s built-in Gmail, Calendar and Drive connectors',
        description:
          'Claude has its own Gmail, Google Calendar and Google Drive connectors. When they are enough, and when one Manyplug connector for every service and AI app is the better fit.',
        h1: 'Manyplug vs Claude’s built-in Google connectors',
        summary:
          'If you only use Claude and one Google account, Claude’s own Gmail, Calendar and Drive connectors are the simplest choice: they are built in and go deeper into Google files. Manyplug fits when you want several accounts, services beyond Google, or the same setup in ChatGPT, Cursor and other apps; it connects {count} services through one custom connector.',
        rows: [
          {
            feature: 'Services',
            manyplug: '{count} built-in services, plus any IMAP mailbox, remote MCP server or REST API',
            other: 'Gmail, Google Calendar and Google Drive, plus Docs, Sheets and Slides editing',
          },
          {
            feature: 'AI apps',
            manyplug: 'Claude, ChatGPT, Claude Code, Cursor, VS Code, Codex, Gemini CLI and any MCP client',
            other: 'Claude and Claude Desktop',
          },
          {
            feature: 'Google accounts',
            manyplug: 'Several per service, each with a name; reads search all of them at once',
            other: 'Claude’s help page describes “the Google account you’ve connected”',
          },
          {
            feature: 'Sending and deleting',
            manyplug: 'Risky actions wait for your approval by default, with rules per account and AI app',
            other: 'Sending email and sharing or trashing Drive files ask for approval by default',
          },
          {
            feature: 'Google files',
            manyplug: 'Docs and Slides as text, Sheets as a table, text files',
            other: 'Also reads PDFs, images and Office files, and edits Docs, Sheets and Slides live',
          },
          {
            feature: 'Setup',
            manyplug: 'One custom connector in Claude (the free plan allows one) and a sign-in per service',
            other:
              'Toggle the connectors in the chat and sign in with Google; on Team and Enterprise an owner enables them first',
          },
        ],
        chooseManyplug: [
          'You have more than one Google account, or mail outside Google (iCloud, Fastmail, company IMAP).',
          'You also want Slack, Notion, GitHub, Stripe or a help desk in the same chat.',
          'You use ChatGPT, Cursor or Claude Code too and want one setup for all of them.',
        ],
        chooseOther: [
          'You only use Claude and one Google account.',
          'You need Claude to read PDFs and images on Drive or edit Google Docs live.',
          'Your company already manages Claude connectors centrally on a Team or Enterprise plan.',
        ],
        together:
          'They work side by side: keep Claude’s Drive connector for deep file work and add Manyplug for your other accounts and services. Tell Claude which one to use if both can do a job.',
      },
      ru: {
        title: 'Manyplug и встроенные коннекторы Claude для Gmail, Календаря и Drive',
        description:
          'У Claude есть свои коннекторы Gmail, Google Календаря и Google Drive. Когда их достаточно, а когда лучше один коннектор Manyplug для всех сервисов и приложений ИИ.',
        h1: 'Manyplug и встроенные коннекторы Google в Claude',
        summary:
          'Если вы пользуетесь только Claude и одним аккаунтом Google, проще всего его собственные коннекторы Gmail, Календаря и Drive: они встроены и глубже работают с файлами Google. Manyplug подходит, когда нужны несколько аккаунтов, сервисы помимо Google или та же настройка в ChatGPT, Cursor и других приложениях; он подключает {count} сервисов через один свой коннектор.',
        rows: [
          {
            feature: 'Сервисы',
            manyplug: '{count} встроенных сервисов, плюс любой IMAP-ящик, удалённый MCP-сервер или REST API',
            other: 'Gmail, Google Календарь и Google Drive, плюс редактирование Docs, Sheets и Slides',
          },
          {
            feature: 'Приложения ИИ',
            manyplug: 'Claude, ChatGPT, Claude Code, Cursor, VS Code, Codex, Gemini CLI и любой MCP-клиент',
            other: 'Claude и Claude Desktop',
          },
          {
            feature: 'Аккаунты Google',
            manyplug: 'Несколько на сервис, у каждого имя; чтение ищет сразу во всех',
            other: 'Справка Claude говорит об «аккаунте Google, который вы подключили»',
          },
          {
            feature: 'Отправка и удаление',
            manyplug:
              'Рискованные действия по умолчанию ждут подтверждения, правила для аккаунта и приложения ИИ',
            other: 'Отправка писем и доступ или удаление файлов в Drive по умолчанию требуют подтверждения',
          },
          {
            feature: 'Файлы Google',
            manyplug: 'Docs и Slides как текст, Sheets как таблица, текстовые файлы',
            other: 'Ещё читает PDF, картинки и файлы Office, редактирует Docs, Sheets и Slides вживую',
          },
          {
            feature: 'Настройка',
            manyplug: 'Один свой коннектор в Claude (на бесплатном тарифе можно один) и вход в каждый сервис',
            other:
              'Включить коннекторы в чате и войти через Google; в Team и Enterprise их сначала включает владелец',
          },
        ],
        chooseManyplug: [
          'У вас больше одного аккаунта Google или почта вне Google (iCloud, Fastmail, корпоративный IMAP).',
          'Нужны ещё Slack, Notion, GitHub, Stripe или хелпдеск в том же чате.',
          'Вы пользуетесь ещё ChatGPT, Cursor или Claude Code и хотите одну настройку для всех.',
        ],
        chooseOther: [
          'Вы пользуетесь только Claude и одним аккаунтом Google.',
          'Нужно, чтобы Claude читал PDF и картинки в Drive или правил Google Docs вживую.',
          'Компания уже централизованно управляет коннекторами Claude на тарифе Team или Enterprise.',
        ],
        together:
          'Они работают рядом: оставьте коннектор Drive от Claude для глубокой работы с файлами и добавьте Manyplug для остальных аккаунтов и сервисов. Если сделать задачу могут оба, скажите Claude, какой использовать.',
      },
    },
  },
  {
    slug: 'pipedream-mcp',
    other: 'Pipedream MCP',
    checked: '2026-11-04',
    sources: [{ label: 'Pipedream MCP docs', url: 'https://pipedream.com/docs/connect/mcp' }],
    body: {
      en: {
        title: 'Manyplug vs Pipedream MCP',
        description:
          'Pipedream MCP offers MCP servers for 3,000+ apps, built mainly for developers adding tools to their own agents. How it compares with Manyplug’s one hub for your own accounts.',
        h1: 'Manyplug vs Pipedream MCP',
        summary:
          'Pipedream MCP gives each of 3,000+ apps its own MCP server and is aimed mostly at developers who add tools to their agents for their users. Manyplug is one MCP server for your own accounts: {count} services behind one address, several accounts per service, and approvals for risky actions. Pick Pipedream for breadth or to build a product; pick Manyplug to give your own AI apps your own accounts.',
        rows: [
          {
            feature: 'Apps',
            manyplug: '{count} built-in services, plus any IMAP mailbox, remote MCP server or REST API',
            other: '3,000+ apps and APIs, 10,000+ pre-built tools (Pipedream’s figures)',
          },
          {
            feature: 'Who it is for',
            manyplug: 'People and teams connecting their own accounts',
            other: 'Developers adding tools to their apps and agents; individuals can connect accounts too',
          },
          {
            feature: 'Servers',
            manyplug: 'One address for every service and account',
            other: 'A dedicated MCP server per app',
          },
          {
            feature: 'Several accounts of one app',
            manyplug: 'Yes, each with a name; reads can search all of them at once',
            other: 'Not stated in the MCP docs',
          },
          {
            feature: 'Credentials',
            manyplug: 'Encrypted with a separate key per account, never shown to the AI',
            other: 'Managed OAuth, encrypted at rest, not exposed to AI models',
          },
          {
            feature: 'Approvals',
            manyplug: 'Risky actions such as sending and refunds wait for your OK by default',
            other: 'Not described in the MCP docs',
          },
        ],
        chooseManyplug: [
          'You want one address in Claude or ChatGPT for all your accounts, not a server per app.',
          'You have several accounts of the same service.',
          'You want approvals for sending, deleting and payments, set per account and AI app.',
        ],
        chooseOther: [
          'You need an app Manyplug does not have yet; Pipedream covers far more.',
          'You are building a product and want to give your own users tools in their accounts.',
          'You already use Pipedream workflows.',
        ],
        together:
          'Manyplug can add a remote MCP server as a custom service, so a Pipedream app server can sit next to your built-in services behind the same address.',
      },
      ru: {
        title: 'Manyplug и Pipedream MCP',
        description:
          'Pipedream MCP даёт MCP-серверы для 3000+ приложений и рассчитан в основном на разработчиков, которые добавляют инструменты в своих агентов. Чем он отличается от единого хаба Manyplug для ваших аккаунтов.',
        h1: 'Manyplug и Pipedream MCP',
        summary:
          'Pipedream MCP даёт каждому из 3000+ приложений свой MCP-сервер и рассчитан в основном на разработчиков, которые добавляют инструменты в агентов для своих пользователей. Manyplug — один MCP-сервер для ваших собственных аккаунтов: {count} сервисов за одним адресом, несколько аккаунтов на сервис и подтверждение рискованных действий. Pipedream — ради широты или для своего продукта; Manyplug — чтобы дать своим приложениям ИИ свои аккаунты.',
        rows: [
          {
            feature: 'Приложения',
            manyplug: '{count} встроенных сервисов, плюс любой IMAP-ящик, удалённый MCP-сервер или REST API',
            other: '3000+ приложений и API, 10 000+ готовых инструментов (по данным Pipedream)',
          },
          {
            feature: 'Для кого',
            manyplug: 'Люди и команды, которые подключают свои аккаунты',
            other:
              'Разработчики, добавляющие инструменты в свои приложения и агенты; подключать аккаунты могут и частные лица',
          },
          {
            feature: 'Серверы',
            manyplug: 'Один адрес для всех сервисов и аккаунтов',
            other: 'Отдельный MCP-сервер на каждое приложение',
          },
          {
            feature: 'Несколько аккаунтов одного приложения',
            manyplug: 'Да, у каждого имя; чтение может искать сразу во всех',
            other: 'В документации по MCP не указано',
          },
          {
            feature: 'Ключи',
            manyplug: 'Шифруются отдельным ключом для каждого аккаунта, ИИ их не видит',
            other: 'Управляемый OAuth, шифрование при хранении, ИИ-моделям не показываются',
          },
          {
            feature: 'Подтверждения',
            manyplug: 'Рискованные действия вроде отправки и возвратов по умолчанию ждут вашего OK',
            other: 'В документации по MCP не описаны',
          },
        ],
        chooseManyplug: [
          'Нужен один адрес в Claude или ChatGPT для всех аккаунтов, а не сервер на каждое приложение.',
          'У вас несколько аккаунтов одного сервиса.',
          'Нужны подтверждения отправки, удаления и платежей с настройкой по аккаунту и приложению ИИ.',
        ],
        chooseOther: [
          'Нужно приложение, которого в Manyplug пока нет: у Pipedream их гораздо больше.',
          'Вы делаете продукт и хотите дать своим пользователям инструменты в их аккаунтах.',
          'Вы уже пользуетесь сценариями Pipedream.',
        ],
        together:
          'Manyplug умеет добавить удалённый MCP-сервер как свой сервис, так что сервер приложения Pipedream может стоять рядом со встроенными сервисами за тем же адресом.',
      },
    },
  },
];

export const comparePage = (slug: string) => COMPARE_PAGES.find((p) => p.slug === slug);
