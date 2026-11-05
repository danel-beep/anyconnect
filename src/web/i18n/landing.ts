/**
 * Texts of the landing page (`src/web/landing.tsx`). `ru` must have exactly the keys of `en`.
 * Site honesty rule: claim only what works on this server (no invented numbers or customers).
 */
export const landingEn = {
  'landing.title': 'Manyplug: all your accounts in any AI assistant',
  'landing.description':
    'One MCP address for Gmail, Slack, Notion, GitHub and more. Several accounts per service, encrypted keys, and risky actions wait for your OK.',
  'landing.eyebrow': 'For people with more than one of everything',
  'landing.h1a': 'All your inboxes, chats and docs,',
  'landing.h1b': 'in any AI assistant.',
  'landing.lead':
    'Connect work and personal Gmail, two Slack workspaces, a client’s Notion and {n} more services. Paste one link into Claude, ChatGPT or Cursor. Anything that sends or deletes waits for your OK.',
  'landing.how': 'See how it works',
  'landing.note.free': 'Free plan, no card',
  'landing.note.fast': '5-minute setup',
  'landing.note.trial': 'First {days} days on {plan}',
  'landing.note.encrypted': 'Your logins never reach the AI',

  'landing.demo.label':
    'Example chat: Claude searches two inboxes, reads an invoice, asks before sending it to Alex on Slack, and sends it once you allow it',
  'landing.demo.title': 'Claude',
  'landing.demo.connected': 'Manyplug connected',
  'landing.demo.ask': 'Find the Lumina invoice and send it to Alex on Slack',
  'landing.demo.found': '3 emails',
  'landing.demo.read': '$1,240 · due Nov 15',
  'landing.demo.approveWho': 'Manyplug · asks before sending',
  'landing.demo.approveText': 'Send “Lumina invoice INV-2041” to @alex on Slack?',
  'landing.demo.deny': 'Deny',
  'landing.demo.allow': 'Allow',
  'landing.demo.approved': 'Approved by you',
  'landing.demo.sent': 'sent',
  'landing.demo.answer':
    'Done. I sent Alex the Lumina invoice INV-2041 for $1,240. It’s due November\u00a015.',
  'landing.demo.input': 'Reply to Claude…',
  'landing.demo.replay': 'Replay the demo',

  'landing.works': 'Works with any AI app that supports MCP, the open standard for AI tools',

  'landing.map.eyebrow': 'Why Manyplug',
  'landing.map.title': 'Set up once, use it in every AI app',
  'landing.map.lead':
    'Manyplug sits between your AI apps and your accounts. Each app connects once, to one link, and reaches every account through it under the same rules.',
  'landing.map.api': 'Your MCP or API',
  'landing.map.anyApp': 'Any MCP app',
  'landing.map.before': 'Without Manyplug',
  'landing.map.beforeStat': 'One account per service, set up again in every app',
  'landing.map.beforeText':
    'You add Gmail to Claude, then again to ChatGPT and again to Cursor, and each one sees a single inbox. Five apps and five services: 25 setups to keep working.',
  'landing.map.after': 'With Manyplug',
  'landing.map.afterStat': 'Every account, in every AI app',
  'landing.map.afterText':
    'Connect each service once, with all its accounts. Paste one link into each AI app, and they all see the same accounts under the same rules.',
  'landing.map.compare': 'Compare with Zapier MCP, Composio and others',

  'landing.how.eyebrow': 'How it works',
  'landing.how.title': 'Up and running in five minutes',
  'landing.how.lead': 'No servers, no config files, no code.',
  'landing.step1.title': 'Sign in with Google',
  'landing.step1.text': 'One click, no forms. Your first {days} days include everything in {plan}.',
  'landing.step1.plain': 'One click, no forms. Your Manyplug account is ready right away.',
  'landing.step1.visual': 'Signed in as you@gmail.com',
  'landing.step2.title': 'Connect your services',
  'landing.step2.text': 'Sign in to Gmail, Slack or Notion, or paste an API key. Two mailboxes? Add both.',
  'landing.step3.title': 'Paste one link into your AI',
  'landing.step3.text': 'Add your Manyplug link to Claude, ChatGPT or Cursor once, then just ask:',
  'landing.step3.prompt': '“What did I promise clients this week?”',
  'landing.step3.guides': 'Setup guide for each app',

  'landing.features.eyebrow': 'Features',
  'landing.features.title': 'Built for real setups',
  'landing.features.lead': 'Two inboxes, a client’s workspace, and AI apps you trust to different degrees.',
  'landing.f.accounts.title': 'Every account, side by side',
  'landing.f.accounts.text':
    'Work and personal Gmail, two Slack workspaces, a client’s Notion. Ask about one account or all of them at once.',
  'landing.f.accounts.found': '{n} {n|email|emails}',
  'landing.f.confirm.title': 'You approve the risky stuff',
  'landing.f.confirm.text':
    'Sending an email, deleting a file, issuing a refund: these wait until you tap Allow. You choose what asks first, per app and account.',
  'landing.f.confirm.read': 'Search and read',
  'landing.f.confirm.send': 'Send email',
  'landing.f.confirm.personal': 'Send from gmail:personal',
  'landing.f.confirm.allow': 'Allowed',
  'landing.f.confirm.ask': 'Asks first',
  'landing.f.confirm.block': 'Blocked',
  'landing.f.chat.title': 'Set it up by asking',
  'landing.f.chat.text':
    'Ask your AI to add an account, rename one or disconnect an old one. Anything that loosens your safety settings still needs your approval.',
  'landing.f.chat.prompt': 'Connect my second Gmail and call it Clients',
  'landing.f.chat.reply': 'Here’s your Google sign-in link. Once you finish, “Clients” is ready.',
  'landing.f.personas.title': 'Different access for each AI',
  'landing.f.personas.text':
    'Give each AI app its own link: your work assistant gets mail and calendar, your coding agent gets GitHub, and your personal one can only read one inbox.',
  'landing.f.personas.work': 'asks before sending',
  'landing.f.personas.code': 'asks before deleting',
  'landing.f.personas.personal': 'read only',
  'landing.f.api.title': 'Bring your own MCP servers and APIs',
  'landing.f.api.text':
    'Add a private MCP server or any REST API by its address and key. It follows the same rules as built-in services.',
  'landing.f.api.status': 'connected',
  'landing.f.context.title': 'Long chats stay sharp',
  'landing.f.context.text':
    'Loading every tool up front can eat 60k+ tokens of the AI’s working memory before you type. Manyplug loads a short menu and fetches details only when needed.',
  'landing.f.context.label': 'Loaded before your first message',
  'landing.f.context.all': 'All tools at once',
  'landing.f.context.allTokens': '60k+ tokens',
  'landing.f.context.ourTokens': '≤ 3k',

  'landing.services.eyebrow': 'Services',
  'landing.services.title': '{n} services, several accounts each',
  'landing.services.lead': 'Plus any IMAP mailbox, any MCP server and any REST API.',
  'landing.services.all': 'See all {n}',

  'landing.security.eyebrow': 'Security',
  'landing.security.title': 'Your accounts stay yours',
  'landing.security.lead':
    'Manyplug sits between your AI and your data, so it’s built for the worst case: leaks, bugs and instructions hidden in emails.',
  'landing.sec.encryption.title': 'Encrypted per account',
  'landing.sec.encryption.text':
    'Every token and password is encrypted with its own key. A stolen database alone is useless.',
  'landing.sec.secrets.title': 'The AI never sees your logins',
  'landing.sec.secrets.text':
    'You enter keys on our page, not in the chat. They’re stored encrypted and sent only to the service they belong to.',
  'landing.sec.injection.title': 'Hidden instructions flagged',
  'landing.sec.injection.text':
    'Text from emails and web pages reaches your AI marked as untrusted, and anything risky still asks you first.',
  'landing.sec.audit.title': 'Activity log',
  'landing.sec.audit.text': 'See which AI did what and when, without storing the contents of your mail.',
  'landing.sec.delete.title': 'Disconnect means deleted',
  'landing.sec.delete.text':
    'Remove an account and its keys are erased immediately. Delete your Manyplug account and everything goes with it.',
  'landing.sec.status.title': 'Public status page',
  'landing.sec.status.text':
    'The site and the MCP endpoint are checked every minute, and the results are public.',
  'landing.sec.status.link': 'See status',
  'landing.log.title': 'Activity',
  'landing.log.label':
    'Example activity log: Claude searched gmail:work, then sent to slack:team after your approval; Cursor opened a GitHub issue; a rule blocked ChatGPT from sending from gmail:personal.',
  'landing.log.ok': 'done',
  'landing.log.approved': 'approved',
  'landing.log.blocked': 'blocked by rule',

  'landing.pricing.eyebrow': 'Pricing',
  'landing.pricing.title': 'Start free, pay when it saves you time',
  'landing.pricing.lead':
    'Every plan includes every service and every safety feature; plans differ in actions, accounts and history. An action is one step the AI takes, like a search or a sent message. The invoice request at the top took three.',

  'landing.faq.eyebrow': 'FAQ',
  'landing.faq.title': 'Common questions',
  'landing.faq.more': 'Something else?',
  'landing.faq.write': 'Write to us',
  'landing.faq.support': 'Visit support',

  'landing.cta.title': 'Plug your AI into every account you use',
  'landing.cta.text': 'Free plan, no card, no time limit.',
  'landing.steps.cta': 'Free plan, no card needed',
} as const;

export type LandingKey = keyof typeof landingEn;

export const landingRu: Record<LandingKey, string> = {
  'landing.title': 'Manyplug: все ваши аккаунты в любом ИИ-ассистенте',
  'landing.description':
    'Один MCP-адрес для Gmail, Slack, Notion, GitHub и других сервисов. Несколько аккаунтов в каждом, ключи зашифрованы, рискованные действия ждут вашего согласия.',
  'landing.eyebrow': 'Для тех, у кого всего больше одного',
  'landing.h1a': 'Вся ваша почта, чаты и документы —',
  'landing.h1b': 'в любом ИИ‑ассистенте.',
  'landing.lead':
    'Подключите рабочий и личный Gmail, два пространства Slack, Notion клиента и ещё {n} {n|сервис|сервиса|сервисов}. Вставьте одну ссылку в Claude, ChatGPT или Cursor. Всё, что отправляет или удаляет, ждёт вашего «да».',
  'landing.how': 'Как это работает',
  'landing.note.free': 'Бесплатно, без карты',
  'landing.note.fast': 'Настройка за 5 минут',
  'landing.note.trial': 'Первые {days} дней на «{plan}»',
  'landing.note.encrypted': 'Пароли и ключи не видны ИИ',

  'landing.demo.label':
    'Пример чата: Claude ищет в двух ящиках, читает счёт, спрашивает перед отправкой Алексу в Slack и отправляет, когда вы разрешили',
  'landing.demo.title': 'Claude',
  'landing.demo.connected': 'Manyplug подключён',
  'landing.demo.ask': 'Найди счёт от Lumina и отправь Алексу в Slack',
  'landing.demo.found': '3 письма',
  'landing.demo.read': '$1 240 · до 15 ноября',
  'landing.demo.approveWho': 'Manyplug · спрашивает перед отправкой',
  'landing.demo.approveText': 'Отправить «Счёт Lumina INV-2041» пользователю @alex в Slack?',
  'landing.demo.deny': 'Отклонить',
  'landing.demo.allow': 'Разрешить',
  'landing.demo.approved': 'Вы разрешили',
  'landing.demo.sent': 'отправлено',
  'landing.demo.answer':
    'Готово. Отправил Алексу счёт Lumina INV-2041 на $1 240. Оплатить нужно до 15 ноября.',
  'landing.demo.input': 'Ответить Claude…',
  'landing.demo.replay': 'Показать ещё раз',

  'landing.works':
    'Работает с любым ИИ-приложением, которое поддерживает MCP — открытый стандарт для инструментов ИИ',

  'landing.map.eyebrow': 'Зачем Manyplug',
  'landing.map.title': 'Настройте один раз — работает в любом ИИ',
  'landing.map.lead':
    'Manyplug стоит между вашими ИИ-приложениями и аккаунтами. Каждое приложение подключается один раз, к одной ссылке, и через неё получает все аккаунты по одним правилам.',
  'landing.map.api': 'Ваш MCP или API',
  'landing.map.anyApp': 'Любое MCP-приложение',
  'landing.map.before': 'Без Manyplug',
  'landing.map.beforeStat': 'Один аккаунт на сервис, и в каждом приложении заново',
  'landing.map.beforeText':
    'Вы подключаете Gmail к Claude, потом ещё раз к ChatGPT и к Cursor, и каждый видит только один ящик. Пять приложений и пять сервисов — 25 настроек, которые нужно поддерживать.',
  'landing.map.after': 'С Manyplug',
  'landing.map.afterStat': 'Все аккаунты в любом ИИ-приложении',
  'landing.map.afterText':
    'Каждый сервис подключается один раз, со всеми аккаунтами. Вставьте одну ссылку в каждое ИИ-приложение, и все они увидят одни и те же аккаунты по одним правилам.',
  'landing.map.compare': 'Сравнение с Zapier MCP, Composio и другими',

  'landing.how.eyebrow': 'Как это работает',
  'landing.how.title': 'Всё готово за пять минут',
  'landing.how.lead': 'Без серверов, конфигов и кода.',
  'landing.step1.title': 'Войдите через Google',
  'landing.step1.text': 'Один клик, без анкет. Первые {days} дней доступно всё из тарифа «{plan}».',
  'landing.step1.plain': 'Один клик, без анкет. Аккаунт Manyplug готов сразу.',
  'landing.step1.visual': 'Вы вошли как you@gmail.com',
  'landing.step2.title': 'Подключите сервисы',
  'landing.step2.text': 'Войдите в Gmail, Slack или Notion либо вставьте API-ключ. Два ящика? Добавьте оба.',
  'landing.step3.title': 'Вставьте одну ссылку в ИИ',
  'landing.step3.text': 'Один раз добавьте ссылку Manyplug в Claude, ChatGPT или Cursor и просто спросите:',
  'landing.step3.prompt': '«Что я обещал клиентам на этой неделе?»',
  'landing.step3.guides': 'Инструкции для каждого приложения',

  'landing.features.eyebrow': 'Возможности',
  'landing.features.title': 'Под настоящую жизнь',
  'landing.features.lead':
    'Два ящика, пространство клиента и ИИ-приложения, которым вы доверяете по-разному.',
  'landing.f.accounts.title': 'Все аккаунты рядом',
  'landing.f.accounts.text':
    'Рабочий и личный Gmail, два пространства Slack, Notion клиента. Спрашивайте про один аккаунт или про все сразу.',
  'landing.f.accounts.found': '{n} {n|письмо|письма|писем}',
  'landing.f.confirm.title': 'Рискованное — с вашего согласия',
  'landing.f.confirm.text':
    'Отправка письма, удаление файла, возврат денег ждут, пока вы не нажмёте «Разрешить». Что спрашивать, решаете вы, для каждого приложения и аккаунта.',
  'landing.f.confirm.read': 'Поиск и чтение',
  'landing.f.confirm.send': 'Отправка писем',
  'landing.f.confirm.personal': 'Отправка из gmail:personal',
  'landing.f.confirm.allow': 'Можно',
  'landing.f.confirm.ask': 'Спросит',
  'landing.f.confirm.block': 'Нельзя',
  'landing.f.chat.title': 'Настройка — просто просьбой',
  'landing.f.chat.text':
    'Попросите ИИ добавить аккаунт, переименовать его или отключить старый. Всё, что ослабляет защиту, всё равно требует вашего подтверждения.',
  'landing.f.chat.prompt': 'Подключи мой второй Gmail и назови его «Клиенты»',
  'landing.f.chat.reply': 'Вот ссылка для входа в Google. Как только войдёте, «Клиенты» готов.',
  'landing.f.personas.title': 'Разный доступ для разных ИИ',
  'landing.f.personas.text':
    'У каждого ИИ-приложения своя ссылка: рабочий ассистент видит почту и календарь, агент для кода — GitHub, а личный может только читать один ящик.',
  'landing.f.personas.work': 'спрашивает перед отправкой',
  'landing.f.personas.code': 'спрашивает перед удалением',
  'landing.f.personas.personal': 'только чтение',
  'landing.f.api.title': 'Свои MCP-серверы и API',
  'landing.f.api.text':
    'Добавьте свой MCP-сервер или любой REST API по адресу и ключу. Для них действуют те же правила, что и для встроенных сервисов.',
  'landing.f.api.status': 'подключён',
  'landing.f.context.title': 'Длинные чаты не теряют нить',
  'landing.f.context.text':
    'Все инструменты сразу могут занять 60 тыс.+ токенов рабочей памяти ИИ ещё до вашего вопроса. Manyplug загружает короткое меню и подтягивает подробности, только когда они нужны.',
  'landing.f.context.label': 'Загружается до первого сообщения',
  'landing.f.context.all': 'Все сразу',
  'landing.f.context.allTokens': '60 тыс.+ токенов',
  'landing.f.context.ourTokens': '≤ 3 тыс.',

  'landing.services.eyebrow': 'Сервисы',
  'landing.services.title': '{n} {n|сервис|сервиса|сервисов}, в каждом\u00a0— несколько аккаунтов',
  'landing.services.lead': 'А ещё любой почтовый ящик по IMAP, любой MCP-сервер и любой REST API.',
  'landing.services.all': 'Все {n}',

  'landing.security.eyebrow': 'Безопасность',
  'landing.security.title': 'Ваши аккаунты остаются вашими',
  'landing.security.lead':
    'Manyplug стоит между ИИ и вашими данными, поэтому он рассчитан на худшее: утечки, ошибки и команды, спрятанные в письмах.',
  'landing.sec.encryption.title': 'Шифрование каждого аккаунта',
  'landing.sec.encryption.text':
    'Каждый токен и пароль зашифрован своим ключом. Украденная база сама по себе бесполезна.',
  'landing.sec.secrets.title': 'ИИ не видит пароли и ключи',
  'landing.sec.secrets.text':
    'Ключи вводятся на нашей странице, а не в чате. Они хранятся зашифрованными и уходят только в тот сервис, к которому относятся.',
  'landing.sec.injection.title': 'Скрытые инструкции помечаются',
  'landing.sec.injection.text':
    'Текст из писем и веб-страниц приходит к ИИ с пометкой «недоверенный», а всё рискованное всё равно сначала спрашивает вас.',
  'landing.sec.audit.title': 'Журнал действий',
  'landing.sec.audit.text': 'Видно, какой ИИ что и когда сделал, при этом содержимое писем не хранится.',
  'landing.sec.delete.title': 'Отключили — значит, удалили',
  'landing.sec.delete.text':
    'Уберите аккаунт, и его ключи сразу стираются. Удалите аккаунт Manyplug — и вместе с ним исчезнет всё.',
  'landing.sec.status.title': 'Публичная страница статуса',
  'landing.sec.status.text': 'Сайт и MCP-адрес проверяются каждую минуту, результаты открыты всем.',
  'landing.sec.status.link': 'Статус',
  'landing.log.title': 'Журнал',
  'landing.log.label':
    'Пример журнала: Claude искал в gmail:work, затем отправил в slack:team после вашего разрешения; Cursor создал задачу в GitHub; правило запретило ChatGPT отправку из gmail:personal.',
  'landing.log.ok': 'готово',
  'landing.log.approved': 'разрешено',
  'landing.log.blocked': 'запрещено правилом',

  'landing.pricing.eyebrow': 'Тарифы',
  'landing.pricing.title': 'Начните бесплатно, платите, когда это экономит время',
  'landing.pricing.lead':
    'В каждом тарифе все сервисы и все функции защиты; тарифы отличаются числом действий, аккаунтов и сроком истории. Действие — один шаг ИИ, например поиск или отправленное сообщение. Запрос про счёт в начале страницы занял три.',

  'landing.faq.eyebrow': 'Вопросы',
  'landing.faq.title': 'Частые вопросы',
  'landing.faq.more': 'Остался вопрос?',
  'landing.faq.write': 'Напишите нам',
  'landing.faq.support': 'Поддержка',

  'landing.cta.title': 'Подключите ИИ ко всем своим аккаунтам',
  'landing.cta.text': 'Бесплатный тариф, без карты и без срока.',
  'landing.steps.cta': 'Бесплатный тариф, без карты',
};
