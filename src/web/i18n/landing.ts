/**
 * Texts of the landing page (`src/web/landing.tsx`). `ru` must have exactly the keys of `en`.
 * Site honesty rule: claim only what works on this server (no invented numbers or customers).
 */
export const landingEn = {
  'landing.title': 'Manyplug: connect all your services to AI in one step',
  'landing.description':
    'One MCP address for Gmail, Slack, Notion, GitHub and more. Several accounts per service, encrypted keys, and risky actions wait for your OK.',
  'landing.eyebrow': 'Every account, every AI app',
  'landing.h1a': 'All your inboxes, chats and docs,',
  'landing.h1b': 'in any AI assistant.',
  'landing.lead':
    'Connect Gmail, Slack, Notion and {n} more services, with work and personal accounts side by side. Paste one link into Claude, ChatGPT or Cursor. Anything that sends or deletes waits for your OK.',
  'landing.how': 'See how it works',
  'landing.note.free': 'Free plan, no card needed',
  'landing.note.fast': 'Set up in about five minutes',
  'landing.note.encrypted': 'Your logins never reach the AI',

  'landing.demo.label':
    'Example chat: Claude searches two inboxes, reads an invoice, asks before sending it to Alex on Slack, and sends it once you allow it',
  'landing.demo.title': 'Claude',
  'landing.demo.connected': 'Manyplug connected',
  'landing.demo.ask': 'Find the ACME invoice in my mail and send it to Alex on Slack',
  'landing.demo.found': '3 emails',
  'landing.demo.read': '$1,240 · due Nov 15',
  'landing.demo.approveWho': 'Manyplug · asks before sending',
  'landing.demo.approveText': 'Send “ACME invoice INV-2041” to @alex on Slack?',
  'landing.demo.deny': 'Deny',
  'landing.demo.allow': 'Allow',
  'landing.demo.approved': 'Approved by you',
  'landing.demo.sent': 'sent',
  'landing.demo.answer': 'Done. I sent Alex the ACME invoice INV-2041 for $1,240. It’s due November\u00a015.',
  'landing.demo.input': 'Reply to Claude…',

  'landing.works': 'Works with any AI app that supports MCP, the open standard for AI tools',

  'landing.map.eyebrow': 'Why Manyplug',
  'landing.map.title': 'Set up once, use it in every AI app',
  'landing.map.lead':
    'The connectors built into Claude or ChatGPT work only in that app, usually with one account per service. Manyplug gives every AI app all your accounts, with the same rules everywhere.',
  'landing.map.core': 'your MCP link',
  'landing.map.api': 'Your MCP or API',
  'landing.map.before': 'Without Manyplug',
  'landing.map.beforeStat': '25 connections to set up (5 apps × 5 services)',
  'landing.map.beforeText':
    'Each AI app connects to each service on its own, often with one account per service.',
  'landing.map.after': 'With Manyplug',
  'landing.map.afterStat': '5 sign-ins, and the same link in every app',
  'landing.map.afterText':
    'Connect each service once. Every AI app you add the link to gets every account, with your rules.',
  'landing.map.compare': 'Compare with Zapier MCP, Composio and others',

  'landing.how.eyebrow': 'How it works',
  'landing.how.title': 'Up and running in five minutes',
  'landing.how.lead': 'No servers, no config files, no code.',
  'landing.step1.title': 'Sign in with Google',
  'landing.step1.text':
    'Your Manyplug account is ready right away. The free plan is enough to try everything.',
  'landing.step1.visual': 'Signed in as you@gmail.com',
  'landing.step2.title': 'Connect your services',
  'landing.step2.text': 'Sign in to Gmail, Slack or Notion, or paste an API key. Two mailboxes? Add both.',
  'landing.step3.title': 'Paste one link into your AI',
  'landing.step3.text': 'Add your Manyplug link to Claude, ChatGPT or Cursor once, then just ask:',
  'landing.step3.prompt': '“What did I promise clients this week?”',

  'landing.features.eyebrow': 'Features',
  'landing.features.title': 'Made for people with more than one of everything',
  'landing.features.lead':
    'Several accounts per service, separate rules per app, and your OK before anything risky.',
  'landing.f.accounts.title': 'Every account, side by side',
  'landing.f.accounts.text':
    'Work and personal Gmail, two Slack workspaces, a client’s Notion. Ask about one account or all of them at once.',
  'landing.f.accounts.found': '{n} {n|email|emails}',
  'landing.f.confirm.title': 'You approve the risky stuff',
  'landing.f.confirm.text':
    'Sending an email, deleting a file, issuing a refund: these wait for your OK. You choose what asks first, per app and account.',
  'landing.f.confirm.read': 'Search and read',
  'landing.f.confirm.send': 'Send email',
  'landing.f.confirm.personal': 'Send from gmail:personal',
  'landing.f.confirm.allow': 'Allowed',
  'landing.f.confirm.ask': 'Asks first',
  'landing.f.confirm.block': 'Blocked',
  'landing.f.chat.title': 'Set it up by asking',
  'landing.f.chat.text':
    'Ask your AI to add an account, rename one or disconnect an old one. Anything that loosens your safety settings still needs your OK.',
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
  'landing.f.context.title': 'Light on your AI’s memory',
  'landing.f.context.text':
    'Loading every tool up front fills your AI’s memory before you ask anything. Manyplug gives it a short menu and loads details only when needed.',
  'landing.f.context.label': 'Loaded before your first message',
  'landing.f.context.all': 'Every tool',
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
  'landing.sec.injection.title': 'Prompt-injection guard',
  'landing.sec.injection.text':
    'Text from emails and web pages reaches your AI marked as untrusted, and anything risky still waits for your OK.',
  'landing.sec.audit.title': 'Activity log',
  'landing.sec.audit.text': 'See which AI did what and when, without storing the contents of your mail.',
  'landing.sec.delete.title': 'Disconnect means deleted',
  'landing.sec.delete.text':
    'Remove an account and its keys are erased immediately. Delete your Manyplug account and everything goes with it.',
  'landing.sec.status.title': 'Status in the open',
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
    'Every plan has every service and every security feature; plans differ only in volume. An action is one step the AI takes in a service, like a search or a sent message: the invoice request above took three.',

  'landing.faq.eyebrow': 'FAQ',
  'landing.faq.title': 'Questions people ask',
  'landing.faq.more': 'Something else?',
  'landing.faq.write': 'Write to us',
  'landing.faq.support': 'Visit support',

  'landing.cta.title': 'Plug your AI into every account you use',
  'landing.cta.text': 'Free plan, no card, no time limit.',
  'landing.steps.cta': 'Free plan, no card needed',
} as const;

export type LandingKey = keyof typeof landingEn;

export const landingRu: Record<LandingKey, string> = {
  'landing.title': 'Manyplug: все ваши сервисы в ИИ за один шаг',
  'landing.description':
    'Один MCP-адрес для Gmail, Slack, Notion, GitHub и других сервисов. Несколько аккаунтов в каждом, ключи зашифрованы, рискованные действия ждут вашего согласия.',
  'landing.eyebrow': 'Все аккаунты, любой ИИ',
  'landing.h1a': 'Вся ваша почта, чаты и документы —',
  'landing.h1b': 'в любом ИИ‑ассистенте.',
  'landing.lead':
    'Подключите Gmail, Slack, Notion и ещё {n} {n|сервис|сервиса|сервисов} — рабочие и личные аккаунты рядом. Вставьте одну ссылку в Claude, ChatGPT или Cursor. Всё, что отправляет или удаляет, ждёт вашего «да».',
  'landing.how': 'Как это работает',
  'landing.note.free': 'Бесплатный тариф, без карты',
  'landing.note.fast': 'Настройка — минут пять',
  'landing.note.encrypted': 'Пароли и ключи не видны ИИ',

  'landing.demo.label':
    'Пример чата: Claude ищет в двух ящиках, читает счёт, спрашивает перед отправкой Алексу в Slack и отправляет, когда вы разрешили',
  'landing.demo.title': 'Claude',
  'landing.demo.connected': 'Manyplug подключён',
  'landing.demo.ask': 'Найди счёт от ACME в почте и отправь Алексу в Slack',
  'landing.demo.found': '3 письма',
  'landing.demo.read': '$1 240 · до 15 ноября',
  'landing.demo.approveWho': 'Manyplug · спрашивает перед отправкой',
  'landing.demo.approveText': 'Отправить «Счёт ACME INV-2041» пользователю @alex в Slack?',
  'landing.demo.deny': 'Отклонить',
  'landing.demo.allow': 'Разрешить',
  'landing.demo.approved': 'Вы разрешили',
  'landing.demo.sent': 'отправлено',
  'landing.demo.answer': 'Готово. Отправил Алексу счёт ACME INV-2041 на $1 240. Оплатить нужно до 15 ноября.',
  'landing.demo.input': 'Ответить Claude…',

  'landing.works':
    'Работает с любым ИИ-приложением, которое поддерживает MCP — открытый стандарт для инструментов ИИ',

  'landing.map.eyebrow': 'Зачем Manyplug',
  'landing.map.title': 'Настройте один раз — работает в любом ИИ',
  'landing.map.lead':
    'Коннекторы, встроенные в Claude или ChatGPT, работают только в этом приложении и обычно с одним аккаунтом на сервис. Manyplug даёт любому ИИ-приложению все ваши аккаунты и везде одни и те же правила.',
  'landing.map.core': 'ваша MCP-ссылка',
  'landing.map.api': 'Ваш MCP или API',
  'landing.map.before': 'Без Manyplug',
  'landing.map.beforeStat': '25 подключений (5 приложений × 5 сервисов)',
  'landing.map.beforeText':
    'Каждое ИИ-приложение подключается к каждому сервису отдельно, часто только с одним аккаунтом.',
  'landing.map.after': 'С Manyplug',
  'landing.map.afterStat': '5 входов в сервисы и одна ссылка во всех приложениях',
  'landing.map.afterText':
    'Каждый сервис подключается один раз. Любое ИИ-приложение с этой ссылкой видит все аккаунты и ваши правила.',
  'landing.map.compare': 'Сравнение с Zapier MCP, Composio и другими',

  'landing.how.eyebrow': 'Как это работает',
  'landing.how.title': 'Всё готово за пять минут',
  'landing.how.lead': 'Без серверов, конфигов и кода.',
  'landing.step1.title': 'Войдите через Google',
  'landing.step1.text': 'Аккаунт Manyplug создаётся сразу. Бесплатного тарифа хватит, чтобы попробовать всё.',
  'landing.step1.visual': 'Вы вошли как you@gmail.com',
  'landing.step2.title': 'Подключите сервисы',
  'landing.step2.text': 'Войдите в Gmail, Slack или Notion либо вставьте API-ключ. Два ящика? Добавьте оба.',
  'landing.step3.title': 'Вставьте одну ссылку в ИИ',
  'landing.step3.text': 'Один раз добавьте ссылку Manyplug в Claude, ChatGPT или Cursor и просто спросите:',
  'landing.step3.prompt': '«Что я обещал клиентам на этой неделе?»',

  'landing.features.eyebrow': 'Возможности',
  'landing.features.title': 'Для тех, у кого всего больше одного',
  'landing.features.lead':
    'Несколько аккаунтов в каждом сервисе, свои правила для каждого приложения и ваше «да» перед рискованным.',
  'landing.f.accounts.title': 'Все аккаунты рядом',
  'landing.f.accounts.text':
    'Рабочий и личный Gmail, два пространства Slack, Notion клиента. Спрашивайте про один аккаунт или про все сразу.',
  'landing.f.accounts.found': '{n} {n|письмо|письма|писем}',
  'landing.f.confirm.title': 'Рискованное — с вашего согласия',
  'landing.f.confirm.text':
    'Отправка письма, удаление файла, возврат денег ждут вашего «да». Что спрашивать, решаете вы, для каждого приложения и аккаунта.',
  'landing.f.confirm.read': 'Поиск и чтение',
  'landing.f.confirm.send': 'Отправка писем',
  'landing.f.confirm.personal': 'Отправка из gmail:personal',
  'landing.f.confirm.allow': 'Можно',
  'landing.f.confirm.ask': 'Спросит',
  'landing.f.confirm.block': 'Нельзя',
  'landing.f.chat.title': 'Настройка — просто просьбой',
  'landing.f.chat.text':
    'Попросите ИИ добавить аккаунт, переименовать его или отключить старый. Всё, что ослабляет защиту, всё равно ждёт вашего «да».',
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
  'landing.f.context.title': 'Не забивает память ИИ',
  'landing.f.context.text':
    'Все инструменты сразу заняли бы память ИИ ещё до вашего вопроса. Manyplug даёт ему короткое меню и загружает подробности, только когда они нужны.',
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
  'landing.sec.injection.title': 'Защита от prompt injection',
  'landing.sec.injection.text':
    'Текст из писем и веб-страниц приходит к ИИ с пометкой «недоверенный», а всё рискованное всё равно ждёт вашего «да».',
  'landing.sec.audit.title': 'Журнал действий',
  'landing.sec.audit.text': 'Видно, какой ИИ что и когда сделал, при этом содержимое писем не хранится.',
  'landing.sec.delete.title': 'Отключили — значит, удалили',
  'landing.sec.delete.text':
    'Уберите аккаунт, и его ключи сразу стираются. Удалите аккаунт Manyplug — и вместе с ним исчезнет всё.',
  'landing.sec.status.title': 'Открытый статус',
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
    'В каждом тарифе все сервисы и все функции защиты, тарифы отличаются только объёмом. Действие — это один шаг ИИ в сервисе, например поиск или отправленное сообщение: запрос про счёт выше занял три.',

  'landing.faq.eyebrow': 'Вопросы',
  'landing.faq.title': 'Частые вопросы',
  'landing.faq.more': 'Остался вопрос?',
  'landing.faq.write': 'Напишите нам',
  'landing.faq.support': 'Поддержка',

  'landing.cta.title': 'Подключите ИИ ко всем своим аккаунтам',
  'landing.cta.text': 'Бесплатный тариф, без карты и без срока.',
  'landing.steps.cta': 'Бесплатный тариф, без карты',
};
