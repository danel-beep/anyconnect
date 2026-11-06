import type { IconName } from './ui.js';

/**
 * How to add the hub to each AI client. One entry per client; the dashboard, the website's
 * "Connect" page and the welcome screen all render from here. Steps are short and literal (menu
 * names as the client shows them); `code` is filled with the user's MCP URL.
 */
export interface ClientGuide {
  id: string;
  name: string;
  icon?: string;
  glyph?: IconName;
  /** Which plans of the client support custom MCP servers, shown under the title. */
  note: { ru: string; en: string };
  steps: { ru: string[]; en: string[] };
  /** Optional command or config to copy. */
  code?: (url: string) => string;
  /** Optional one-click install link. */
  install?: (url: string) => { href: string; label: { ru: string; en: string } };
  /**
   * Chat apps: the client's own page where a connector is added (opens in a new tab).
   * `skipsFirstStep`: the page is where the first step leads, so the dashboard leaves that step out.
   */
  open?: { href: string; skipsFirstStep: boolean };
  /**
   * Agent apps that edit their own config: where `code` goes and how the user signs in afterwards
   * (`{name}` is the server name). Turns into a ready prompt, see `setupPrompt`.
   */
  agent?: { where: { ru: string; en: string }; signIn: { ru: string; en: string } };
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * The server name in the client's config: `manyplug`, or `manyplug-work` for the address of the
 * access profile `work` (or of the team `work`, `/mcp/team/work`), so adding a profile or a team never
 * replaces the main connection.
 */
export function serverName(url: string): string {
  const profile = /\/mcp\/(?:team\/)?([a-z0-9][a-z0-9-]*)\/?$/.exec(url)?.[1];
  return profile ? `manyplug-${profile}` : 'manyplug';
}

export const CLIENT_GUIDES: ClientGuide[] = [
  {
    id: 'claude',
    name: 'Claude',
    icon: 'claude',
    note: {
      ru: 'claude.ai, Claude Desktop и мобильные приложения. На бесплатном тарифе можно добавить один свой коннектор — Manyplug и есть один коннектор для всех сервисов.',
      en: 'claude.ai, Claude Desktop and mobile. The free plan allows one custom connector, and Manyplug is one connector for all your services.',
    },
    steps: {
      ru: [
        'Откройте «Настроить» → «Коннекторы» (в старых версиях: «Настройки» → «Коннекторы»).',
        'Нажмите «+ Добавить» → «Добавить свой коннектор», назовите его Manyplug, вставьте адрес и нажмите «Продолжить».',
        'Оставьте предложенные настройки входа и нажмите «Добавить», затем «Подключить»: откроется Manyplug — войдите и разрешите доступ.',
        'В чате нажмите «+» → «Коннекторы», включите Manyplug и попросите: «Подключи мою почту».',
      ],
      en: [
        'Open Customize → Connectors (in older versions: Settings → Connectors).',
        'Click “+ Add” → “Add custom connector”, name it Manyplug, paste the URL and click Continue.',
        'Keep the suggested sign-in settings and click Add, then Connect: Manyplug opens — sign in and allow access.',
        'In a chat, click “+” → Connectors, turn Manyplug on and ask: “Connect my email”.',
      ],
    },
    open: { href: 'https://claude.ai/settings/connectors', skipsFirstStep: true },
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    icon: 'openai',
    note: {
      ru: 'Нужен режим разработчика (Plus, Pro, Business, Enterprise, Edu).',
      en: 'Needs developer mode (Plus, Pro, Business, Enterprise, Edu).',
    },
    steps: {
      ru: [
        'Откройте «Настройки» → «Приложения и коннекторы» → «Расширенные настройки» и включите «Режим разработчика».',
        'Вернитесь в «Приложения и коннекторы» и нажмите «Создать».',
        'Название — Manyplug, адрес MCP-сервера — ваш адрес, аутентификация — OAuth. Подтвердите, что доверяете приложению.',
        'Войдите в Manyplug и разрешите доступ. В чате выберите Manyplug через «+» → «Ещё».',
      ],
      en: [
        'Open Settings → Apps & Connectors → Advanced settings and turn on Developer mode.',
        'Go back to Apps & Connectors and click Create.',
        'Name: Manyplug, MCP server URL: your URL, authentication: OAuth. Confirm you trust the app.',
        'Sign in to Manyplug and allow access. In a chat, pick Manyplug under “+” → More.',
      ],
    },
    open: { href: 'https://chatgpt.com/#settings/Connectors', skipsFirstStep: false },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    glyph: 'terminal',
    note: { ru: 'Терминал, VS Code и JetBrains.', en: 'Terminal, VS Code and JetBrains.' },
    steps: {
      ru: [
        'Выполните команду в терминале.',
        'Запустите claude, введите /mcp, выберите manyplug и пройдите вход в браузере.',
      ],
      en: [
        'Run the command in a terminal.',
        'Start claude, type /mcp, pick manyplug and sign in in the browser.',
      ],
    },
    code: (url) => `claude mcp add --transport http --scope user ${serverName(url)} ${url}`,
    agent: {
      where: { ru: 'Выполни эту команду в терминале', en: 'Run this command in the terminal' },
      signIn: {
        ru: 'скажи мне ввести /mcp, выбрать {name} и войти в браузере.',
        en: 'tell me to type /mcp, pick {name} and sign in in the browser.',
      },
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    icon: 'cursor',
    note: { ru: 'Cursor 1.0 и новее.', en: 'Cursor 1.0 and later.' },
    steps: {
      ru: [
        'Нажмите «Добавить в Cursor» или вставьте конфигурацию в ~/.cursor/mcp.json.',
        'В Cursor Settings → MCP нажмите «Login» рядом с manyplug и войдите.',
      ],
      en: [
        'Click “Add to Cursor” or paste the config into ~/.cursor/mcp.json.',
        'In Cursor Settings → MCP click “Login” next to manyplug and sign in.',
      ],
    },
    code: (url) => json({ mcpServers: { [serverName(url)]: { url } } }),
    agent: {
      where: { ru: 'Добавь это в ~/.cursor/mcp.json', en: 'Add this to ~/.cursor/mcp.json' },
      signIn: {
        ru: 'скажи мне открыть Cursor Settings → MCP и нажать Login рядом с {name}.',
        en: 'tell me to open Cursor Settings → MCP and click Login next to {name}.',
      },
    },
    install: (url) => ({
      href: `cursor://anysphere.cursor-deeplink/mcp/install?name=${serverName(url)}&config=${encodeURIComponent(
        Buffer.from(JSON.stringify({ url })).toString('base64'),
      )}`,
      label: { ru: 'Добавить в Cursor', en: 'Add to Cursor' },
    }),
  },
  {
    id: 'vscode',
    name: 'VS Code',
    icon: 'visualstudiocode',
    note: { ru: 'GitHub Copilot в режиме агента.', en: 'GitHub Copilot in agent mode.' },
    steps: {
      ru: [
        'Нажмите «Установить в VS Code» или добавьте сервер в .vscode/mcp.json.',
        'Запустите сервер в списке MCP и войдите, когда VS Code попросит.',
      ],
      en: [
        'Click “Install in VS Code” or add the server to .vscode/mcp.json.',
        'Start the server in the MCP list and sign in when VS Code asks.',
      ],
    },
    code: (url) => json({ servers: { [serverName(url)]: { type: 'http', url } } }),
    agent: {
      where: {
        ru: 'Добавь это в .vscode/mcp.json этого проекта',
        en: 'Add this to .vscode/mcp.json in this workspace',
      },
      signIn: {
        ru: 'скажи мне запустить {name} в списке MCP и войти, когда VS Code попросит.',
        en: 'tell me to start {name} in the MCP list and sign in when VS Code asks.',
      },
    },
    install: (url) => ({
      href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: serverName(url), type: 'http', url }))}`,
      label: { ru: 'Установить в VS Code', en: 'Install in VS Code' },
    }),
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: 'openai',
    note: { ru: 'Codex CLI и расширение для IDE.', en: 'Codex CLI and the IDE extension.' },
    steps: {
      ru: [
        'Добавьте сервер в ~/.codex/config.toml.',
        'Выполните codex mcp login manyplug и войдите в браузере.',
      ],
      en: [
        'Add the server to ~/.codex/config.toml.',
        'Run codex mcp login manyplug and sign in in the browser.',
      ],
    },
    code: (url) => `[mcp_servers.${serverName(url)}]\nurl = "${url}"`,
    agent: {
      where: { ru: 'Добавь это в ~/.codex/config.toml', en: 'Add this to ~/.codex/config.toml' },
      signIn: {
        ru: 'выполни codex mcp login {name}, чтобы я вошёл в браузере.',
        en: 'run codex mcp login {name} so I can sign in in the browser.',
      },
    },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    icon: 'googlegemini',
    note: { ru: 'Gemini CLI.', en: 'Gemini CLI.' },
    steps: {
      ru: ['Выполните команду.', 'В Gemini CLI введите /mcp auth manyplug и войдите.'],
      en: ['Run the command.', 'In Gemini CLI type /mcp auth manyplug and sign in.'],
    },
    code: (url) => `gemini mcp add --transport http ${serverName(url)} ${url}`,
    agent: {
      where: { ru: 'Выполни эту команду в терминале', en: 'Run this command in the terminal' },
      signIn: {
        ru: 'скажи мне ввести /mcp auth {name} и войти.',
        en: 'tell me to type /mcp auth {name} and sign in.',
      },
    },
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    icon: 'windsurf',
    note: { ru: 'Windsurf Editor.', en: 'Windsurf Editor.' },
    steps: {
      ru: [
        'Добавьте сервер в ~/.codeium/windsurf/mcp_config.json.',
        'Обновите список MCP-серверов и войдите.',
      ],
      en: ['Add the server to ~/.codeium/windsurf/mcp_config.json.', 'Refresh the MCP servers and sign in.'],
    },
    code: (url) => json({ mcpServers: { [serverName(url)]: { serverUrl: url } } }),
    agent: {
      where: {
        ru: 'Добавь это в ~/.codeium/windsurf/mcp_config.json',
        en: 'Add this to ~/.codeium/windsurf/mcp_config.json',
      },
      signIn: {
        ru: 'скажи мне обновить список MCP-серверов и войти.',
        en: 'tell me to refresh the MCP servers and sign in.',
      },
    },
  },
  {
    id: 'other',
    name: 'Другие клиенты',
    glyph: 'plug',
    note: {
      ru: 'Любой клиент с удалённым MCP по HTTP (Streamable HTTP).',
      en: 'Any client with remote MCP over HTTP (Streamable HTTP).',
    },
    steps: {
      ru: [
        'Добавьте удалённый MCP-сервер с этим адресом — клиент сам откроет вход (OAuth 2.1).',
        'Если клиент не умеет OAuth, создайте личный токен в кабинете («ИИ-приложения») и передайте заголовок Authorization: Bearer <токен>.',
      ],
      en: [
        'Add a remote MCP server with this URL — the client opens the sign-in itself (OAuth 2.1).',
        'If the client cannot do OAuth, create a personal token in the dashboard (AI apps) and send the header Authorization: Bearer <token>.',
      ],
    },
  },
];

export const clientName = (guide: ClientGuide, lang: string) =>
  guide.id === 'other' && lang !== 'ru' ? 'Other clients' : guide.name;

/** Guides longest name first, so "Claude Code" wins over "Claude" and "VS Code" over "Code". */
const BY_NAME = CLIENT_GUIDES.filter((g) => g.id !== 'other').sort((a, b) => b.name.length - a.name.length);

/**
 * The guide of a known AI client, found by the name an app gave itself on sign-in (e.g.
 * "Claude Code", "claude-ai", "Cursor (work)"), for its logo. Undefined for unknown clients.
 */
export function guideForApp(...names: (string | null | undefined)[]): ClientGuide | undefined {
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const name of names) {
    if (!name) continue;
    const n = flat(name);
    const hit = BY_NAME.find((g) => n.includes(flat(g.name)) || n.includes(g.id));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * A ready prompt for an agent app (Claude Code, Cursor…): pasted into its chat, the agent adds the
 * server to its own config and tells the user how to sign in. `undefined` for chat apps.
 */
export function setupPrompt(guide: ClientGuide, url: string, lang: string): string | undefined {
  if (!guide.agent || !guide.code) return undefined;
  const ru = lang === 'ru';
  const name = serverName(url);
  const where = ru ? guide.agent.where.ru : guide.agent.where.en;
  const signIn = (ru ? guide.agent.signIn.ru : guide.agent.signIn.en).replaceAll('{name}', name);
  return ru
    ? `Подключи MCP-сервер Manyplug (${url}), чтобы ты мог работать с моими сервисами: почтой, календарём, чатами.\n\n${where}, не удаляя уже настроенные серверы:\n\n${guide.code(url)}\n\nКогда закончишь, ${signIn}`
    : `Add the Manyplug MCP server (${url}) so you can work with my services: mail, calendar, chats.\n\n${where}, keeping any MCP servers that are already set up:\n\n${guide.code(url)}\n\nWhen you are done, ${signIn}`;
}
