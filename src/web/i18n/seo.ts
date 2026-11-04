/**
 * Texts of the docs and search pages: per-client guides, "connect a service to a client" pages,
 * the FAQ, comparisons and explainers (their long texts live in `src/web/seo/`).
 * `ru` must have exactly the keys of `en` (the type enforces it).
 */
export const seoEn = {
  'site.nav.faq': 'FAQ',
  'site.nav.compare': 'Compare',
  'site.nav.whatIsMcp': 'What is MCP',
  'site.nav.guides': 'Guides',
  'site.footer.resources': 'Resources',
  'crumb.home': 'Home',

  'guide.title': '{client} MCP setup: connect {services} and more · Manyplug',
  'guide.description':
    'How to add Manyplug to {client} in {minutes} min and use {services} and your other accounts from {client}. Free plan, several accounts per service.',
  'guide.h1': 'Connect {client} to your services',
  'guide.eyebrow': 'Guide · about {minutes} min',
  'guide.requirements': 'What you need',
  'guide.steps': 'Steps',
  'guide.verify': 'Check that it works',
  'guide.verifyText':
    'In a new chat, ask {client}: “Which accounts can you use in Manyplug?” It should name the accounts you connected.',
  'guide.troubleshooting': 'If something goes wrong',
  'guide.services': 'Services {client} can use through Manyplug',
  'guide.servicesLead': 'Open a service for its tools and example requests.',
  'guide.faq': 'Questions',
  'guide.others': 'Other AI apps',
  'guide.checked': 'Checked against the {client} documentation on {date}.',
  'guide.all': 'All AI apps',
  'guide.full': 'Full guide',
  'guide.step.signup': 'Create a free Manyplug account',
  'guide.step.signupText': 'Sign in with Google at {url}. Your workspace is created right away.',
  'guide.step.connect': 'Connect your services',
  'guide.step.connectText':
    'Connect Gmail, Slack, Notion or any other service in the dashboard, or later by asking the AI. Several accounts per service are fine.',
  'guide.step.add': 'Add Manyplug to {client}',
  'guide.step.ask': 'Ask {client}',
  'guide.step.askText': 'For example: “Find the latest invoice in my mail and add a task to pay it.”',

  'seo.faq.free.q': 'Is it free to connect {client} to Manyplug?',
  'seo.faq.free.a':
    'Yes. The free plan includes {actions} actions a month ({intro} in the first {days} days) and up to {accounts} connected accounts, with no card. Paid plans start at {from} a month.',
  'seo.faq.accounts.q': 'Can {client} use several accounts of the same service?',
  'seo.faq.accounts.a':
    'Yes. Connect each account under its own name, for example Work and Personal. {client} can use one of them or search all of them at once.',
  'seo.faq.safety.q': 'Can {client} send or delete things without asking me?',
  'seo.faq.safety.a':
    'Not by default. Risky actions such as sending email or deleting wait for your approval in Manyplug. You can tighten or loosen this per account and per AI app, and loosening always needs your OK.',
  'seo.faq.keys.q': 'Does {client} see my passwords or API keys?',
  'seo.faq.keys.a':
    'No. Keys are entered on Manyplug’s own pages, stored encrypted with a separate key per account, and the AI only receives tool results.',

  'combo.title': 'Connect {service} to {client} (MCP) · Manyplug',
  'combo.description':
    'Use {service} in {client}: {blurb} Connect once through Manyplug, keep several {service} accounts, and approve risky actions. Free plan.',
  'combo.h1': 'Connect {service} to {client}',
  'combo.answer':
    'To use {service} in {client}, connect your {service} account in Manyplug and add Manyplug to {client} once. {client} then gets {n} {service} {n|tool|tools}, for example: {examples}. It takes about {minutes} minutes and works on the free plan.',
  'combo.step1': 'Connect {service} in Manyplug',
  'combo.step1.oauth':
    'Click “Connect {service}” and sign in on {service}’s own page. Manyplug never sees your password.',
  'combo.step1.form': 'Click “Connect {service}” and paste the key or app password into Manyplug’s form:',
  'combo.step1.none': 'Click “Connect {service}”: nothing else to configure.',
  'combo.step2': 'Add Manyplug to {client}',
  'combo.step3': 'Ask {client}',
  'combo.tools': 'What {client} can do in {service}',
  'combo.otherClients': '{service} in other AI apps',
  'combo.otherServices': 'More services for {client}',
  'combo.useWith': 'Use {service} with',
  'combo.faq.multi.q': 'Can I connect two {service} accounts to {client}?',
  'combo.faq.multi.a':
    'Yes. Connect each one in Manyplug under its own name, for example Work and Personal. {client} can use one of them or all at once.',
  'combo.faq.confirm.q': 'Will {client} change anything in {service} without asking?',
  'combo.faq.confirm.risky':
    'By default these actions wait for your approval before they run: {actions}. Other changes follow your rules, which you can make stricter per account.',
  'combo.faq.confirm.none':
    'Changes follow your rules: you can make every change in {service} wait for your approval, or let {client} only read.',
  'combo.faq.readonly':
    '{client} only reads {service} through Manyplug: none of its {service} tools change anything.',
  'combo.faq.official.q': 'Do I need an official {service} MCP server for this?',
  'combo.faq.official.oauth':
    'No. Manyplug connects to {service} itself (you sign in on {service}’s page) and gives {client} the tools through one MCP address, together with your other services.',
  'combo.faq.official.form':
    'No. Manyplug connects to {service} itself with a key or app password you paste into its form, and gives {client} the tools through one MCP address, together with your other services.',

  'faqPage.title': 'FAQ: Manyplug, MCP and connecting your services to AI',
  'faqPage.description':
    'Answers about Manyplug: what an MCP hub is, which AI apps and services work, security, several accounts, pricing and limits.',
  'faqPage.h1': 'Frequently asked questions',
  'faqPage.lead': 'Short answers about Manyplug, MCP and connecting your services to AI assistants.',
  'faqPage.group.basics': 'Basics',
  'faqPage.group.setup': 'Setup',
  'faqPage.group.security': 'Security and privacy',
  'faqPage.group.pricing': 'Pricing and limits',
  'faqPage.more': 'Did not find an answer?',
  'faqPage.contact': 'Write to {email}',

  'faq.what.q': 'What is Manyplug?',
  'faq.what.a':
    'Manyplug is a hosted MCP hub: one MCP server address that connects AI assistants such as Claude, ChatGPT and Cursor to your services and accounts, for example several Gmail inboxes, Slack, Notion, GitHub and Google Calendar. Risky actions wait for your approval, and keys are encrypted per account.',
  'faq.clients.q': 'Which AI apps work with Manyplug?',
  'faq.clients.a':
    'Any app that supports remote MCP servers: Claude (web, desktop, mobile), ChatGPT in developer mode, Claude Code, Cursor, VS Code with GitHub Copilot, Codex, Gemini CLI, Windsurf and others. Every app uses the same address.',
  'faq.services.q': 'Which services can I connect?',
  'faq.services.a':
    'Built in today: {services}. Any IMAP mailbox, any remote MCP server and any REST API can be added too.',
  'faq.install.q': 'Do I need to install anything?',
  'faq.install.a':
    'No. Manyplug runs in the cloud. You sign in on the website, connect services, and paste one address into your AI app.',
  'faq.chat.q': 'Can I set it up from the chat?',
  'faq.chat.a':
    'Yes. Ask the AI to connect a service, rename an account or change when it asks you first. Keys never go through the chat: the AI gives you a link to Manyplug’s own page. Anything that loosens your protection waits for your OK.',
  'faq.injection.q': 'What if an email tells the AI to do something?',
  'faq.injection.a':
    'Text from emails, messages and web pages reaches the AI marked as untrusted data, with an instruction never to follow it. Risky actions still wait for your approval, so a hidden instruction cannot send mail on its own.',
  'faq.revoke.q': 'How do I disconnect an AI app?',
  'faq.revoke.a':
    'In the dashboard under AI apps, revoke its access: the app loses it at once. You can also limit an app to some accounts or to reading only.',

  'compare.index.title': 'Compare Manyplug with other ways to connect AI to your apps',
  'compare.index.description':
    'Manyplug compared with Zapier MCP, Composio and separate MCP servers per service: what each is for and when to pick which.',
  'compare.index.h1': 'Compare',
  'compare.index.lead': 'Honest comparisons with the other ways to give an AI assistant your apps.',
  'compare.feature': 'What',
  'compare.chooseManyplug': 'Choose Manyplug if',
  'compare.chooseOther': 'Choose {other} if',
  'compare.together': 'Use both',
  'compare.sources': 'Facts about {other} come from its own pages, checked on {date}:',
  'compare.others': 'Other comparisons',

  'article.updated': 'Updated {date}',
  'article.faq': 'Questions',
  'article.next': 'Next steps',
  'article.connect': 'Connect your AI to Manyplug',
  'article.services': 'See the services',

  'cta.title': 'Try it with your own accounts',
  'cta.text': 'Free plan, no card. Setup takes a couple of minutes.',
} as const;

export type SeoKey = keyof typeof seoEn;

export const seoRu: Record<SeoKey, string> = {
  'site.nav.faq': 'Вопросы',
  'site.nav.compare': 'Сравнение',
  'site.nav.whatIsMcp': 'Что такое MCP',
  'site.nav.guides': 'Статьи',
  'site.footer.resources': 'Материалы',
  'crumb.home': 'Главная',

  'guide.title': 'MCP в {client}: подключить {services} и другие сервисы · Manyplug',
  'guide.description':
    'Как добавить Manyplug в {client} за {minutes} мин и пользоваться {services} и другими аккаунтами из {client}. Бесплатный тариф, несколько аккаунтов одного сервиса.',
  'guide.h1': 'Подключите {client} к своим сервисам',
  'guide.eyebrow': 'Инструкция · около {minutes} мин',
  'guide.requirements': 'Что нужно',
  'guide.steps': 'Шаги',
  'guide.verify': 'Проверьте, что работает',
  'guide.verifyText':
    'В новом чате спросите {client}: «Какие аккаунты тебе доступны в Manyplug?» В ответе должны быть подключённые вами аккаунты.',
  'guide.troubleshooting': 'Если что-то не так',
  'guide.services': 'Сервисы, доступные {client} через Manyplug',
  'guide.servicesLead': 'Откройте сервис, чтобы увидеть его инструменты и примеры запросов.',
  'guide.faq': 'Вопросы',
  'guide.others': 'Другие ИИ-приложения',
  'guide.checked': 'Сверено с документацией {client} {date}.',
  'guide.all': 'Все ИИ-приложения',
  'guide.full': 'Подробная инструкция',
  'guide.step.signup': 'Создайте бесплатный аккаунт Manyplug',
  'guide.step.signupText': 'Войдите через Google на {url}. Рабочее пространство создаётся сразу.',
  'guide.step.connect': 'Подключите сервисы',
  'guide.step.connectText':
    'Подключите Gmail, Slack, Notion или другой сервис в кабинете или позже просьбой к ИИ. Можно несколько аккаунтов одного сервиса.',
  'guide.step.add': 'Добавьте Manyplug в {client}',
  'guide.step.ask': 'Попросите {client}',
  'guide.step.askText': 'Например: «Найди в почте последний счёт и добавь задачу его оплатить».',

  'seo.faq.free.q': 'Подключить {client} к Manyplug бесплатно?',
  'seo.faq.free.a':
    'Да. На бесплатном тарифе {actions} {actions|действие|действия|действий} в месяц ({intro} в первые {days} {days|день|дня|дней}) и до {accounts} {accounts|подключённого аккаунта|подключённых аккаунтов|подключённых аккаунтов}, без карты. Платные тарифы — от {from} в месяц.',
  'seo.faq.accounts.q': 'Может ли {client} пользоваться несколькими аккаунтами одного сервиса?',
  'seo.faq.accounts.a':
    'Да. Подключите каждый аккаунт под своим именем, например «Работа» и «Личный». {client} может работать с одним из них или искать сразу во всех.',
  'seo.faq.safety.q': 'Может ли {client} отправить или удалить что-то без спроса?',
  'seo.faq.safety.a':
    'По умолчанию нет. Рискованные действия, например отправка писем или удаление, ждут вашего подтверждения в Manyplug. Это можно ужесточить или ослабить для каждого аккаунта и ИИ-приложения, а ослабление всегда требует вашего «да».',
  'seo.faq.keys.q': 'Видит ли {client} мои пароли и API-ключи?',
  'seo.faq.keys.a':
    'Нет. Ключи вводятся на страницах самого Manyplug, хранятся зашифрованными отдельным ключом для каждого аккаунта, а ИИ получает только результаты инструментов.',

  'combo.title': 'Как подключить {service} к {client} (MCP) · Manyplug',
  'combo.description':
    '{service} в {client}: {blurb} Подключите один раз через Manyplug, держите несколько аккаунтов {service} и подтверждайте рискованные действия. Бесплатный тариф.',
  'combo.h1': 'Подключите {service} к {client}',
  'combo.answer':
    'Чтобы пользоваться {service} в {client}, подключите аккаунт {service} в Manyplug и один раз добавьте Manyplug в {client}. После этого у {client} будет {n} {n|инструмент|инструмента|инструментов} {service}, например: {examples}. Это занимает около {minutes} минут и работает на бесплатном тарифе.',
  'combo.step1': 'Подключите {service} в Manyplug',
  'combo.step1.oauth':
    'Нажмите «Подключить {service}» и войдите на странице самого {service}. Manyplug не видит ваш пароль.',
  'combo.step1.form':
    'Нажмите «Подключить {service}» и вставьте ключ или пароль приложения в форму Manyplug:',
  'combo.step1.none': 'Нажмите «Подключить {service}»: больше ничего настраивать не нужно.',
  'combo.step2': 'Добавьте Manyplug в {client}',
  'combo.step3': 'Попросите {client}',
  'combo.tools': 'Что {client} может делать в {service}',
  'combo.otherClients': '{service} в других ИИ-приложениях',
  'combo.otherServices': 'Другие сервисы для {client}',
  'combo.useWith': '{service} вместе с',
  'combo.faq.multi.q': 'Можно подключить к {client} два аккаунта {service}?',
  'combo.faq.multi.a':
    'Да. Подключите каждый в Manyplug под своим именем, например «Работа» и «Личный». {client} может работать с одним из них или сразу со всеми.',
  'combo.faq.confirm.q': 'Изменит ли {client} что-то в {service} без спроса?',
  'combo.faq.confirm.risky':
    'По умолчанию эти действия ждут вашего подтверждения: {actions}. Остальные изменения подчиняются вашим правилам, их можно сделать строже для каждого аккаунта.',
  'combo.faq.confirm.none':
    'Изменения подчиняются вашим правилам: можно сделать так, чтобы любое изменение в {service} ждало вашего «да», или разрешить {client} только чтение.',
  'combo.faq.readonly':
    'Через Manyplug {client} только читает {service}: ни один инструмент {service} ничего не меняет.',
  'combo.faq.official.q': 'Нужен ли для этого официальный MCP-сервер {service}?',
  'combo.faq.official.oauth':
    'Нет. Manyplug сам подключается к {service} (вы входите на странице {service}) и отдаёт инструменты {client} через один MCP-адрес вместе с другими сервисами.',
  'combo.faq.official.form':
    'Нет. Manyplug сам подключается к {service} по ключу или паролю приложения из своей формы и отдаёт инструменты {client} через один MCP-адрес вместе с другими сервисами.',

  'faqPage.title': 'Вопросы и ответы: Manyplug, MCP и подключение сервисов к ИИ',
  'faqPage.description':
    'Ответы про Manyplug: что такое MCP-хаб, какие ИИ-приложения и сервисы работают, безопасность, несколько аккаунтов, тарифы и лимиты.',
  'faqPage.h1': 'Частые вопросы',
  'faqPage.lead': 'Короткие ответы про Manyplug, MCP и подключение сервисов к ИИ-ассистентам.',
  'faqPage.group.basics': 'Основное',
  'faqPage.group.setup': 'Подключение',
  'faqPage.group.security': 'Безопасность и данные',
  'faqPage.group.pricing': 'Тарифы и лимиты',
  'faqPage.more': 'Не нашли ответа?',
  'faqPage.contact': 'Напишите на {email}',

  'faq.what.q': 'Что такое Manyplug?',
  'faq.what.a':
    'Manyplug — облачный MCP-хаб: один адрес MCP-сервера, через который ИИ-ассистенты вроде Claude, ChatGPT и Cursor работают с вашими сервисами и аккаунтами, например с несколькими ящиками Gmail, Slack, Notion, GitHub и Google Календарём. Рискованные действия ждут вашего подтверждения, ключи шифруются отдельно для каждого аккаунта.',
  'faq.clients.q': 'Какие ИИ-приложения работают с Manyplug?',
  'faq.clients.a':
    'Любые с поддержкой удалённых MCP-серверов: Claude (веб, десктоп, мобильные), ChatGPT в режиме разработчика, Claude Code, Cursor, VS Code с GitHub Copilot, Codex, Gemini CLI, Windsurf и другие. Адрес у всех один.',
  'faq.services.q': 'Какие сервисы можно подключить?',
  'faq.services.a':
    'Встроены сейчас: {services}. Также можно добавить любую почту IMAP, любой удалённый MCP-сервер и любой REST API.',
  'faq.install.q': 'Нужно что-то устанавливать?',
  'faq.install.a':
    'Нет. Manyplug работает в облаке. Вы входите на сайте, подключаете сервисы и вставляете один адрес в ИИ-приложение.',
  'faq.chat.q': 'Можно настроить всё из чата?',
  'faq.chat.a':
    'Да. Попросите ИИ подключить сервис, переименовать аккаунт или изменить, когда он спрашивает вас. Ключи не проходят через чат: ИИ даёт ссылку на страницу самого Manyplug. Всё, что ослабляет защиту, ждёт вашего «да».',
  'faq.injection.q': 'Что если в письме ИИ приказывают что-то сделать?',
  'faq.injection.a':
    'Текст писем, сообщений и веб-страниц приходит к ИИ помеченным как недоверенные данные, с указанием никогда им не следовать. Рискованные действия всё равно ждут вашего подтверждения, поэтому спрятанная команда не отправит письмо сама.',
  'faq.revoke.q': 'Как отключить ИИ-приложение?',
  'faq.revoke.a':
    'В кабинете в разделе «ИИ-приложения» отзовите доступ: приложение теряет его сразу. Можно также оставить приложению только часть аккаунтов или только чтение.',

  'compare.index.title': 'Manyplug и другие способы подключить ИИ к приложениям',
  'compare.index.description':
    'Manyplug в сравнении с Zapier MCP, Composio и отдельными MCP-серверами: для чего каждый и когда что выбрать.',
  'compare.index.h1': 'Сравнение',
  'compare.index.lead': 'Честные сравнения с другими способами дать ИИ-ассистенту ваши приложения.',
  'compare.feature': 'Что',
  'compare.chooseManyplug': 'Выбирайте Manyplug, если',
  'compare.chooseOther': 'Выбирайте {other}, если',
  'compare.together': 'Вместе',
  'compare.sources': 'Факты о {other} взяты с его собственных страниц, проверено {date}:',
  'compare.others': 'Другие сравнения',

  'article.updated': 'Обновлено {date}',
  'article.faq': 'Вопросы',
  'article.next': 'Что дальше',
  'article.connect': 'Подключите ИИ к Manyplug',
  'article.services': 'Посмотреть сервисы',

  'cta.title': 'Попробуйте со своими аккаунтами',
  'cta.text': 'Бесплатный тариф, без карты. Настройка занимает пару минут.',
};
