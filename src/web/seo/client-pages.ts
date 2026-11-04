import type { Localized, QA } from './types.js';

/**
 * Long-form texts of the per-client guide pages (`/docs/<slug>`), keyed by `ClientGuide.id`. The
 * steps, commands and install links themselves stay in `src/web/clients.ts` (the dashboard shows
 * them too); this adds what a standalone page needs: the answer up front, requirements, fixes for
 * the usual problems and questions specific to the client. Facts are the clients' own documentation
 * as of `CLIENT_PAGES_CHECKED`; re-check them when a client changes its menus.
 */
export interface ClientPage {
  /** Path segment: `/docs/<slug>`. */
  slug: string;
  /** Minutes the setup takes, for the page and HowTo data. */
  minutes: number;
  /** One or two sentences that answer "how do I connect my services to <client>?". */
  intro: Localized;
  requirements: Localized<string[]>;
  troubleshooting: Localized<QA[]>;
  /** Questions about this client; the shared ones (price, accounts, safety) are added by the page. */
  faq: Localized<QA[]>;
}

export const CLIENT_PAGES_CHECKED = '2026-11-04';

export const CLIENT_PAGES: Record<string, ClientPage> = {
  claude: {
    slug: 'claude',
    minutes: 2,
    intro: {
      en: 'Claude reaches your services through custom connectors. Add Manyplug once as a custom connector at claude.ai, and Claude can use every account you connect in Manyplug: Gmail, Google Calendar, Notion, GitHub and the rest, in the web app, Claude Desktop and the mobile apps.',
      ru: 'Claude работает с вашими сервисами через свои коннекторы. Добавьте Manyplug один раз как свой коннектор на claude.ai, и Claude сможет пользоваться всеми аккаунтами, подключёнными в Manyplug: Gmail, Google Календарём, Notion, GitHub и другими — в браузере, Claude Desktop и мобильных приложениях.',
    },
    requirements: {
      en: [
        'A Claude account on any plan. The free plan allows one custom connector, and Manyplug is a single connector for all your services.',
        'On Team and Enterprise plans an owner adds the connector in Organization settings → Connectors; members then click Connect.',
        'A Manyplug account (free, sign in with Google).',
      ],
      ru: [
        'Аккаунт Claude на любом тарифе. На бесплатном можно добавить один свой коннектор, а Manyplug — один коннектор сразу для всех сервисов.',
        'На тарифах Team и Enterprise коннектор добавляет владелец в «Настройках организации» → «Коннекторы», участники затем нажимают «Подключить».',
        'Аккаунт Manyplug (бесплатно, вход через Google).',
      ],
    },
    troubleshooting: {
      en: [
        {
          q: 'There is no “Add custom connector” button',
          a: 'On Team and Enterprise only owners can add connectors. On the free plan the one custom connector may already be taken: remove the old one under Customize → Connectors.',
        },
        {
          q: 'Claude does not use Manyplug in a chat',
          a: 'Click “+” at the bottom left of the chat, open Connectors and turn Manyplug on. Tools you do not need can be switched off in the same menu.',
        },
        {
          q: 'The connector says it is disconnected',
          a: 'Open Customize → Connectors → Manyplug and click Connect, then sign in to Manyplug again. Access you revoked in the Manyplug dashboard also shows up like this.',
        },
      ],
      ru: [
        {
          q: 'Нет кнопки «Добавить свой коннектор»',
          a: 'На Team и Enterprise коннекторы добавляют только владельцы. На бесплатном тарифе единственный свой коннектор может быть уже занят: удалите старый в разделе «Настроить» → «Коннекторы».',
        },
        {
          q: 'Claude не пользуется Manyplug в чате',
          a: 'Нажмите «+» слева внизу чата, откройте «Коннекторы» и включите Manyplug. Ненужные инструменты можно выключить в том же меню.',
        },
        {
          q: 'Коннектор пишет, что отключён',
          a: 'Откройте «Настроить» → «Коннекторы» → Manyplug и нажмите «Подключить», затем снова войдите в Manyplug. Так же выглядит доступ, который вы отозвали в кабинете Manyplug.',
        },
      ],
    },
    faq: {
      en: [
        {
          q: 'Does Manyplug work in the Claude mobile app?',
          a: 'Yes. Custom connectors run from Anthropic’s cloud, so once Manyplug is added on claude.ai it is available in the iOS and Android apps and in Claude Desktop under the same account.',
        },
        {
          q: 'Why use Manyplug instead of separate connectors in Claude?',
          a: 'One connector gives Claude all your services, including several accounts of the same one (two Gmail inboxes, for example), and it counts as a single custom connector on the free plan.',
        },
      ],
      ru: [
        {
          q: 'Manyplug работает в мобильном приложении Claude?',
          a: 'Да. Свои коннекторы работают из облака Anthropic, поэтому после добавления на claude.ai Manyplug доступен в приложениях для iOS и Android и в Claude Desktop под тем же аккаунтом.',
        },
        {
          q: 'Зачем Manyplug, если в Claude есть отдельные коннекторы?',
          a: 'Один коннектор даёт Claude все ваши сервисы, в том числе несколько аккаунтов одного сервиса (например, два ящика Gmail), и на бесплатном тарифе считается одним своим коннектором.',
        },
      ],
    },
  },
  chatgpt: {
    slug: 'chatgpt',
    minutes: 3,
    intro: {
      en: 'ChatGPT connects to MCP servers as apps in developer mode. Turn developer mode on, create an app with the Manyplug address and OAuth, and ChatGPT can search, read and act in every account you connect in Manyplug.',
      ru: 'ChatGPT подключает MCP-серверы как приложения в режиме разработчика. Включите режим разработчика, создайте приложение с адресом Manyplug и OAuth, и ChatGPT сможет искать, читать и действовать во всех аккаунтах, подключённых в Manyplug.',
    },
    requirements: {
      en: [
        'ChatGPT Plus, Pro, Business, Enterprise or Edu, on chatgpt.com in a browser (the app is created on the web).',
        'In Business, Enterprise and Edu workspaces an admin may need to allow developer mode first.',
        'A Manyplug account (free, sign in with Google).',
      ],
      ru: [
        'ChatGPT Plus, Pro, Business, Enterprise или Edu на chatgpt.com в браузере (приложение создаётся в веб-версии).',
        'В рабочих пространствах Business, Enterprise и Edu администратору, возможно, сначала нужно разрешить режим разработчика.',
        'Аккаунт Manyplug (бесплатно, вход через Google).',
      ],
    },
    troubleshooting: {
      en: [
        {
          q: 'There is no Create button in Apps & Connectors',
          a: 'Developer mode is off: Settings → Apps & Connectors → Advanced settings → Developer mode. In a company workspace ask the admin to allow it.',
        },
        {
          q: 'ChatGPT does not call Manyplug',
          a: 'Developer-mode apps are picked per chat: click “+” next to the message box, choose More and select Manyplug. Naming the service in the request (“in my Gmail…”) helps too.',
        },
        {
          q: 'Sign-in fails while creating the app',
          a: 'Choose OAuth as the authentication and use the address exactly as Manyplug shows it, ending in /mcp. Make sure pop-ups are allowed for chatgpt.com.',
        },
      ],
      ru: [
        {
          q: 'В «Приложениях и коннекторах» нет кнопки «Создать»',
          a: 'Не включён режим разработчика: «Настройки» → «Приложения и коннекторы» → «Расширенные настройки» → «Режим разработчика». В рабочем пространстве компании попросите администратора его разрешить.',
        },
        {
          q: 'ChatGPT не обращается к Manyplug',
          a: 'Приложения режима разработчика выбираются в каждом чате: нажмите «+» рядом с полем ввода, затем «Ещё» и выберите Manyplug. Помогает и название сервиса в запросе («в моей почте Gmail…»).',
        },
        {
          q: 'Не получается войти при создании приложения',
          a: 'Выберите аутентификацию OAuth и вставьте адрес точно как в Manyplug, с /mcp на конце. Проверьте, что для chatgpt.com разрешены всплывающие окна.',
        },
      ],
    },
    faq: {
      en: [
        {
          q: 'Can ChatGPT send email or messages through Manyplug?',
          a: 'Yes, but by default sending, deleting and other risky actions wait for your approval in Manyplug before they run, and each account’s rules decide what ChatGPT may do at all.',
        },
        {
          q: 'Does it work in the ChatGPT mobile app?',
          a: 'The app is created on chatgpt.com in a browser. Availability of developer-mode apps in the mobile apps depends on OpenAI’s rollout; the web version always works.',
        },
      ],
      ru: [
        {
          q: 'ChatGPT может отправлять письма и сообщения через Manyplug?',
          a: 'Да, но по умолчанию отправка, удаление и другие рискованные действия ждут вашего подтверждения в Manyplug, а правила каждого аккаунта решают, что ChatGPT вообще можно.',
        },
        {
          q: 'Работает ли это в мобильном приложении ChatGPT?',
          a: 'Приложение создаётся на chatgpt.com в браузере. Доступность приложений режима разработчика в мобильных приложениях зависит от OpenAI; в веб-версии работает всегда.',
        },
      ],
    },
  },
  'claude-code': {
    slug: 'claude-code',
    minutes: 1,
    intro: {
      en: 'Claude Code adds remote MCP servers with one command. Run `claude mcp add` with the Manyplug address, sign in once through /mcp, and Claude Code can read your issues, mail, docs and calendars from the terminal, VS Code or JetBrains.',
      ru: 'Claude Code добавляет удалённые MCP-серверы одной командой. Выполните `claude mcp add` с адресом Manyplug, войдите один раз через /mcp, и Claude Code сможет читать задачи, почту, документы и календари прямо из терминала, VS Code или JetBrains.',
    },
    requirements: {
      en: ['Claude Code installed and signed in.', 'A Manyplug account (free, sign in with Google).'],
      ru: [
        'Установленный Claude Code со входом в аккаунт.',
        'Аккаунт Manyplug (бесплатно, вход через Google).',
      ],
    },
    troubleshooting: {
      en: [
        {
          q: 'manyplug shows “needs authentication”',
          a: 'Start claude, type /mcp, pick manyplug and choose Authenticate: the browser opens the Manyplug sign-in.',
        },
        {
          q: 'The server is missing in another project',
          a: 'Add it with --scope user (as in the command above) so it is available in every folder, not only the current project.',
        },
      ],
      ru: [
        {
          q: 'manyplug показывает «needs authentication»',
          a: 'Запустите claude, введите /mcp, выберите manyplug и пункт Authenticate: в браузере откроется вход в Manyplug.',
        },
        {
          q: 'В другом проекте сервера нет',
          a: 'Добавьте его с --scope user (как в команде выше), тогда он доступен в любой папке, а не только в текущем проекте.',
        },
      ],
    },
    faq: {
      en: [
        {
          q: 'How do I check that Claude Code sees Manyplug?',
          a: 'Run claude mcp list: manyplug should be listed as connected. In a session, ask “Which accounts can you use in Manyplug?”.',
        },
      ],
      ru: [
        {
          q: 'Как проверить, что Claude Code видит Manyplug?',
          a: 'Выполните claude mcp list: manyplug должен быть в списке подключённых. В сессии спросите: «Какие аккаунты тебе доступны в Manyplug?».',
        },
      ],
    },
  },
  cursor: {
    slug: 'cursor',
    minutes: 1,
    intro: {
      en: 'Cursor supports remote MCP servers with OAuth. Click “Add to Cursor” or paste one line of config into mcp.json, sign in to Manyplug, and the Cursor agent can work with your GitHub, Linear, Jira, Notion and mail accounts.',
      ru: 'Cursor поддерживает удалённые MCP-серверы с OAuth. Нажмите «Добавить в Cursor» или вставьте одну строку конфигурации в mcp.json, войдите в Manyplug, и агент Cursor сможет работать с вашими аккаунтами GitHub, Linear, Jira, Notion и почтой.',
    },
    requirements: {
      en: ['Cursor 1.0 or later.', 'A Manyplug account (free, sign in with Google).'],
      ru: ['Cursor 1.0 или новее.', 'Аккаунт Manyplug (бесплатно, вход через Google).'],
    },
    troubleshooting: {
      en: [
        {
          q: 'The “Add to Cursor” button does nothing',
          a: 'The browser needs permission to open Cursor. Or paste the config into ~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project) yourself.',
        },
        {
          q: 'manyplug stays red or asks to log in',
          a: 'Open Cursor Settings, find manyplug in the MCP section and click Login, then allow access in the browser.',
        },
      ],
      ru: [
        {
          q: 'Кнопка «Добавить в Cursor» ничего не делает',
          a: 'Браузеру нужно разрешение открыть Cursor. Или вставьте конфигурацию сами в ~/.cursor/mcp.json (все проекты) или .cursor/mcp.json (один проект).',
        },
        {
          q: 'manyplug остаётся красным или просит войти',
          a: 'Откройте Cursor Settings, найдите manyplug в разделе MCP и нажмите Login, затем разрешите доступ в браузере.',
        },
      ],
    },
    faq: {
      en: [
        {
          q: 'Does Cursor count Manyplug tools against its tool limit?',
          a: 'Manyplug keeps the list short: with many services the AI first gets a compact catalogue and asks for details only when needed, so one server does not crowd out others.',
        },
      ],
      ru: [
        {
          q: 'Не займут ли инструменты Manyplug весь лимит инструментов Cursor?',
          a: 'Manyplug держит список коротким: при большом числе сервисов ИИ сначала получает компактный каталог и запрашивает подробности только когда нужно, поэтому один сервер не вытесняет остальные.',
        },
      ],
    },
  },
  vscode: {
    slug: 'vscode',
    minutes: 1,
    intro: {
      en: 'VS Code uses MCP servers in GitHub Copilot’s agent mode. Click “Install in VS Code” or add the server to mcp.json, sign in to Manyplug when VS Code asks, and Copilot can use all your connected accounts.',
      ru: 'VS Code использует MCP-серверы в режиме агента GitHub Copilot. Нажмите «Установить в VS Code» или добавьте сервер в mcp.json, войдите в Manyplug, когда VS Code попросит, и Copilot сможет пользоваться всеми подключёнными аккаунтами.',
    },
    requirements: {
      en: ['VS Code with GitHub Copilot (agent mode).', 'A Manyplug account (free, sign in with Google).'],
      ru: ['VS Code с GitHub Copilot (режим агента).', 'Аккаунт Manyplug (бесплатно, вход через Google).'],
    },
    troubleshooting: {
      en: [
        {
          q: 'Copilot does not show Manyplug tools',
          a: 'Switch the chat to Agent mode and open the tools picker: manyplug must be checked. Run “MCP: List Servers” from the command palette to start or restart it.',
        },
        {
          q: 'VS Code keeps asking to sign in',
          a: 'Run “MCP: List Servers”, pick manyplug and restart it, then finish the sign-in in the browser window it opens.',
        },
      ],
      ru: [
        {
          q: 'Copilot не показывает инструменты Manyplug',
          a: 'Переключите чат в режим Agent и откройте выбор инструментов: manyplug должен быть отмечен. Команда «MCP: List Servers» в палитре запускает или перезапускает сервер.',
        },
        {
          q: 'VS Code всё время просит войти',
          a: 'Выполните «MCP: List Servers», выберите manyplug и перезапустите его, затем закончите вход в открывшемся окне браузера.',
        },
      ],
    },
    faq: {
      en: [
        {
          q: 'Workspace or user settings?',
          a: '.vscode/mcp.json adds Manyplug to one project (and can be shared with the team, the address holds no secret). The install button adds it to your user profile for every project.',
        },
      ],
      ru: [
        {
          q: 'В настройки проекта или пользователя?',
          a: '.vscode/mcp.json добавляет Manyplug в один проект (файлом можно делиться с командой, в адресе нет секрета). Кнопка установки добавляет его в профиль пользователя для всех проектов.',
        },
      ],
    },
  },
  codex: {
    slug: 'codex',
    minutes: 2,
    intro: {
      en: 'Codex reads MCP servers from ~/.codex/config.toml. Add two lines with the Manyplug address, run `codex mcp login manyplug`, and the Codex CLI and IDE extension can use your connected accounts.',
      ru: 'Codex берёт MCP-серверы из ~/.codex/config.toml. Добавьте две строки с адресом Manyplug, выполните `codex mcp login manyplug`, и Codex CLI и расширение для IDE смогут пользоваться подключёнными аккаунтами.',
    },
    requirements: {
      en: ['Codex CLI or the Codex IDE extension.', 'A Manyplug account (free, sign in with Google).'],
      ru: ['Codex CLI или расширение Codex для IDE.', 'Аккаунт Manyplug (бесплатно, вход через Google).'],
    },
    troubleshooting: {
      en: [
        {
          q: 'Codex says manyplug is not logged in',
          a: 'Run codex mcp login manyplug again and finish the sign-in in the browser. codex mcp list shows the state of every server.',
        },
        {
          q: 'The IDE extension does not see the server',
          a: 'The CLI and the extension share ~/.codex/config.toml: restart the extension after editing the file.',
        },
      ],
      ru: [
        {
          q: 'Codex пишет, что вход в manyplug не выполнен',
          a: 'Снова выполните codex mcp login manyplug и закончите вход в браузере. codex mcp list показывает состояние всех серверов.',
        },
        {
          q: 'Расширение для IDE не видит сервер',
          a: 'CLI и расширение читают один файл ~/.codex/config.toml: перезапустите расширение после правки.',
        },
      ],
    },
    faq: {
      en: [
        {
          q: 'Can Codex run Manyplug actions without asking?',
          a: 'Codex has its own approval settings, and Manyplug adds its own on top: risky actions such as sending mail wait for your approval in Manyplug by default.',
        },
      ],
      ru: [
        {
          q: 'Может ли Codex выполнять действия Manyplug без спроса?',
          a: 'У Codex свои настройки подтверждений, а Manyplug добавляет свои: рискованные действия, например отправка писем, по умолчанию ждут вашего подтверждения в Manyplug.',
        },
      ],
    },
  },
  gemini: {
    slug: 'gemini-cli',
    minutes: 1,
    intro: {
      en: 'Gemini CLI adds remote MCP servers with `gemini mcp add`. Add Manyplug over HTTP, sign in with /mcp auth, and Gemini can work with every account you connect in Manyplug.',
      ru: 'Gemini CLI добавляет удалённые MCP-серверы командой `gemini mcp add`. Добавьте Manyplug по HTTP, войдите через /mcp auth, и Gemini сможет работать со всеми аккаунтами, подключёнными в Manyplug.',
    },
    requirements: {
      en: ['Gemini CLI installed.', 'A Manyplug account (free, sign in with Google).'],
      ru: ['Установленный Gemini CLI.', 'Аккаунт Manyplug (бесплатно, вход через Google).'],
    },
    troubleshooting: {
      en: [
        {
          q: 'The server works in one folder only',
          a: 'By default the command saves the server in the current project. Add -s user to save it in your user settings for every folder.',
        },
        {
          q: 'Tools fail with an authentication error',
          a: 'Type /mcp auth manyplug in Gemini CLI and sign in again. /mcp shows every server and its state.',
        },
      ],
      ru: [
        {
          q: 'Сервер работает только в одной папке',
          a: 'По умолчанию команда сохраняет сервер в текущем проекте. Добавьте -s user, чтобы сохранить его в настройках пользователя для всех папок.',
        },
        {
          q: 'Инструменты падают с ошибкой аутентификации',
          a: 'Введите в Gemini CLI /mcp auth manyplug и войдите снова. /mcp показывает все серверы и их состояние.',
        },
      ],
    },
    faq: {
      en: [
        {
          q: 'Does this work with the Gemini app on the web?',
          a: 'This guide is for Gemini CLI. Any Gemini product that can add a remote MCP server by URL with OAuth can use the same Manyplug address.',
        },
      ],
      ru: [
        {
          q: 'А в веб-приложении Gemini это работает?',
          a: 'Эта инструкция для Gemini CLI. Любой продукт Gemini, который умеет добавлять удалённый MCP-сервер по адресу с OAuth, подключается к тому же адресу Manyplug.',
        },
      ],
    },
  },
  windsurf: {
    slug: 'windsurf',
    minutes: 2,
    intro: {
      en: 'Windsurf reads MCP servers from mcp_config.json. Add Manyplug as a server URL, refresh the list in Cascade and sign in, and Cascade can use all your connected accounts.',
      ru: 'Windsurf берёт MCP-серверы из mcp_config.json. Добавьте Manyplug как адрес сервера, обновите список в Cascade и войдите, и Cascade сможет пользоваться всеми подключёнными аккаунтами.',
    },
    requirements: {
      en: ['Windsurf Editor.', 'A Manyplug account (free, sign in with Google).'],
      ru: ['Windsurf Editor.', 'Аккаунт Manyplug (бесплатно, вход через Google).'],
    },
    troubleshooting: {
      en: [
        {
          q: 'Cascade does not list manyplug',
          a: 'Check the file is ~/.codeium/windsurf/mcp_config.json and the key is serverUrl, then press refresh in the MCP servers panel.',
        },
      ],
      ru: [
        {
          q: 'Cascade не показывает manyplug',
          a: 'Проверьте, что файл — ~/.codeium/windsurf/mcp_config.json, а ключ — serverUrl, затем нажмите обновление в панели MCP-серверов.',
        },
      ],
    },
    faq: {
      en: [],
      ru: [],
    },
  },
  other: {
    slug: 'mcp-clients',
    minutes: 2,
    intro: {
      en: 'Manyplug is a standard remote MCP server (Streamable HTTP with OAuth 2.1), so any client that can add a server by URL works: paste the address and the client opens the Manyplug sign-in itself. Clients without OAuth can send a personal token instead.',
      ru: 'Manyplug — стандартный удалённый MCP-сервер (Streamable HTTP с OAuth 2.1), поэтому подходит любой клиент, который умеет добавлять сервер по адресу: вставьте адрес, и клиент сам откроет вход в Manyplug. Клиенты без OAuth могут передавать личный токен.',
    },
    requirements: {
      en: [
        'A client with remote MCP over HTTP (Streamable HTTP).',
        'OAuth 2.1 sign-in (dynamic registration or client metadata documents), or a personal token header.',
      ],
      ru: [
        'Клиент с удалённым MCP по HTTP (Streamable HTTP).',
        'Вход по OAuth 2.1 (динамическая регистрация или документ метаданных клиента) или заголовок с личным токеном.',
      ],
    },
    troubleshooting: {
      en: [
        {
          q: 'The client only supports local (stdio) servers',
          a: 'Use a bridge that turns a remote server into a local one, such as mcp-remote, with the Manyplug address.',
        },
        {
          q: 'The client cannot do OAuth',
          a: 'Create a personal token in the dashboard under AI apps and send it as the header “Authorization: Bearer <token>”.',
        },
      ],
      ru: [
        {
          q: 'Клиент умеет только локальные (stdio) серверы',
          a: 'Используйте мост, который превращает удалённый сервер в локальный, например mcp-remote, с адресом Manyplug.',
        },
        {
          q: 'Клиент не умеет OAuth',
          a: 'Создайте личный токен в кабинете в разделе «ИИ-приложения» и передавайте его заголовком «Authorization: Bearer <токен>».',
        },
      ],
    },
    faq: {
      en: [],
      ru: [],
    },
  },
};

/** The client guide id behind a page slug. */
export function clientIdBySlug(slug: string): string | undefined {
  return Object.entries(CLIENT_PAGES).find(([, page]) => page.slug === slug)?.[0];
}

/** The public guide page of a client, if it has one. */
export function clientGuidePath(id: string): string | undefined {
  const page = CLIENT_PAGES[id];
  return page ? `/docs/${page.slug}` : undefined;
}
