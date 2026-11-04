export type Locale = 'ru' | 'en';

const en = {
  'login.title': 'Sign in to AnyConnect',
  'login.subtitle': 'Your hub for connecting services to AI assistants.',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.invalid': 'Wrong email or password.',
  'login.rateLimited': 'Too many attempts. Try again in a few minutes.',
  'login.noUsers': 'No users yet: set ADMIN_EMAIL and ADMIN_PASSWORD and restart the hub.',
  'consent.title': 'Connect {client} to AnyConnect?',
  'consent.wants': '{client} asks for access to your hub.',
  'consent.access': 'It will be able to:',
  'consent.access.mcp':
    'see your connected services and accounts ({count} active) and use their tools on your behalf',
  'consent.access.offline': 'stay connected without asking again until you revoke access',
  'consent.verifiedDomain': 'Application identity verified by domain',
  'consent.selfDeclared': 'The name is provided by the application itself.',
  'consent.redirect': 'After approval you will return to',
  'consent.known': 'Known AI app',
  'consent.loopback':
    'This application runs on a computer (localhost). Approve only if you started it yourself, e.g. Claude Code or an IDE.',
  'consent.unknown': 'Make sure you trust this site before approving.',
  'consent.workspace': 'Workspace',
  'consent.signedInAs': 'Signed in as {email}',
  'consent.approve': 'Allow',
  'consent.deny': 'Deny',
  'consent.revokeHint': 'You can revoke access at any time on the hub home page.',
  'consent.persona': 'Persona',
  'consent.personaHint': 'Through this address the app only sees the accounts of this persona.',
  'consent.personaMissing': 'This address belongs to a persona that does not exist in your workspace.',
  'consent.clientAs': 'Remember this app as',
  'consent.clientNew': 'new app: {name}',
  'consent.clientHint': 'Access rules of the chosen app apply to it.',
  'confirm.title': 'Confirm an action',
  'confirm.listTitle': 'Actions waiting for you',
  'confirm.none': 'Nothing is waiting for confirmation.',
  'confirm.tg.ask': '🔐 Confirm the action',
  'confirm.tg.scheduled': '⏳ Runs in {seconds} s — you can still cancel',
  'confirm.tg.linked': 'Done: confirmations from your AnyConnect hub will arrive here.',
  'confirm.tg.linkFailed': 'This link is invalid or expired. Open the hub and create a new one.',
  'confirm.tg.unknown': 'Unknown or foreign request.',
  'confirm.tg.tooLate': 'Already decided or expired.',
  'confirm.client': 'App',
  'confirm.service': 'Service',
  'confirm.action': 'Action',
  'confirm.reason': 'Why it needs you',
  'confirm.arguments': 'Arguments (as the AI passed them)',
  'confirm.open': 'Open in the hub',
  'confirm.approve': '✅ Allow',
  'confirm.deny': '❌ Deny',
  'confirm.cancel': '↩️ Cancel',
  'confirm.expires': 'Expires',
  'confirm.runsAt': 'Runs at',
  'confirm.status.awaiting_confirmation': 'Waiting for your confirmation',
  'confirm.status.scheduled': 'Approved, waiting for the undo window',
  'confirm.status.running': 'Running',
  'confirm.status.succeeded': '✅ Done',
  'confirm.status.failed': '⚠️ Failed',
  'confirm.status.denied': '❌ Denied',
  'confirm.status.cancelled': '↩️ Cancelled',
  'confirm.status.expired': '⌛ Expired without an answer',
  'risk.read': 'read',
  'risk.write': 'changes data',
  'risk.dangerous': 'dangerous',
  'home.security': 'Protection',
  'home.telegram': 'Telegram for confirmations',
  'home.telegramLinked': 'Linked: {label}',
  'home.telegramNotLinked': 'Not linked: confirmations only via the web page.',
  'home.telegramLink': 'Link Telegram',
  'home.telegramOpen': 'Open this link in Telegram within 15 minutes:',
  'home.telegramUnlink': 'Unlink',
  'home.telegramDisabled': 'The hub has no Telegram bot (TELEGRAM_BOT_TOKEN is not set).',
  'home.pending': 'Waiting for confirmation: {count}',
  'error.title': 'Something went wrong',
  'error.back': 'Back to home',
  'error.csrf': 'The form expired. Go back, reload the page and try again.',
  'home.title': 'AnyConnect',
  'home.mcpUrl': 'MCP server URL',
  'home.mcpUrlHint': 'Paste this URL into your AI app. You will be asked to sign in here and approve access.',
  'home.howClaude': 'Claude: Settings → Connectors → Add custom connector → paste the URL.',
  'home.howChatgpt':
    'ChatGPT: Settings → Apps & Connectors → Advanced settings → Developer mode, then Create → paste the URL, authentication OAuth.',
  'home.howOther':
    'Claude Code and other clients: add a remote HTTP MCP server with this URL (OAuth), or use a personal token.',
  'home.accounts': 'Connected accounts',
  'home.noAccounts': 'No accounts yet.',
  'home.apps': 'Connected AI apps',
  'home.noApps': 'No apps connected yet.',
  'home.revoke': 'Revoke',
  'home.lastUsed': 'last used',
  'home.never': 'never',
  'home.calls': 'Recent tool calls',
  'home.noCalls': 'No calls yet.',
  'home.signOut': 'Sign out',
  'home.service': 'Service',
  'home.account': 'Account',
  'home.status': 'Status',
  'home.disabled': 'disabled',
  'home.manageHint': 'Accounts are managed through the REST API or CLI for now; the web panel comes next.',
} as const;

type Key = keyof typeof en;

const ru: Record<Key, string> = {
  'login.title': 'Вход в AnyConnect',
  'login.subtitle': 'Ваш хаб для подключения сервисов к ИИ-ассистентам.',
  'login.email': 'Email',
  'login.password': 'Пароль',
  'login.submit': 'Войти',
  'login.invalid': 'Неверный email или пароль.',
  'login.rateLimited': 'Слишком много попыток. Попробуйте через несколько минут.',
  'login.noUsers': 'Пользователей ещё нет: задайте ADMIN_EMAIL и ADMIN_PASSWORD и перезапустите хаб.',
  'consent.title': 'Подключить {client} к AnyConnect?',
  'consent.wants': '{client} запрашивает доступ к вашему хабу.',
  'consent.access': 'Приложение сможет:',
  'consent.access.mcp':
    'видеть подключённые сервисы и аккаунты (активных: {count}) и вызывать их инструменты от вашего имени',
  'consent.access.offline': 'оставаться подключённым без повторного входа, пока вы не отзовёте доступ',
  'consent.verifiedDomain': 'Приложение подтверждено доменом',
  'consent.selfDeclared': 'Название указано самим приложением.',
  'consent.redirect': 'После подтверждения вы вернётесь на',
  'consent.known': 'Известное ИИ-приложение',
  'consent.loopback':
    'Приложение работает на компьютере (localhost). Подтверждайте, только если вы сами его запустили — например, Claude Code или IDE.',
  'consent.unknown': 'Подтверждайте, только если доверяете этому сайту.',
  'consent.workspace': 'Пространство',
  'consent.signedInAs': 'Вы вошли как {email}',
  'consent.approve': 'Разрешить',
  'consent.deny': 'Отклонить',
  'consent.revokeHint': 'Доступ можно отозвать в любой момент на главной странице хаба.',
  'consent.persona': 'Персона',
  'consent.personaHint': 'По этому адресу приложение видит только аккаунты этой персоны.',
  'consent.personaMissing': 'Этот адрес принадлежит персоне, которой нет в вашем пространстве.',
  'consent.clientAs': 'Запомнить приложение как',
  'consent.clientNew': 'новое приложение: {name}',
  'consent.clientHint': 'К нему применяются правила доступа выбранного приложения.',
  'confirm.title': 'Подтвердите действие',
  'confirm.listTitle': 'Действия, которые ждут вас',
  'confirm.none': 'Нет действий, ожидающих подтверждения.',
  'confirm.tg.ask': '🔐 Подтвердите действие',
  'confirm.tg.scheduled': '⏳ Выполнится через {seconds} с — ещё можно отменить',
  'confirm.tg.linked': 'Готово: подтверждения от вашего хаба AnyConnect будут приходить сюда.',
  'confirm.tg.linkFailed': 'Ссылка неверная или устарела. Откройте хаб и создайте новую.',
  'confirm.tg.unknown': 'Неизвестный или чужой запрос.',
  'confirm.tg.tooLate': 'Уже решено или истекло.',
  'confirm.client': 'Приложение',
  'confirm.service': 'Сервис',
  'confirm.action': 'Действие',
  'confirm.reason': 'Почему нужно ваше решение',
  'confirm.arguments': 'Аргументы (как их передала нейронка)',
  'confirm.open': 'Открыть в хабе',
  'confirm.approve': '✅ Разрешить',
  'confirm.deny': '❌ Отклонить',
  'confirm.cancel': '↩️ Отменить',
  'confirm.expires': 'Истекает',
  'confirm.runsAt': 'Выполнится',
  'confirm.status.awaiting_confirmation': 'Ждёт вашего подтверждения',
  'confirm.status.scheduled': 'Разрешено, ждёт окончания окна отмены',
  'confirm.status.running': 'Выполняется',
  'confirm.status.succeeded': '✅ Выполнено',
  'confirm.status.failed': '⚠️ Ошибка',
  'confirm.status.denied': '❌ Отклонено',
  'confirm.status.cancelled': '↩️ Отменено',
  'confirm.status.expired': '⌛ Истекло без ответа',
  'risk.read': 'чтение',
  'risk.write': 'изменение',
  'risk.dangerous': 'опасное',
  'home.security': 'Защита',
  'home.telegram': 'Telegram для подтверждений',
  'home.telegramLinked': 'Подключён: {label}',
  'home.telegramNotLinked': 'Не подключён: подтверждения только через веб-страницу.',
  'home.telegramLink': 'Подключить Telegram',
  'home.telegramOpen': 'Откройте эту ссылку в Telegram в течение 15 минут:',
  'home.telegramUnlink': 'Отключить',
  'home.telegramDisabled': 'У хаба нет Telegram-бота (не задан TELEGRAM_BOT_TOKEN).',
  'home.pending': 'Ждут подтверждения: {count}',
  'error.title': 'Что-то пошло не так',
  'error.back': 'На главную',
  'error.csrf': 'Форма устарела. Вернитесь назад, обновите страницу и попробуйте ещё раз.',
  'home.title': 'AnyConnect',
  'home.mcpUrl': 'Адрес MCP-сервера',
  'home.mcpUrlHint': 'Вставьте этот адрес в ИИ-приложение. Вас попросят войти здесь и разрешить доступ.',
  'home.howClaude': 'Claude: Настройки → Коннекторы → Добавить свой коннектор → вставьте адрес.',
  'home.howChatgpt':
    'ChatGPT: Настройки → Приложения и коннекторы → Расширенные → Режим разработчика, затем «Создать» → вставьте адрес, аутентификация OAuth.',
  'home.howOther':
    'Claude Code и другие клиенты: добавьте удалённый HTTP MCP-сервер с этим адресом (OAuth) или используйте личный токен.',
  'home.accounts': 'Подключённые аккаунты',
  'home.noAccounts': 'Аккаунтов пока нет.',
  'home.apps': 'Подключённые ИИ-приложения',
  'home.noApps': 'Приложения ещё не подключены.',
  'home.revoke': 'Отозвать',
  'home.lastUsed': 'последнее использование',
  'home.never': 'не использовалось',
  'home.calls': 'Последние вызовы инструментов',
  'home.noCalls': 'Вызовов пока нет.',
  'home.signOut': 'Выйти',
  'home.service': 'Сервис',
  'home.account': 'Аккаунт',
  'home.status': 'Статус',
  'home.disabled': 'выключен',
  'home.manageHint': 'Пока аккаунты управляются через REST API или CLI; веб-панель — следующий этап.',
};

const dictionaries: Record<Locale, Record<Key, string>> = { en, ru };

export type Translate = (key: Key, vars?: Record<string, string | number>) => string;

export function pickLocale(acceptLanguage: string | undefined): Locale {
  const preferred = (acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { lang: (tag ?? '').toLowerCase().split('-')[0] ?? '', q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { lang } of preferred) {
    if (lang === 'ru' || lang === 'uk' || lang === 'be' || lang === 'kk') return 'ru';
    if (lang === 'en') return 'en';
  }
  return 'en';
}

export function translator(locale: Locale): Translate {
  const dict = dictionaries[locale];
  return (key, vars) => {
    let text = dict[key] ?? en[key];
    if (vars)
      for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  };
}
