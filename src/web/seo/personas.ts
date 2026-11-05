import type { Localized, QA } from './types.js';

/**
 * Pages per audience (`/for/<slug>`): who Manyplug helps and how, in that reader's words. Each
 * names the jobs it solves (`useCases`, slugs from `use-cases.ts`) and the services it is usually
 * used with, so the page is built from the same catalogue and workflow texts as the rest of the
 * site; a workflow or service that does not exist here is simply not shown.
 */
export interface Persona {
  slug: string;
  /** Use case slugs, most relevant first. */
  useCases: string[];
  /** Catalogue ids of the services this audience usually connects. */
  services: string[];
  updated: string;
  body: Localized<PersonaBody>;
}

export interface PersonaBody {
  title: string;
  description: string;
  h1: string;
  answer: string;
  /** The problems the reader recognises, each with how Manyplug handles it. */
  points: { h: string; p: string }[];
  faq: QA[];
}

export const PERSONAS: Persona[] = [
  {
    slug: 'freelancers',
    updated: '2026-11-04',
    useCases: [
      'summarize-inbox',
      'draft-email-replies',
      'schedule-meetings',
      'email-to-tasks',
      'stripe-questions',
    ],
    services: ['gmail', 'imap', 'gcal', 'calendly', 'todoist', 'notion', 'gdrive', 'stripe'],
    body: {
      en: {
        title: 'Manyplug for freelancers: one AI assistant for every client account',
        description:
          'Freelancers juggle a mailbox, a calendar and a workspace per client. Connect them all to Claude or ChatGPT once, keep them apart by name, and ask across them.',
        h1: 'One AI assistant for every client you work with',
        answer:
          'Freelancers often have a mailbox, a calendar and a Notion or Drive per client. Manyplug connects all of them, each with its own name, to the AI app you already use. Ask “what do my clients need from me this week?” and the AI checks every account, then replies, schedules or files tasks in the right one.',
        points: [
          {
            h: 'Several accounts of the same service',
            p: 'Three Gmail accounts, two Google Calendars, a client’s Slack: connect them all, name them after the client, and say “from the Acme account” when it matters. Read tools search all of them at once by default.',
          },
          {
            h: 'Nothing goes out without you',
            p: 'Replies, forwards and invites to clients are risky actions, so they wait for your approval on a confirmation page. You stay the one who presses send.',
          },
          {
            h: 'Your keys stay yours',
            p: 'Client accounts are connected through each service’s own sign-in or an app password stored encrypted per account. The AI never sees a password, and removing a client account deletes its keys.',
          },
          {
            h: 'Invoices and payments',
            p: 'With Stripe connected, ask who has paid and who has not, then draft the reminder in the same conversation.',
          },
        ],
        faq: [
          {
            q: 'Can my clients see what I connect?',
            a: 'No. Your Manyplug workspace is yours; clients only see the emails, events and messages you send through their services.',
          },
          {
            q: 'What if a client uses Outlook or a custom mail server?',
            a: 'Any mailbox with IMAP connects through the IMAP connector with an app password.',
          },
        ],
      },
      ru: {
        title: 'Manyplug для фрилансеров: один ИИ-ассистент для аккаунтов всех клиентов',
        description:
          'У фрилансера почта, календарь и рабочее пространство на каждого клиента. Подключите всё к Claude или ChatGPT один раз, различайте по именам и спрашивайте сразу обо всём.',
        h1: 'Один ИИ-ассистент для всех ваших клиентов',
        answer:
          'У фрилансера часто свой ящик, календарь и Notion или Drive на каждого клиента. Manyplug подключает их все, каждый со своим именем, к приложению ИИ, которым вы уже пользуетесь. Спросите «что клиентам нужно от меня на этой неделе?» — ИИ проверит каждый аккаунт, а потом ответит, назначит встречу или заведёт задачу в нужном.',
        points: [
          {
            h: 'Несколько аккаунтов одного сервиса',
            p: 'Три Gmail, два Google Календаря, Slack клиента: подключите все, назовите по клиенту и скажите «с аккаунта Acme», когда это важно. Инструменты чтения по умолчанию ищут сразу во всех.',
          },
          {
            h: 'Без вас ничего не уходит',
            p: 'Ответы, пересылки и приглашения клиентам — рискованные действия, поэтому они ждут вашего подтверждения на отдельной странице. Кнопку «отправить» нажимаете вы.',
          },
          {
            h: 'Ключи остаются вашими',
            p: 'Аккаунты клиентов подключаются через вход самого сервиса или пароль приложения, который хранится зашифрованным отдельно для каждого аккаунта. ИИ не видит паролей, а удаление аккаунта клиента удаляет и его ключи.',
          },
          {
            h: 'Счета и оплаты',
            p: 'С подключённым Stripe спросите, кто оплатил, а кто нет, и тут же подготовьте напоминание.',
          },
        ],
        faq: [
          {
            q: 'Клиенты видят, что я подключаю?',
            a: 'Нет. Пространство Manyplug — ваше; клиенты видят только письма, события и сообщения, которые вы отправляете через их сервисы.',
          },
          {
            q: 'А если у клиента Outlook или своя почта?',
            a: 'Любой ящик с IMAP подключается через коннектор IMAP с паролем приложения.',
          },
        ],
      },
    },
  },
  {
    slug: 'agencies',
    updated: '2026-11-04',
    useCases: ['summarize-inbox', 'weekly-dev-report', 'email-to-tasks', 'search-docs', 'crm-updates'],
    services: ['gmail', 'slack', 'notion', 'gdrive', 'asana', 'clickup', 'monday', 'hubspot'],
    body: {
      en: {
        title: 'Manyplug for agencies: AI across every client’s Slack, Gmail and project tools',
        description:
          'Agencies work inside each client’s tools. Give Claude or ChatGPT access to all of them, named per client, with approvals for anything that reaches the client.',
        h1: 'Work across every client’s tools from one AI chat',
        answer:
          'Agency teams sit in a client’s Slack, a client’s Asana and their own Gmail at the same time. Manyplug puts all of those accounts behind one address in Claude or ChatGPT. Ask for a status across clients, the open requests in one client’s Slack, or a draft update, and the AI works in the right account each time.',
        points: [
          {
            h: 'One name per client account',
            p: 'Connect the same service several times, once per client, and name each account. The AI sees which account a result came from and uses the one you name for changes.',
          },
          {
            h: 'Status reports without copy and paste',
            p: 'The AI reads tasks from Asana, ClickUp, monday.com or Linear and the decisions in Slack, then writes a client-ready update.',
          },
          {
            h: 'Approvals for anything the client sees',
            p: 'Slack messages and emails wait for your OK by default. Per AI app rules let you give a junior teammate read-only access.',
          },
        ],
        faq: [
          {
            q: 'Does every teammate need their own workspace?',
            a: 'Each person connects the accounts they use, so every action is done as that person and the client’s own permissions apply.',
          },
          {
            q: 'Can I connect a client tool that is not built in?',
            a: 'Yes. Any remote MCP server or REST API can be added as a custom service.',
          },
        ],
      },
      ru: {
        title: 'Manyplug для агентств: ИИ во всех Slack, Gmail и проектных сервисах клиентов',
        description:
          'Агентства работают в инструментах каждого клиента. Дайте Claude или ChatGPT доступ ко всем, с именем на клиента и подтверждением всего, что видит клиент.',
        h1: 'Работа во всех сервисах клиентов из одного чата с ИИ',
        answer:
          'Команда агентства одновременно сидит в Slack клиента, в его Asana и в своём Gmail. Manyplug прячет все эти аккаунты за одним адресом в Claude или ChatGPT. Попросите статус по всем клиентам, открытые просьбы в Slack одного из них или черновик отчёта — ИИ каждый раз работает в нужном аккаунте.',
        points: [
          {
            h: 'Имя для аккаунта каждого клиента',
            p: 'Подключите один сервис несколько раз — по разу на клиента — и назовите каждый аккаунт. ИИ видит, из какого аккаунта пришёл результат, и для изменений использует названный вами.',
          },
          {
            h: 'Отчёты без копирования',
            p: 'ИИ читает задачи в Asana, ClickUp, monday.com или Linear и решения в Slack и пишет отчёт, который можно отправить клиенту.',
          },
          {
            h: 'Подтверждение всего, что видит клиент',
            p: 'Сообщения в Slack и письма по умолчанию ждут вашего OK. Правила для приложений ИИ позволяют дать младшему коллеге только чтение.',
          },
        ],
        faq: [
          {
            q: 'Каждому сотруднику нужно своё пространство?',
            a: 'Каждый подключает аккаунты, которыми пользуется сам, так что действие выполняется от его имени и действуют права самого клиента.',
          },
          {
            q: 'Можно подключить сервис клиента, которого нет в каталоге?',
            a: 'Да. Любой удалённый MCP-сервер или REST API добавляется как свой сервис.',
          },
        ],
      },
    },
  },
  {
    slug: 'founders',
    updated: '2026-11-04',
    useCases: ['daily-briefing', 'summarize-inbox', 'stripe-questions', 'crm-updates', 'support-inbox'],
    services: ['gmail', 'gcal', 'stripe', 'hubspot', 'pipedrive', 'intercom', 'notion', 'slack'],
    body: {
      en: {
        title: 'Manyplug for founders: your inbox, revenue and customers in one AI chat',
        description:
          'Ask Claude or ChatGPT about today’s meetings, unpaid invoices, hot deals and angry customers in one conversation. Connect Gmail, Stripe, HubSpot and more in minutes.',
        h1: 'Run the day from one AI chat',
        answer:
          'A founder’s day spans email, the calendar, Stripe, the CRM and the support inbox. With Manyplug, Claude or ChatGPT can read all of them: “brief me on today”, “who churned this week?”, “what is the status of the Acme deal?”. Changes such as refunds or replies to customers wait for your OK.',
        points: [
          {
            h: 'Personal and company accounts together',
            p: 'Your personal Gmail, the company Google Workspace and the investor-updates mailbox can all be connected and named, and searched together.',
          },
          {
            h: 'Numbers you can ask about',
            p: 'Stripe balance, failed payments and subscriptions answer in plain language; HubSpot or Pipedrive deals and the latest support conversations sit in the same chat.',
          },
          {
            h: 'Safe by default',
            p: 'Refunds, public replies and outgoing email are marked risky and wait for approval. Keys are encrypted per account and never shown to the AI.',
          },
        ],
        faq: [
          {
            q: 'Is it free to try?',
            a: 'Yes. You can start without a card; the pricing page lists what each plan includes.',
          },
          {
            q: 'Can my team use the same setup?',
            a: 'Each person connects their own accounts, so the AI acts with each person’s permissions.',
          },
        ],
      },
      ru: {
        title: 'Manyplug для фаундеров: почта, выручка и клиенты в одном чате с ИИ',
        description:
          'Спрашивайте Claude или ChatGPT о встречах на сегодня, неоплаченных счетах, горячих сделках и недовольных клиентах в одном разговоре. Gmail, Stripe, HubSpot и другие подключаются за минуты.',
        h1: 'Управляйте днём из одного чата с ИИ',
        answer:
          'День фаундера — это почта, календарь, Stripe, CRM и поддержка. С Manyplug Claude или ChatGPT читает их все: «что у меня сегодня», «кто отказался от подписки на этой неделе?», «как дела со сделкой Acme?». Изменения вроде возвратов и ответов клиентам ждут вашего OK.',
        points: [
          {
            h: 'Личные и рабочие аккаунты вместе',
            p: 'Личный Gmail, рабочий Google Workspace и ящик для инвесторов подключаются и называются отдельно, а ищутся вместе.',
          },
          {
            h: 'О цифрах можно спросить',
            p: 'Баланс Stripe, неуспешные платежи и подписки — обычным языком; сделки в HubSpot или Pipedrive и последние обращения в поддержку — в том же чате.',
          },
          {
            h: 'Безопасно по умолчанию',
            p: 'Возвраты, публичные ответы и исходящая почта помечены как рискованные и ждут подтверждения. Ключи зашифрованы для каждого аккаунта и не показываются ИИ.',
          },
        ],
        faq: [
          {
            q: 'Можно попробовать бесплатно?',
            a: 'Да. Начать можно без карты; что входит в каждый тариф — на странице цен.',
          },
          {
            q: 'Команда может пользоваться тем же?',
            a: 'Каждый подключает свои аккаунты, так что ИИ действует с правами конкретного человека.',
          },
        ],
      },
    },
  },
  {
    slug: 'developers',
    updated: '2026-11-04',
    useCases: ['weekly-dev-report', 'email-to-tasks', 'search-docs'],
    services: ['github', 'gitlab', 'linear', 'jira', 'sentry', 'slack', 'notion', 'confluence'],
    body: {
      en: {
        title: 'Manyplug for developers: GitHub, Linear, Sentry and Slack in Cursor and Claude Code',
        description:
          'One remote MCP server for Cursor, Claude Code, VS Code and Codex with GitHub, GitLab, Linear, Jira, Sentry, Slack and docs. Several accounts each, OAuth or tokens, no local servers to run.',
        h1: 'Your dev tools in every coding assistant, from one MCP server',
        answer:
          'Instead of installing a local MCP server per tool in every editor, add one remote server to Cursor, Claude Code, VS Code or Codex. Manyplug brings GitHub, GitLab, Linear, Jira, Sentry, Slack, Notion and Confluence, with work and personal accounts side by side, and any REST API or remote MCP server you add yourself.',
        points: [
          {
            h: 'One config line for every editor',
            p: 'The same URL works in Cursor, Claude Code, VS Code, Windsurf, Codex and Gemini CLI. Change your accounts once in the dashboard and every editor sees it.',
          },
          {
            h: 'A small, focused tool list',
            p: 'Manyplug can show the AI a short list of tools and let it search for the rest, so dozens of services do not fill the context window before you start.',
          },
          {
            h: 'Work and personal GitHub side by side',
            p: 'Connect both accounts, name them, and say which one an issue or comment should come from.',
          },
          {
            h: 'Bring your own API',
            p: 'Connect an internal REST API by its address and key, or add a remote MCP server, and it gets the same accounts, rules and activity log.',
          },
        ],
        faq: [
          {
            q: 'Does it run code on my machine?',
            a: 'No. It is a hosted remote MCP server over Streamable HTTP; your editor connects to it by URL.',
          },
          {
            q: 'My client has no OAuth support. Can I still connect?',
            a: 'Yes. Create a personal token in the dashboard and send it as a Bearer header.',
          },
        ],
      },
      ru: {
        title: 'Manyplug для разработчиков: GitHub, Linear, Sentry и Slack в Cursor и Claude Code',
        description:
          'Один удалённый MCP-сервер для Cursor, Claude Code, VS Code и Codex с GitHub, GitLab, Linear, Jira, Sentry, Slack и документацией. По несколько аккаунтов, OAuth или токены, без локальных серверов.',
        h1: 'Ваши инструменты разработки в любом ИИ-редакторе — через один MCP-сервер',
        answer:
          'Вместо локального MCP-сервера на каждый инструмент в каждом редакторе добавьте один удалённый сервер в Cursor, Claude Code, VS Code или Codex. Manyplug даёт GitHub, GitLab, Linear, Jira, Sentry, Slack, Notion и Confluence — рабочие и личные аккаунты рядом — и любой REST API или удалённый MCP-сервер, который вы добавите сами.',
        points: [
          {
            h: 'Одна строка конфигурации для всех редакторов',
            p: 'Один и тот же адрес работает в Cursor, Claude Code, VS Code, Windsurf, Codex и Gemini CLI. Меняете аккаунты один раз в панели — видят все редакторы.',
          },
          {
            h: 'Короткий список инструментов',
            p: 'Manyplug может показать ИИ короткий список инструментов и дать найти остальные поиском, так что десятки сервисов не забивают контекст ещё до начала работы.',
          },
          {
            h: 'Рабочий и личный GitHub рядом',
            p: 'Подключите оба, назовите и говорите, от какого аккаунта создать задачу или комментарий.',
          },
          {
            h: 'Свой API',
            p: 'Подключите внутренний REST API по адресу и ключу или добавьте удалённый MCP-сервер — у него будут те же аккаунты, правила и журнал.',
          },
        ],
        faq: [
          {
            q: 'Он запускает код на моём компьютере?',
            a: 'Нет. Это облачный удалённый MCP-сервер по Streamable HTTP; редактор подключается к нему по адресу.',
          },
          {
            q: 'Мой клиент не поддерживает OAuth. Подключиться можно?',
            a: 'Да. Создайте личный токен в панели и передавайте его в заголовке Bearer.',
          },
        ],
      },
    },
  },
  {
    slug: 'support-teams',
    updated: '2026-11-04',
    useCases: ['support-inbox', 'stripe-questions', 'search-docs', 'summarize-inbox'],
    services: ['zendesk', 'intercom', 'freshdesk', 'stripe', 'notion', 'confluence', 'slack', 'gmail'],
    body: {
      en: {
        title: 'Manyplug for support teams: AI over Zendesk, Intercom, Stripe and your docs',
        description:
          'Let Claude or ChatGPT read tickets, check the customer’s payments in Stripe and find the answer in Notion or Confluence. Public replies wait for the agent’s approval.',
        h1: 'Answer customers faster with AI that sees the whole picture',
        answer:
          'A good answer needs the ticket, the customer’s payment status and the right help article. With Manyplug the AI reads Zendesk, Intercom or Freshdesk, checks Stripe and searches Notion or Confluence in one conversation, then drafts the reply. Anything the customer will see waits for the agent’s OK.',
        points: [
          {
            h: 'Context from every system',
            p: 'Ticket history, the customer record, recent payments and the internal docs are one question away instead of four tabs.',
          },
          {
            h: 'The agent stays in charge',
            p: 'Public replies, closing messages and refunds are risky actions and wait for approval by default. Internal notes go straight in.',
          },
          {
            h: 'Read-only where it matters',
            p: 'Connect Stripe in read-only mode for the support AI app, so it can check payments but never refund without a rule change.',
          },
        ],
        faq: [
          {
            q: 'Does the AI reply to customers on its own?',
            a: 'No, not by default. It drafts; the agent approves what is sent.',
          },
          {
            q: 'Is customer text safe to pass to the AI?',
            a: 'Text from tickets and emails is marked as untrusted, so instructions hidden in it are treated as data, not as requests.',
          },
        ],
      },
      ru: {
        title: 'Manyplug для поддержки: ИИ над Zendesk, Intercom, Stripe и вашей документацией',
        description:
          'Пусть Claude или ChatGPT читает обращения, проверяет платежи клиента в Stripe и находит ответ в Notion или Confluence. Публичные ответы ждут подтверждения агента.',
        h1: 'Отвечайте клиентам быстрее с ИИ, который видит всю картину',
        answer:
          'Для хорошего ответа нужны обращение, статус оплаты клиента и нужная статья. С Manyplug ИИ читает Zendesk, Intercom или Freshdesk, проверяет Stripe и ищет в Notion или Confluence в одном разговоре, а потом готовит ответ. Всё, что увидит клиент, ждёт OK агента.',
        points: [
          {
            h: 'Контекст из всех систем',
            p: 'История обращения, карточка клиента, последние платежи и внутренние документы — на расстоянии одного вопроса, а не четырёх вкладок.',
          },
          {
            h: 'Решает агент',
            p: 'Публичные ответы, прощальные сообщения и возвраты — рискованные действия и по умолчанию ждут подтверждения. Внутренние заметки добавляются сразу.',
          },
          {
            h: 'Только чтение там, где важно',
            p: 'Подключите Stripe только на чтение для приложения ИИ поддержки — он проверит платежи, но не сделает возврат без смены правила.',
          },
        ],
        faq: [
          {
            q: 'ИИ отвечает клиентам сам?',
            a: 'По умолчанию нет. Он готовит ответ, агент подтверждает отправку.',
          },
          {
            q: 'Безопасно ли передавать ИИ текст клиентов?',
            a: 'Текст обращений и писем помечается как недоверенный: спрятанные в нём инструкции остаются данными, а не просьбами.',
          },
        ],
      },
    },
  },
];

export const persona = (slug: string) => PERSONAS.find((p) => p.slug === slug);
