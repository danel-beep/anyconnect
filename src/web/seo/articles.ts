import type { Localized, QA } from './types.js';

/**
 * Explainers (`/guides/<slug>`): the questions people ask search engines and AI assistants before
 * they know Manyplug exists. Each opens with a direct answer, then sections, then a short FAQ.
 * Numbers about Manyplug are placeholders filled when the page renders (`{freeAccounts}` accounts
 * on the free plan, `{count}` built-in services), so the text never disagrees with the plans.
 */
export interface Article {
  slug: string;
  updated: string;
  body: Localized<ArticleBody>;
}

export interface ArticleBody {
  title: string;
  description: string;
  h1: string;
  answer: string;
  sections: { h: string; p: string[]; list?: string[] }[];
  faq: QA[];
}

export const ARTICLES: Article[] = [
  {
    slug: 'what-is-mcp',
    updated: '2026-11-04',
    body: {
      en: {
        title: 'What is MCP (Model Context Protocol) and what is an MCP hub?',
        description:
          'MCP is the open standard that lets AI assistants like Claude and ChatGPT use tools: your mail, calendar, tasks and code. What an MCP server and an MCP hub are, and when you need one.',
        h1: 'What is MCP, and what is an MCP hub?',
        answer:
          'MCP (Model Context Protocol) is an open standard that lets an AI assistant use outside tools: search your mail, read a document, create a task. The assistant is the MCP client; each service is reached through an MCP server. An MCP hub is one MCP server that connects many services and accounts, so you add one address to your AI instead of a server per service.',
        sections: [
          {
            h: 'How MCP works',
            p: [
              'An MCP server describes its tools to the AI client: a name, what each tool does and which inputs it takes. When you ask for something, the AI picks a tool, the client calls the server, and the result comes back into the conversation.',
              'Local servers run on your computer and talk to the client over standard input and output. Remote servers run in the cloud and are reached by URL over HTTP (the Streamable HTTP transport); you sign in to them with OAuth, so the AI never sees your password.',
            ],
          },
          {
            h: 'Which AI apps support MCP',
            p: ['Remote MCP servers work in most AI assistants and coding tools today, including:'],
            list: [
              'Claude (web, desktop and mobile) and Claude Code',
              'ChatGPT in developer mode',
              'Cursor, VS Code with GitHub Copilot, Windsurf',
              'Codex and Gemini CLI',
            ],
          },
          {
            h: 'What an MCP hub adds',
            p: [
              'With a server per service, every one has to be added and signed in to in every AI app, most allow one account, and the tools of all servers fill the AI’s context. A hub sits between the AI and your services:',
            ],
            list: [
              'one address for every AI app;',
              'several accounts per service, each with its own name;',
              'services without their own MCP server, such as any IMAP mailbox or a REST API;',
              'the same rules and approvals for every service, and one activity log.',
            ],
          },
          {
            h: 'How Manyplug does it',
            p: [
              'Manyplug is a hosted MCP hub. You sign in with Google, connect accounts on the website or by asking the AI, and paste one address into Claude, ChatGPT or Cursor. {count} services are built in, any other remote MCP server or REST API can be added, keys are encrypted per account, and risky actions such as sending mail wait for your OK by default.',
            ],
          },
        ],
        faq: [
          {
            q: 'Who created MCP?',
            a: 'Anthropic introduced the Model Context Protocol in November 2024 as an open standard. It is now supported by OpenAI, Google, Microsoft, Cursor and many others.',
          },
          {
            q: 'Is MCP safe?',
            a: 'MCP itself is a protocol; safety depends on the server. Look for OAuth sign-in instead of pasting passwords, encrypted credentials, a way to require approval for actions that send or delete, and protection against instructions hidden in emails and web pages.',
          },
          {
            q: 'Do I need to install anything?',
            a: 'Not for remote servers such as Manyplug: they run in the cloud and are added to the AI app by URL.',
          },
        ],
      },
      ru: {
        title: 'Что такое MCP (Model Context Protocol) и что такое MCP-хаб?',
        description:
          'MCP — открытый стандарт, через который ИИ-ассистенты вроде Claude и ChatGPT пользуются инструментами: почтой, календарём, задачами и кодом. Что такое MCP-сервер и MCP-хаб и когда он нужен.',
        h1: 'Что такое MCP и что такое MCP-хаб?',
        answer:
          'MCP (Model Context Protocol) — открытый стандарт, который позволяет ИИ-ассистенту пользоваться внешними инструментами: искать в почте, читать документ, создавать задачу. Ассистент — это MCP-клиент, а каждый сервис доступен через MCP-сервер. MCP-хаб — один MCP-сервер, за которым много сервисов и аккаунтов, поэтому в ИИ добавляется один адрес вместо отдельного сервера на каждый сервис.',
        sections: [
          {
            h: 'Как работает MCP',
            p: [
              'MCP-сервер описывает ИИ-клиенту свои инструменты: название, что делает каждый и какие данные принимает. Когда вы о чём-то просите, ИИ выбирает инструмент, клиент вызывает сервер, и результат возвращается в разговор.',
              'Локальные серверы работают на вашем компьютере и общаются с клиентом через стандартный ввод и вывод. Удалённые работают в облаке и доступны по адресу через HTTP (транспорт Streamable HTTP); вход в них идёт по OAuth, поэтому ИИ никогда не видит ваш пароль.',
            ],
          },
          {
            h: 'Какие ИИ-приложения поддерживают MCP',
            p: [
              'Удалённые MCP-серверы сегодня работают в большинстве ИИ-ассистентов и инструментов для кода, в том числе:',
            ],
            list: [
              'Claude (веб, десктоп и мобильные) и Claude Code',
              'ChatGPT в режиме разработчика',
              'Cursor, VS Code с GitHub Copilot, Windsurf',
              'Codex и Gemini CLI',
            ],
          },
          {
            h: 'Что даёт MCP-хаб',
            p: [
              'Если на каждый сервис свой сервер, каждый нужно добавить и подключить в каждом ИИ-приложении, большинство позволяют один аккаунт, а инструменты всех серверов забивают контекст ИИ. Хаб стоит между ИИ и вашими сервисами:',
            ],
            list: [
              'один адрес для всех ИИ-приложений;',
              'несколько аккаунтов одного сервиса, у каждого своё имя;',
              'сервисы без своего MCP-сервера, например любая почта IMAP или REST API;',
              'одни правила и подтверждения для всех сервисов и один журнал действий.',
            ],
          },
          {
            h: 'Как это сделано в Manyplug',
            p: [
              'Manyplug — облачный MCP-хаб. Вы входите через Google, подключаете аккаунты на сайте или просьбой к ИИ и вставляете один адрес в Claude, ChatGPT или Cursor. Встроенных сервисов: {count}, любой другой удалённый MCP-сервер или REST API добавляется сам, ключи шифруются отдельно для каждого аккаунта, а рискованные действия вроде отправки писем по умолчанию ждут вашего «да».',
            ],
          },
        ],
        faq: [
          {
            q: 'Кто придумал MCP?',
            a: 'Anthropic представила Model Context Protocol в ноябре 2024 года как открытый стандарт. Сейчас его поддерживают OpenAI, Google, Microsoft, Cursor и многие другие.',
          },
          {
            q: 'MCP безопасен?',
            a: 'MCP — это протокол, а безопасность зависит от сервера. Ищите вход через OAuth вместо пароля, шифрование ключей, подтверждение действий, которые отправляют или удаляют, и защиту от команд, спрятанных в письмах и на веб-страницах.',
          },
          {
            q: 'Нужно что-то устанавливать?',
            a: 'Для удалённых серверов вроде Manyplug — нет: они работают в облаке и добавляются в ИИ-приложение по адресу.',
          },
        ],
      },
    },
  },
  {
    slug: 'multiple-accounts',
    updated: '2026-11-04',
    body: {
      en: {
        title: 'How to connect several Gmail (or Slack, Notion) accounts to ChatGPT and Claude',
        description:
          'Most AI connectors take one account per service. How to give ChatGPT or Claude two Gmail inboxes, several Slack workspaces or a client’s Notion, and let the AI search all of them at once.',
        h1: 'Several accounts of one service in ChatGPT and Claude',
        answer:
          'Built-in connectors in ChatGPT and Claude usually link one account per service. To use two Gmail inboxes or several Slack workspaces, connect them through an MCP hub that keeps accounts apart: in Manyplug you connect each account under its own name, add one address to the AI, and ask for one account by name or for all of them at once.',
        sections: [
          {
            h: 'Step by step',
            p: [],
            list: [
              'Sign in to Manyplug with Google.',
              'Connect the first account, for example your work Gmail, and name it Work.',
              'Connect the second one and name it Personal. Repeat for every account you need.',
              'Add the Manyplug address to ChatGPT, Claude or another AI app once.',
              'Ask: “Search both my inboxes for the ACME invoice” or “Send it from Personal”.',
            ],
          },
          {
            h: 'How the AI tells accounts apart',
            p: [
              'Every tool takes an account. Read tools accept “all”, so one search covers every inbox and the results say which account each item came from. Tools that change something use the account you name, and the AI asks when it is unclear.',
              'Mail, chats, calendars and tasks also share common tools, so one request such as “find unread email” covers Gmail and any IMAP mailbox at once, and “what is due this week” covers every task service.',
            ],
          },
          {
            h: 'Separate rules per account',
            p: [
              'Each account can have its own rules: let the AI read the personal inbox but not send from it, or ask you before anything changes in the work account. Each AI app can be limited to some accounts too.',
            ],
          },
          {
            h: 'Limits',
            p: [
              'The free plan holds {freeAccounts} accounts in total, of any services, and all of them can be Gmail inboxes. Paid plans hold more; there is no separate limit per service.',
            ],
          },
        ],
        faq: [
          {
            q: 'Can I connect two Google accounts that use the same browser?',
            a: 'Yes. When you connect the second one, pick the other account on Google’s sign-in screen (or use “Use another account”).',
          },
          {
            q: 'Can the AI move data between accounts?',
            a: 'Yes, for example read an email in one inbox and forward it from another, or copy a task from one workspace to another. Sending still waits for your OK by default.',
          },
        ],
      },
      ru: {
        title: 'Как подключить несколько аккаунтов Gmail (или Slack, Notion) к ChatGPT и Claude',
        description:
          'Большинство коннекторов ИИ берут один аккаунт на сервис. Как дать ChatGPT или Claude два ящика Gmail, несколько рабочих пространств Slack или Notion клиента и искать сразу во всех.',
        h1: 'Несколько аккаунтов одного сервиса в ChatGPT и Claude',
        answer:
          'Встроенные коннекторы ChatGPT и Claude обычно подключают один аккаунт сервиса. Чтобы пользоваться двумя ящиками Gmail или несколькими пространствами Slack, подключите их через MCP-хаб, который различает аккаунты: в Manyplug каждый аккаунт подключается под своим именем, в ИИ добавляется один адрес, и можно просить про конкретный аккаунт или сразу про все.',
        sections: [
          {
            h: 'По шагам',
            p: [],
            list: [
              'Войдите в Manyplug через Google.',
              'Подключите первый аккаунт, например рабочий Gmail, и назовите его «Работа».',
              'Подключите второй и назовите «Личный». Повторите для всех нужных аккаунтов.',
              'Один раз добавьте адрес Manyplug в ChatGPT, Claude или другое ИИ-приложение.',
              'Попросите: «Найди в обоих ящиках счёт ACME» или «Отправь его с личного».',
            ],
          },
          {
            h: 'Как ИИ различает аккаунты',
            p: [
              'Каждый инструмент принимает аккаунт. Инструменты чтения понимают «all», поэтому один поиск проходит по всем ящикам, а в результатах видно, из какого аккаунта что пришло. Инструменты, которые что-то меняют, работают с аккаунтом, который вы назвали, а если непонятно — ИИ спрашивает.',
              'У почты, чатов, календарей и задач есть общие инструменты, поэтому один запрос вроде «найди непрочитанные письма» проходит сразу по Gmail и любой почте IMAP, а «что нужно сделать на этой неделе» — по всем сервисам задач.',
            ],
          },
          {
            h: 'Свои правила для каждого аккаунта',
            p: [
              'У каждого аккаунта могут быть свои правила: разрешить ИИ читать личную почту, но не отправлять с неё, или спрашивать вас перед любым изменением в рабочем аккаунте. Каждому ИИ-приложению тоже можно дать только часть аккаунтов.',
            ],
          },
          {
            h: 'Ограничения',
            p: [
              'На бесплатном тарифе аккаунтов любых сервисов в сумме: {freeAccounts}, и все они могут быть, например, ящиками Gmail. На платных больше; отдельного лимита на один сервис нет.',
            ],
          },
        ],
        faq: [
          {
            q: 'Можно подключить два аккаунта Google из одного браузера?',
            a: 'Да. При подключении второго выберите другой аккаунт на экране входа Google (или «Сменить аккаунт»).',
          },
          {
            q: 'Может ли ИИ переносить данные между аккаунтами?',
            a: 'Да, например прочитать письмо в одном ящике и переслать его с другого или перенести задачу из одного пространства в другое. Отправка по умолчанию всё равно ждёт вашего «да».',
          },
        ],
      },
    },
  },
];

export const article = (slug: string) => ARTICLES.find((a) => a.slug === slug);
