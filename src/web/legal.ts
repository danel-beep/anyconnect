import type { Locale } from './i18n.js';
import type { LegalDoc } from './site.js';

/**
 * Privacy policy and terms of service. Plain data so the texts can be edited (or replaced by a
 * lawyer's version) without touching page code. The hub's address and support email are filled in.
 */
export type LegalKind = 'privacy' | 'terms';

interface Facts {
  publicUrl: string;
  supportEmail?: string | undefined;
}

const UPDATED = { ru: 'Редакция от 4 ноября 2026 года', en: 'Last updated November 4, 2026' };

export function legalDoc(kind: LegalKind, lang: Locale, facts: Facts): LegalDoc {
  const contact =
    facts.supportEmail ??
    (lang === 'ru' ? 'адрес поддержки, указанный на сайте' : 'the support address listed on the website');
  const site = facts.publicUrl.replace(/^https?:\/\//, '');
  const docs = kind === 'privacy' ? privacy : terms;
  return docs[lang]({ contact, site });
}

type Builder = (f: { contact: string; site: string }) => LegalDoc;

const privacy: Record<Locale, Builder> = {
  ru: ({ contact, site }) => ({
    title: 'Политика конфиденциальности',
    updated: UPDATED.ru,
    intro: `Здесь описано, какие данные собирает сервис AnyConnect (${site}), зачем и как мы их защищаем. Коротко: мы храним только то, что нужно для работы подключений, шифруем ключи доступа и не продаём данные.`,
    sections: [
      {
        title: 'Какие данные мы храним',
        paragraphs: [
          'Аккаунт: адрес почты, имя и идентификатор Google, если вы входите через Google; дата регистрации и последнего входа; язык интерфейса.',
          'Подключения: названия подключённых аккаунтов сервисов, их настройки и данные для входа (токены OAuth, API-ключи, пароли приложений). Данные для входа хранятся только в зашифрованном виде, каждый аккаунт своим ключом.',
          'Журнал действий: какой инструмент вызывался, когда, через какое ИИ-приложение и с каким результатом (успех или ошибка). Аргументы вызовов и содержимое ваших писем, файлов и сообщений в журнал не записываются.',
          'Технические данные: IP-адрес и браузер для сессий входа и защиты от злоупотреблений.',
        ],
      },
      {
        title: 'Как данные используются',
        paragraphs: [
          'Чтобы выполнять запросы вашего ИИ-ассистента к подключённым сервисам, показывать вам историю и расход лимитов, защищать аккаунт от взлома и злоупотреблений.',
          'Содержимое ваших сервисов проходит через AnyConnect только в момент запроса и передаётся тому ИИ-приложению, которому вы дали доступ. Мы не используем его для обучения моделей и не просматриваем его.',
        ],
      },
      {
        title: 'Кому передаются данные',
        paragraphs: [
          'ИИ-приложениям, которые вы подключили (Claude, ChatGPT, Cursor и другие), — результаты инструментов по их запросам. Как эти приложения обращаются с данными, определяют их собственные политики.',
          'Подключённым сервисам — ваши запросы к ним от вашего имени.',
          'Хостинг-провайдеру, на котором работает сервис, — в объёме, нужном для хранения базы данных. Мы не продаём и не передаём данные рекламным сетям.',
        ],
      },
      {
        title: 'Защита',
        paragraphs: [
          'Ключи доступа шифруются (AES-256-GCM) отдельным ключом для каждого аккаунта. Токены входа хранятся только в виде хешей. Доступна двухэтапная проверка и вход по ключу доступа (passkey).',
          'Опасные действия можно настроить так, чтобы они выполнялись только после вашего подтверждения.',
        ],
      },
      {
        title: 'Сроки хранения и удаление',
        paragraphs: [
          'Журнал действий хранится столько дней, сколько предусматривает ваш тариф, затем удаляется.',
          'Вы можете отключить любой аккаунт сервиса (его ключи удаляются сразу) или удалить свой аккаунт AnyConnect в настройках: все подключения, ключи, токены и история будут удалены.',
        ],
      },
      {
        title: 'Cookie',
        paragraphs: [
          'Мы используем только необходимые cookie: сессия входа, защита форм от подделки, выбранный язык. Рекламных и аналитических cookie нет. Выбранная тема хранится в вашем браузере.',
        ],
      },
      {
        title: 'Контакты',
        paragraphs: [`Вопросы о данных и запросы на их удаление присылайте на ${contact}.`],
      },
    ],
  }),
  en: ({ contact, site }) => ({
    title: 'Privacy policy',
    updated: UPDATED.en,
    intro: `This page explains what data AnyConnect (${site}) collects, why, and how we protect it. In short: we keep only what connections need, encrypt access keys and never sell data.`,
    sections: [
      {
        title: 'What we store',
        paragraphs: [
          'Your account: email address, name and Google ID if you sign in with Google; sign-up and last sign-in dates; interface language.',
          'Connections: names of your connected service accounts, their settings and credentials (OAuth tokens, API keys, app passwords). Credentials are stored only encrypted, each account with its own key.',
          'Activity log: which tool was called, when, by which AI app and whether it succeeded. Call arguments and the contents of your mail, files and messages are not logged.',
          'Technical data: IP address and browser, for sign-in sessions and abuse protection.',
        ],
      },
      {
        title: 'How we use data',
        paragraphs: [
          'To run your AI assistant’s requests to the services you connected, to show you history and usage, and to protect your account from break-ins and abuse.',
          'Content of your services passes through AnyConnect only during a request and goes to the AI app you gave access to. We do not use it to train models and do not look at it.',
        ],
      },
      {
        title: 'Who receives data',
        paragraphs: [
          'AI apps you connected (Claude, ChatGPT, Cursor and others) receive tool results they asked for. Their own policies govern how they treat that data.',
          'Connected services receive your requests made on your behalf.',
          'The hosting provider running the service stores the database. We do not sell data or share it with ad networks.',
        ],
      },
      {
        title: 'Protection',
        paragraphs: [
          'Credentials are encrypted (AES-256-GCM) with a separate key per account. Sign-in tokens are stored only as hashes. Two-step verification and passkeys are available.',
          'Risky actions can be set to run only after you confirm them.',
        ],
      },
      {
        title: 'Retention and deletion',
        paragraphs: [
          'The activity log is kept for as many days as your plan includes and is then deleted.',
          'You can disconnect any service account (its credentials are deleted at once) or delete your AnyConnect account in Settings: all connections, keys, tokens and history are removed.',
        ],
      },
      {
        title: 'Cookies',
        paragraphs: [
          'We only use necessary cookies: the sign-in session, form protection and your language. No advertising or analytics cookies. Your theme choice is kept in your browser.',
        ],
      },
      {
        title: 'Contact',
        paragraphs: [`Send questions about your data and deletion requests to ${contact}.`],
      },
    ],
  }),
};

const terms: Record<Locale, Builder> = {
  ru: ({ contact, site }) => ({
    title: 'Условия использования',
    updated: UPDATED.ru,
    intro: `Эти условия действуют, когда вы пользуетесь сервисом AnyConnect (${site}). Регистрируясь, вы с ними соглашаетесь.`,
    sections: [
      {
        title: 'Что делает сервис',
        paragraphs: [
          'AnyConnect даёт ИИ-ассистентам доступ к сервисам, которые вы подключили, по протоколу MCP. Вы сами выбираете, какие аккаунты подключать, каким приложениям давать доступ и какие действия требуют подтверждения.',
        ],
      },
      {
        title: 'Ваш аккаунт',
        paragraphs: [
          'Вы отвечаете за сохранность доступа к своему аккаунту и за действия, которые ИИ-приложения выполняют от вашего имени с выданным вами доступом. Рекомендуем включить двухэтапную проверку и подтверждение опасных действий.',
          'Подключайте только аккаунты, которыми вы вправе пользоваться, и соблюдайте правила самих сервисов.',
        ],
      },
      {
        title: 'Запрещено',
        paragraphs: [
          'Рассылать спам, обходить ограничения сервисов, получать доступ к чужим данным, создавать аккаунты массово ради бесплатных лимитов, нагружать сервис сверх разумного или использовать его для чего-либо незаконного. Мы можем приостановить аккаунт, который нарушает эти правила.',
        ],
      },
      {
        title: 'Тарифы и лимиты',
        paragraphs: [
          'Бесплатный тариф предоставляется без срока, с лимитами, указанными на странице тарифов. Платные тарифы дают больше действий и аккаунтов. Лимиты на действия обнуляются каждый месяц.',
          'Мы можем менять тарифы и лимиты, заранее предупредив об изменениях, которые касаются уже оплаченного периода.',
        ],
      },
      {
        title: 'Доступность и ответственность',
        paragraphs: [
          'Мы стараемся, чтобы сервис работал без перебоев, но не гарантируем этого: подключённые сервисы и ИИ-приложения могут менять свои API и правила. Сервис предоставляется «как есть».',
          'Мы не отвечаем за действия, которые ИИ-приложение выполнило с доступом, который вы выдали, и за содержимое ответов ИИ.',
        ],
      },
      {
        title: 'Прекращение',
        paragraphs: [
          'Вы можете в любой момент удалить аккаунт в настройках. Мы можем закрыть аккаунт при нарушении этих условий.',
        ],
      },
      {
        title: 'Контакты',
        paragraphs: [`Вопросы по условиям присылайте на ${contact}.`],
      },
    ],
  }),
  en: ({ contact, site }) => ({
    title: 'Terms of service',
    updated: UPDATED.en,
    intro: `These terms apply when you use AnyConnect (${site}). By signing up you accept them.`,
    sections: [
      {
        title: 'What the service does',
        paragraphs: [
          'AnyConnect gives AI assistants access to services you connected, over the MCP protocol. You choose which accounts to connect, which apps get access and which actions need your confirmation.',
        ],
      },
      {
        title: 'Your account',
        paragraphs: [
          'You are responsible for keeping access to your account safe and for what AI apps do on your behalf with the access you granted. We recommend turning on two-step verification and confirmations for risky actions.',
          'Only connect accounts you are allowed to use, and follow the rules of those services.',
        ],
      },
      {
        title: 'Not allowed',
        paragraphs: [
          'Spam, working around service limits, accessing other people’s data, creating accounts in bulk to get free limits, overloading the service, or anything illegal. We may suspend accounts that break these rules.',
        ],
      },
      {
        title: 'Plans and limits',
        paragraphs: [
          'The free plan has no time limit and comes with the limits shown on the pricing page. Paid plans give more actions and accounts. Action limits reset every month.',
          'We may change plans and limits and will notify you in advance about changes that affect a period you already paid for.',
        ],
      },
      {
        title: 'Availability and liability',
        paragraphs: [
          'We work to keep the service running but cannot guarantee it: connected services and AI apps may change their APIs and rules. The service is provided “as is”.',
          'We are not responsible for actions an AI app performed with access you granted, or for the content of AI answers.',
        ],
      },
      {
        title: 'Termination',
        paragraphs: [
          'You can delete your account at any time in Settings. We may close accounts that break these terms.',
        ],
      },
      {
        title: 'Contact',
        paragraphs: [`Send questions about these terms to ${contact}.`],
      },
    ],
  }),
};
