/**
 * Texts of the landing page (`src/web/landing.tsx`). `ru` must have exactly the keys of `en`.
 * Site honesty rule: claim only what works on this server (no invented numbers or customers).
 */
export const landingEn = {
  'landing.title': 'Manyplug: connect all your services to AI in one step',
  'landing.description':
    'One MCP address for Gmail, Slack, Notion, GitHub and more. Several accounts per service, encrypted keys, and risky actions wait for your OK.',
  'landing.eyebrow': 'MCP hub for Claude, ChatGPT and Cursor',
  'landing.h1a': 'All your inboxes, chats and docs,',
  'landing.h1b': 'in any AI assistant.',
  'landing.lead':
    'One MCP link gives Claude, ChatGPT and Cursor your Gmail, Slack, Notion and {n} more services, with several accounts each. Your AI searches, reads and drafts on its own; anything that sends or deletes waits for your OK.',
  'landing.how': 'See how it works',
  'landing.note.free': 'Free plan, no time limit',
  'landing.note.card': 'No card needed',
  'landing.note.encrypted': 'Your logins never reach the AI',

  'landing.demo.label':
    'Example chat: Claude searches two inboxes, reads an invoice, asks you before sending it to Alex on Slack, and sends it after you tap Allow',
  'landing.demo.title': 'Claude',
  'landing.demo.connected': 'Manyplug connected',
  'landing.demo.ask': 'Find the ACME invoice in my mail and send it to Alex on Slack',
  'landing.demo.found': '3 emails · 2 inboxes',
  'landing.demo.read': '$1,240 · due Nov 15',
  'landing.demo.approveWho': 'Manyplug · needs your OK',
  'landing.demo.approveText': 'Send “ACME invoice INV-2041” to @alex on Slack?',
  'landing.demo.deny': 'Deny',
  'landing.demo.allow': 'Allow',
  'landing.demo.sent': 'sent',
  'landing.demo.answer': 'Done. I sent Alex the ACME invoice INV-2041 for $1,240. It is due on November 15.',
  'landing.demo.input': 'Reply to Claude…',

  'landing.works': 'Works with any AI app that supports MCP',

  'landing.map.eyebrow': 'One link',
  'landing.map.title': 'One link instead of a setup per app',
  'landing.map.lead':
    'Built-in connectors usually give one AI one account. Manyplug gives every AI app all your accounts, with the same rules everywhere.',
  'landing.map.core': 'your MCP link',
  'landing.map.api': 'Your MCP or API',
  'landing.map.before': 'Without Manyplug',
  'landing.map.beforeStat': '4 AI apps × 5 services = 20 setups',
  'landing.map.beforeText':
    'Each AI app connects to each service on its own, often with one account per service.',
  'landing.map.after': 'With Manyplug',
  'landing.map.afterStat': '4 AI apps × 1 link = 4 setups',
  'landing.map.afterText':
    'Add a service once and every AI app gets it, with all its accounts and your rules.',
  'landing.map.compare': 'Compare with Zapier MCP, Composio and others',

  'landing.how.eyebrow': 'How it works',
  'landing.how.title': 'Up and running in five minutes',
  'landing.how.lead': 'No servers, no config files, no API keys pasted into a chat.',
  'landing.step1.title': 'Sign in with Google',
  'landing.step1.text': 'Your Manyplug account is ready at once. The free plan is enough to try everything.',
  'landing.step1.visual': 'Signed in as you@gmail.com',
  'landing.step2.title': 'Connect your services',
  'landing.step2.text': 'Sign in to Gmail, Slack or Notion, or paste an API key. Two mailboxes? Add both.',
  'landing.step3.title': 'Paste one link into your AI',
  'landing.step3.text': 'Add your Manyplug link to Claude, ChatGPT or Cursor once, then just ask:',
  'landing.step3.prompt': '“What did I promise clients this week?”',

  'landing.features.eyebrow': 'Features',
  'landing.features.title': 'Made for people with more than one of everything',
  'landing.features.lead': 'What you get on top of plain MCP.',
  'landing.f.accounts.title': 'Every account, side by side',
  'landing.f.accounts.text':
    'Work and personal Gmail, three Slack workspaces, a client’s Notion. Ask about one account or all of them at once.',
  'landing.f.accounts.result': '3 inboxes',
  'landing.f.confirm.title': 'You approve the risky stuff',
  'landing.f.confirm.text': 'Sending, deleting and refunds wait for your tap. You choose what asks first.',
  'landing.f.confirm.message': 'Claude wants to email finance@acme.com: “Invoice INV-2041 paid”.',
  'landing.f.chat.title': 'Set it up by asking',
  'landing.f.chat.text':
    'Ask your AI to add an account, rename one or disconnect an old one. Anything that loosens your safety settings still needs your OK.',
  'landing.f.chat.prompt': 'Connect my second Gmail and call it Clients',
  'landing.f.chat.reply': 'Here is your sign-in link for Google. Once you finish, “Clients” is ready.',
  'landing.f.personas.title': 'Different access for each AI',
  'landing.f.personas.text':
    'Give your work assistant mail and calendar, and a personal one read-only access to one inbox.',
  'landing.f.personas.work': 'asks before sending',
  'landing.f.personas.personal': 'read only',
  'landing.f.api.title': 'Bring your own MCP servers and APIs',
  'landing.f.api.text':
    'Add a private MCP server or any REST API by its address and key. It follows the same rules as built-in services.',
  'landing.f.api.status': 'connected',
  'landing.f.context.title': 'Stays fast with 3 services or 40',
  'landing.f.context.text':
    'Your AI sees a short menu first and loads a tool’s details only when it needs them. Similar services share the same tools.',
  'landing.f.context.label': 'Menu your AI loads up front',
  'landing.f.context.few': '3 services',
  'landing.f.context.many': '40 services',
  'landing.f.context.tokens': '≤ 3k tokens',

  'landing.services.eyebrow': 'Services',
  'landing.services.title': '{n} services, several accounts each',
  'landing.services.lead': 'Plus any IMAP mailbox, any MCP server and any REST API.',
  'landing.services.all': 'See all {n}',

  'landing.security.eyebrow': 'Security',
  'landing.security.title': 'Your accounts stay yours',
  'landing.security.lead':
    'Manyplug sits between your AI and your data, so it is built to withstand leaks, bugs and commands slipped into emails.',
  'landing.sec.encryption.title': 'Encrypted per account',
  'landing.sec.encryption.text':
    'Every token and password is encrypted with its own key. A stolen database alone is useless.',
  'landing.sec.secrets.title': 'The AI never sees your logins',
  'landing.sec.secrets.text': 'You enter keys on our page, not in the chat, and they never leave Manyplug.',
  'landing.sec.injection.title': 'Prompt-injection guard',
  'landing.sec.injection.text':
    'Text from emails and web pages is marked as untrusted, so the AI does not take it as orders.',
  'landing.sec.audit.title': 'Activity log',
  'landing.sec.audit.text': 'See which AI did what and when, without storing the contents of your mail.',
  'landing.sec.disconnect.title': 'Disconnect means deleted',
  'landing.sec.disconnect.text': 'Remove an account and its credentials are erased at once.',
  'landing.sec.delete.title': 'Leave any time',
  'landing.sec.delete.text': 'Delete your account and every key, token and log goes with it, right away.',
  'landing.log.title': 'Activity',
  'landing.log.ok': 'done',
  'landing.log.approved': 'approved',
  'landing.log.blocked': 'blocked by rule',

  'landing.pricing.eyebrow': 'Pricing',
  'landing.pricing.title': 'Start free, pay when it saves you time',
  'landing.pricing.lead':
    'Every plan has every service and every security feature; plans differ only in volume. An action is one step the AI takes in a service, like a search or a sent message.',

  'landing.faq.eyebrow': 'FAQ',
  'landing.faq.title': 'Questions people ask',
  'landing.faq.more': 'Something else?',
  'landing.faq.write': 'Write to us',
  'landing.faq.support': 'Visit support',

  'landing.cta.title': 'Plug your AI into your work in five minutes',
  'landing.cta.text': 'Free plan, no card, no time limit.',
} as const;

export type LandingKey = keyof typeof landingEn;

export const landingRu: Record<LandingKey, string> = {
  'landing.title': 'Manyplug: все ваши сервисы в ИИ за один шаг',
  'landing.description':
    'Один MCP-адрес для Gmail, Slack, Notion, GitHub и других сервисов. Несколько аккаунтов в каждом, ключи зашифрованы, рискованные действия ждут вашего согласия.',
  'landing.eyebrow': 'MCP-хаб для Claude, ChatGPT и Cursor',
  'landing.h1a': 'Вся ваша почта, чаты и документы —',
  'landing.h1b': 'в любом ИИ‑ассистенте.',
  'landing.lead':
    'Одна MCP-ссылка даёт Claude, ChatGPT и Cursor вашу почту Gmail, Slack, Notion и ещё {n} сервисов, в каждом — несколько аккаунтов. ИИ сам ищет, читает и готовит черновики, а всё, что отправляет или удаляет, ждёт вашего «да».',
  'landing.how': 'Как это работает',
  'landing.note.free': 'Бесплатный тариф без срока',
  'landing.note.card': 'Карта не нужна',
  'landing.note.encrypted': 'Пароли и ключи не видны ИИ',

  'landing.demo.label':
    'Пример чата: Claude ищет в двух ящиках, читает счёт, спрашивает вас перед отправкой Алексу в Slack и отправляет после нажатия «Разрешить»',
  'landing.demo.title': 'Claude',
  'landing.demo.connected': 'Manyplug подключён',
  'landing.demo.ask': 'Найди счёт от ACME в почте и отправь Алексу в Slack',
  'landing.demo.found': '3 письма · 2 ящика',
  'landing.demo.read': '$1 240 · до 15 ноября',
  'landing.demo.approveWho': 'Manyplug · нужно ваше согласие',
  'landing.demo.approveText': 'Отправить «Счёт ACME INV-2041» пользователю @alex в Slack?',
  'landing.demo.deny': 'Отклонить',
  'landing.demo.allow': 'Разрешить',
  'landing.demo.sent': 'отправлено',
  'landing.demo.answer': 'Готово. Отправил Алексу счёт ACME INV-2041 на $1 240. Оплатить нужно до 15 ноября.',
  'landing.demo.input': 'Ответить Claude…',

  'landing.works': 'Работает с любым ИИ-приложением, которое поддерживает MCP',

  'landing.map.eyebrow': 'Одна ссылка',
  'landing.map.title': 'Одна ссылка вместо настройки каждого сервиса',
  'landing.map.lead':
    'Встроенные коннекторы обычно дают одному ИИ один аккаунт. Manyplug даёт любому ИИ-приложению все ваши аккаунты и везде одни и те же правила.',
  'landing.map.core': 'ваша MCP-ссылка',
  'landing.map.api': 'Ваш MCP или API',
  'landing.map.before': 'Без Manyplug',
  'landing.map.beforeStat': '4 ИИ × 5 сервисов = 20 настроек',
  'landing.map.beforeText':
    'Каждое ИИ-приложение подключается к каждому сервису отдельно, часто только с одним аккаунтом.',
  'landing.map.after': 'С Manyplug',
  'landing.map.afterStat': '4 ИИ × 1 ссылка = 4 настройки',
  'landing.map.afterText':
    'Добавьте сервис один раз — и он появится во всех ИИ-приложениях, со всеми аккаунтами и вашими правилами.',
  'landing.map.compare': 'Сравнение с Zapier MCP, Composio и другими',

  'landing.how.eyebrow': 'Как это работает',
  'landing.how.title': 'Всё готово за пять минут',
  'landing.how.lead': 'Без серверов, конфигов и API-ключей в чате.',
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
  'landing.features.lead': 'Что вы получаете сверх обычного MCP.',
  'landing.f.accounts.title': 'Все аккаунты рядом',
  'landing.f.accounts.text':
    'Рабочий и личный Gmail, три пространства Slack, Notion клиента. Спрашивайте про один аккаунт или про все сразу.',
  'landing.f.accounts.result': '3 ящика',
  'landing.f.confirm.title': 'Рискованное — с вашего согласия',
  'landing.f.confirm.text': 'Отправка, удаление и возвраты ждут вашего нажатия. Вы решаете, что спрашивать.',
  'landing.f.confirm.message': 'Claude хочет отправить письмо на finance@acme.com: «Счёт INV-2041 оплачен».',
  'landing.f.chat.title': 'Настройка — просто просьбой',
  'landing.f.chat.text':
    'Попросите ИИ добавить аккаунт, переименовать его или отключить старый. Всё, что ослабляет защиту, всё равно ждёт вашего «да».',
  'landing.f.chat.prompt': 'Подключи мой второй Gmail и назови его «Клиенты»',
  'landing.f.chat.reply': 'Вот ссылка для входа в Google. Как только войдёте, «Клиенты» готов.',
  'landing.f.personas.title': 'Разный доступ для разных ИИ',
  'landing.f.personas.text': 'Рабочему ассистенту — почту и календарь, личному — только чтение одного ящика.',
  'landing.f.personas.work': 'спрашивает перед отправкой',
  'landing.f.personas.personal': 'только чтение',
  'landing.f.api.title': 'Свои MCP-серверы и API',
  'landing.f.api.text':
    'Добавьте свой MCP-сервер или любой REST API по адресу и ключу. Для них действуют те же правила, что и для встроенных сервисов.',
  'landing.f.api.status': 'подключён',
  'landing.f.context.title': 'Быстро и с 3, и с 40 сервисами',
  'landing.f.context.text':
    'Сначала ИИ видит короткое меню и загружает подробности инструмента, только когда они нужны. У похожих сервисов общие инструменты.',
  'landing.f.context.label': 'Меню, которое ИИ загружает сразу',
  'landing.f.context.few': '3 сервиса',
  'landing.f.context.many': '40 сервисов',
  'landing.f.context.tokens': '≤ 3 тыс. токенов',

  'landing.services.eyebrow': 'Сервисы',
  'landing.services.title': '{n} {n|сервис|сервиса|сервисов}, в каждом — несколько аккаунтов',
  'landing.services.lead': 'А ещё любой почтовый ящик по IMAP, любой MCP-сервер и любой REST API.',
  'landing.services.all': 'Все {n}',

  'landing.security.eyebrow': 'Безопасность',
  'landing.security.title': 'Ваши аккаунты остаются вашими',
  'landing.security.lead':
    'Manyplug стоит между ИИ и вашими данными, поэтому он устроен так, чтобы выдержать утечки, ошибки и команды, подброшенные в письма.',
  'landing.sec.encryption.title': 'Шифрование каждого аккаунта',
  'landing.sec.encryption.text':
    'Каждый токен и пароль зашифрован своим ключом. Украденная база сама по себе бесполезна.',
  'landing.sec.secrets.title': 'ИИ не видит пароли и ключи',
  'landing.sec.secrets.text': 'Ключи вводятся на нашей странице, а не в чате, и не покидают Manyplug.',
  'landing.sec.injection.title': 'Защита от prompt injection',
  'landing.sec.injection.text':
    'Текст из писем и веб-страниц помечается как недоверенный, и ИИ не принимает его за команды.',
  'landing.sec.audit.title': 'Журнал действий',
  'landing.sec.audit.text': 'Видно, какой ИИ что и когда сделал, при этом содержимое писем не хранится.',
  'landing.sec.disconnect.title': 'Отключили — значит, удалили',
  'landing.sec.disconnect.text': 'Уберите аккаунт, и его доступы сразу стираются.',
  'landing.sec.delete.title': 'Уйти можно в любой момент',
  'landing.sec.delete.text': 'Удалите аккаунт — вместе с ним сразу исчезнут все ключи, токены и журнал.',
  'landing.log.title': 'Журнал',
  'landing.log.ok': 'готово',
  'landing.log.approved': 'разрешено',
  'landing.log.blocked': 'запрещено правилом',

  'landing.pricing.eyebrow': 'Тарифы',
  'landing.pricing.title': 'Начните бесплатно, платите, когда это экономит время',
  'landing.pricing.lead':
    'В каждом тарифе все сервисы и все функции защиты, тарифы отличаются только объёмом. Действие — это один шаг ИИ в сервисе, например поиск или отправленное сообщение.',

  'landing.faq.eyebrow': 'Вопросы',
  'landing.faq.title': 'Частые вопросы',
  'landing.faq.more': 'Остался вопрос?',
  'landing.faq.write': 'Напишите нам',
  'landing.faq.support': 'Поддержка',

  'landing.cta.title': 'Подключите ИИ к своей работе за пять минут',
  'landing.cta.text': 'Бесплатный тариф, без карты и без срока.',
};
