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
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * The server name in the client's config: `manyplug`, or `manyplug-work` for the address of the
 * access profile `work`, so adding a profile never replaces the main connection.
 */
export function serverName(url: string): string {
  const profile = /\/mcp\/([a-z0-9][a-z0-9-]*)\/?$/.exec(url)?.[1];
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
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    glyph: 'chat',
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
    glyph: 'braces',
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
    install: (url) => ({
      href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: serverName(url), type: 'http', url }))}`,
      label: { ru: 'Установить в VS Code', en: 'Install in VS Code' },
    }),
  },
  {
    id: 'codex',
    name: 'Codex',
    glyph: 'code',
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
