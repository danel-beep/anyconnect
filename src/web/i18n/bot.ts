/**
 * Texts the hub's Telegram bot sends: to people who open it without a link code (ads, a shared
 * `t.me/<bot>` link), and while it connects a Telegram account through Chat Automation (`bot.tc.*`,
 * Telegram HTML; values are escaped by the caller). `ru` must have exactly the keys of `en` (the
 * type enforces it).
 */
export const botEn = {
  'bot.landing.text':
    '<b>Manyplug</b> connects your mail, calendars, files and other services to ChatGPT and Claude, with several accounts per service.\n\nSign up on the site (it takes a minute), then add one address to your AI app. It works best from a computer.',
  'bot.landing.open': 'Open {host}',
  'bot.tc.confirm':
    '<b>Connect this Telegram account to {brand}?</b>\n\n{brand} account: {account}\n\nNext you add this bot under Settings → Chat Automation and pick the chats it may see. Your AI apps will read those chats and can reply as you. You can remove the bot there at any time.',
  'bot.tc.team': '{email}, team {team}',
  'bot.tc.moves':
    'This Telegram account is connected to another {brand} account now. Connecting moves it here.',
  'bot.tc.connect': 'Connect',
  'bot.tc.cancel': 'Cancel',
  'bot.tc.lastStep':
    '<b>Last step, in Telegram</b>\n\n1. Open Settings → Chat Automation (on some phones: Settings → Edit → Chat Automation).\n2. Add the bot {bot}.\n3. Pick the chats it may see, allow it to reply to messages and save.\n\nThe page on the site shows <b>Connected</b> by itself.',
  'bot.tc.connected':
    '<b>Connected.</b> {brand} now gets new messages from the chats you picked. Ask your AI app, for example: “What did I miss in Telegram today?”',
  'bot.tc.noReply':
    'The bot may not reply yet: allow it to reply to messages under Settings → Chat Automation, so your AI can answer for you.',
  'bot.tc.disconnect': 'Disconnect',
  'bot.tc.disconnected':
    'Disconnected: {brand} no longer gets messages from this Telegram account. To remove the bot completely, open Settings → Chat Automation.',
  'bot.tc.cancelled': 'Cancelled. Nothing was connected.',
  'bot.tc.expired':
    'This link has expired or was already used. Open the connect page on the site again to get a new QR code.',
  'bot.tc.otherUser':
    'This link was opened from another Telegram account. Open the connect page on the site again and scan the new QR code with the account you want to connect.',
  'bot.tc.orphan':
    'You added the {brand} bot under Chat Automation. To finish, open the connect page on the site and scan the QR code there.',
  'bot.tc.openSite': 'Open {host}',
  'bot.tc.failed': 'Could not connect: {reason}',
  'bot.tc.failedGeneric':
    'Something went wrong on our side. Open the connect page on the site and try again.',
  'bot.tc.status': 'This Telegram account is connected to {brand}: {account}.',
  'bot.tc.statusNone':
    'This Telegram account is not connected to {brand}. Open the connect page on the site to connect it.',
  'bot.tc.connectedShort': 'This Telegram account is connected already.',
  'bot.tc.unknown': 'This button no longer works.',
} as const;

export const botRu: Record<keyof typeof botEn, string> = {
  'bot.landing.text':
    '<b>Manyplug</b> подключает вашу почту, календари, файлы и другие сервисы к ChatGPT и Claude, по нескольку аккаунтов каждого сервиса.\n\nЗарегистрируйтесь на сайте (это минута) и добавьте один адрес в своё AI-приложение. Удобнее всего с компьютера.',
  'bot.landing.open': 'Открыть {host}',
  'bot.tc.confirm':
    '<b>Подключить этот аккаунт Telegram к {brand}?</b>\n\nАккаунт {brand}: {account}\n\nДальше вы добавите этого бота в «Настройки → Автоматизация чатов» и выберете чаты, которые он может видеть. Ваши AI-приложения смогут читать эти чаты и отвечать от вашего имени. Убрать бота можно там же в любой момент.',
  'bot.tc.team': '{email}, команда {team}',
  'bot.tc.moves':
    'Сейчас этот аккаунт Telegram подключён к другому аккаунту {brand}. После подключения он перейдёт сюда.',
  'bot.tc.connect': 'Подключить',
  'bot.tc.cancel': 'Отмена',
  'bot.tc.lastStep':
    '<b>Последний шаг, в Telegram</b>\n\n1. Откройте «Настройки → Автоматизация чатов» (на некоторых телефонах: «Настройки → Изменить → Автоматизация чатов»).\n2. Добавьте бота {bot}.\n3. Выберите чаты, которые он может видеть, разрешите ему отвечать на сообщения и сохраните.\n\nСтраница на сайте сама покажет <b>Подключено</b>.',
  'bot.tc.connected':
    '<b>Подключено.</b> Теперь {brand} получает новые сообщения из выбранных чатов. Спросите своё AI-приложение, например: «Что я пропустил в Telegram сегодня?»',
  'bot.tc.noReply':
    'Бот пока не может отвечать: разрешите ему отвечать на сообщения в «Настройки → Автоматизация чатов», чтобы ИИ мог отвечать за вас.',
  'bot.tc.disconnect': 'Отключить',
  'bot.tc.disconnected':
    'Отключено: {brand} больше не получает сообщения этого аккаунта Telegram. Чтобы убрать бота совсем, откройте «Настройки → Автоматизация чатов».',
  'bot.tc.cancelled': 'Отменено. Ничего не подключено.',
  'bot.tc.expired':
    'Ссылка устарела или уже использована. Откройте страницу подключения на сайте ещё раз, чтобы получить новый QR-код.',
  'bot.tc.otherUser':
    'Ссылку открыли из другого аккаунта Telegram. Откройте страницу подключения на сайте ещё раз и отсканируйте новый QR-код тем аккаунтом, который хотите подключить.',
  'bot.tc.orphan':
    'Вы добавили бота {brand} в «Автоматизацию чатов». Чтобы закончить, откройте страницу подключения на сайте и отсканируйте там QR-код.',
  'bot.tc.openSite': 'Открыть {host}',
  'bot.tc.failed': 'Не удалось подключить: {reason}',
  'bot.tc.failedGeneric':
    'Что-то пошло не так на нашей стороне. Откройте страницу подключения на сайте и попробуйте ещё раз.',
  'bot.tc.status': 'Этот аккаунт Telegram подключён к {brand}: {account}.',
  'bot.tc.statusNone':
    'Этот аккаунт Telegram не подключён к {brand}. Откройте страницу подключения на сайте, чтобы подключить его.',
  'bot.tc.connectedShort': 'Этот аккаунт Telegram уже подключён.',
  'bot.tc.unknown': 'Эта кнопка больше не работает.',
};
