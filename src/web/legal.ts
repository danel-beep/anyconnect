import { getPlan } from '../billing/plans.js';
import type { MerchantOfRecord } from '../billing/provider.js';
import type { Locale } from './i18n.js';
import type { LegalDoc } from './site.js';

/**
 * Privacy policy, terms of service and refund policy. Plain data so the texts can be edited (or replaced by a
 * lawyer's version) without touching page code. The hub's address and support email are filled in.
 */
export type LegalKind = 'privacy' | 'terms' | 'refunds';
export const LEGAL_KINDS: readonly LegalKind[] = ['privacy', 'terms', 'refunds'];

interface Facts {
  publicUrl: string;
  supportEmail?: string | undefined;
  /** Legal name of whoever operates the service (`LEGAL_OPERATOR_NAME`); the terms name it when set. */
  operator?: string | undefined;
  /** The active payment provider when it resells the plans (Paddle, Creem); unset = a plain processor or none. */
  merchant?: MerchantOfRecord | undefined;
}

const REFUNDS_UPDATED = { ru: 'Редакция от 12 ноября 2026 года', en: 'Last updated November 12, 2026' };
const CURRENT = { ru: 'Редакция от 12 ноября 2026 года', en: 'Last updated November 12, 2026' };
const PRIVACY_UPDATED = { ru: 'Редакция от 12 ноября 2026 года', en: 'Last updated November 12, 2026' };

export function legalDoc(kind: LegalKind, lang: Locale, facts: Facts): LegalDoc {
  const contact =
    facts.supportEmail ??
    (lang === 'ru' ? 'адрес поддержки, указанный на сайте' : 'the support address listed on the website');
  const site = facts.publicUrl.replace(/^https?:\/\//, '');
  const docs = { privacy, terms, refunds }[kind];
  return docs[lang]({
    contact,
    site,
    operator: facts.operator?.trim() || undefined,
    merchant: facts.merchant,
  });
}

type Builder = (f: {
  contact: string;
  site: string;
  operator: string | undefined;
  merchant: MerchantOfRecord | undefined;
}) => LegalDoc;

/** Days of activity history per public plan, straight from the plan catalog (enforced by `activity.prune`). */
const history = (id: 'free' | 'personal' | 'pro') => getPlan(id).limits.historyDays;

const privacy: Record<Locale, Builder> = {
  ru: ({ contact, site, merchant }) => ({
    title: 'Политика конфиденциальности',
    updated: PRIVACY_UPDATED.ru,
    intro: `Здесь описано, какие данные собирает сервис Manyplug (${site}), зачем и как мы их защищаем. Коротко: мы храним только то, что нужно для работы подключений, шифруем данные для входа в сервисы и не продаём данные.`,
    sections: [
      {
        title: 'Какие данные мы храним',
        paragraphs: [
          'Аккаунт: адрес почты, имя и идентификатор Google, если вы входите через Google; хеш пароля, если вы его задали; публичные ключи passkey и настройки двухэтапной проверки; дата регистрации и последнего входа; язык интерфейса.',
          'Личный сейф: его публичный ключ и приватный ключ, завёрнутый только под секреты, которых у нас нет (ключ устройства в cookie вашего браузера, токены ваших ИИ-приложений, необязательный ключ восстановления).',
          'Подключения: названия подключённых аккаунтов сервисов, их настройки и данные для входа (токены OAuth, API-ключи, пароли приложений). Данные для входа хранятся только в зашифрованном виде, каждый аккаунт своим ключом.',
          'Мессенджеры (личный Telegram, Telegram Bot, WhatsApp): если вы подключили мессенджер, Manyplug хранит свою копию переписки, которая к нему приходит, чтобы ИИ-приложение быстро читало и искало сообщения, не обращаясь каждый раз к мессенджеру. В копии есть названия чатов, текст сообщений, отправители, даты и сведения о вложениях (имя, тип и размер файла, но не сам файл), а также исходящие сообщения в очереди на отправку. Сообщения сохраняются по мере того, как приходят и уходят, а не только когда спрашивает ИИ. Личный аккаунт Telegram при подключении копирует последние сообщения недавних чатов, а для работы сессии хранит её ключи и список собеседников, который нужен Telegram. Бот Telegram хранит переписку, которая приходит этому боту.',
          'Переписка, которую ведёт ИИ: если вы разрешили ИИ-приложению вести разговор в чате, мы храним это разрешение (какой чат, какое приложение, цель разговора, до какого времени и сколько сообщений), пока оно не закончится или вы его не отзовёте.',
          'Команды: в каких командах вы состоите и с какой ролью, приглашения (почта приглашённого), кому вы дали доступ к своим аккаунтам и на каком уровне, кто платит за команду.',
          `Оплата: тариф, статус подписки и её id у ${merchant?.name ?? 'платёжного провайдера'}. Данные карты и адрес для счёта хранит ${merchant?.name ?? 'провайдер'}, к нам они не попадают.`,
          'Бот уведомлений: если вы связали Telegram для подтверждений, мы храним id вашего чата с ботом Manyplug и язык.',
          'Журнал действий: какой инструмент вызывался, когда, через какое ИИ-приложение и с каким результатом (успех или ошибка). Аргументы вызовов и содержимое ваших писем, файлов и сообщений в журнал не записываются.',
          'Технические данные: IP-адрес и браузер для сессий входа и защиты от злоупотреблений.',
        ],
      },
      {
        title: 'Как данные используются',
        paragraphs: [
          'Чтобы выполнять запросы вашего ИИ-ассистента к подключённым сервисам, показывать вам историю и расход лимитов, защищать аккаунт от взлома и злоупотреблений.',
          'Содержимое почты, календарей, файлов и других сервисов проходит через Manyplug только в момент запроса, передаётся тому ИИ-приложению, которому вы дали доступ, и не сохраняется. Исключение — мессенджеры: их переписка хранится, как описано выше.',
          'Когда ваше ИИ-приложение отвечает в чате мессенджера, Manyplug сначала отмечает этот чат прочитанным до последнего входящего сообщения, как если бы вы его открыли, поэтому собеседник видит, что сообщения прочитаны. Само чтение чата через ИИ ничего не отмечает прочитанным.',
          'Мы не используем содержимое ваших сервисов и сообщений для обучения моделей и не просматриваем его.',
        ],
      },
      {
        title: 'Кому передаются данные',
        paragraphs: [
          'ИИ-приложениям, которые вы подключили (Claude, ChatGPT, Cursor и другие), — результаты инструментов по их запросам. Как эти приложения обращаются с данными, определяют их собственные политики.',
          'Подключённым сервисам — ваши запросы к ним от вашего имени.',
          'Участникам ваших команд — аккаунты команды и те ваши аккаунты, которыми вы сами поделились, на выбранном вами уровне. Владелец и администраторы команды не видят ваши личные аккаунты, которыми вы не делились. Тот, кто платит за команду, видит действия команды в счётчике своего тарифа, но не их содержание.',
          `${merchant ? `${merchant.name} (наш реселлер и Merchant of Record)` : 'Платёжному провайдеру'} — данные, нужные для оплаты: почту, страну, тариф. Хостингу Render (Франкфурт, ЕС) — зашифрованную базу данных. Почтовому провайдеру — адрес и текст писем, которые мы вам отправляем. Сервису учёта ошибок, если он включён, — отчёты об ошибках, из которых удалены аргументы, токены и содержимое.`,
          'Мы не продаём и не передаём данные рекламным сетям.',
        ],
      },
      {
        title: 'ИИ-приложения и ваши переписки',
        paragraphs: [
          'Manyplug никогда не получает историю ваших чатов, память ИИ-приложения и файлы, которые вы дали ИИ-приложению. В каждом запросе ИИ-приложение передаёт только название инструмента и нужные ему аргументы, например поисковый запрос. Аргументы используются только для этого запроса и не хранятся, кроме трёх случаев: действие, которое что-то меняет, запоминается на несколько минут, чтобы повторный запрос не выполнил его дважды; действие, которое ждёт вашего подтверждения, хранится зашифрованным, пока вы не ответите, и удаляется через сутки после этого; сообщение, отправленное через мессенджер, становится частью сохранённой переписки.',
          'Если вы выбрали подтверждение действий прямо в чате ИИ, приложение показывает вам действие и спрашивает разрешения, а выполняет его повтор того же вызова от того же приложения. В режиме подтверждения по ссылке решение принимается только на сайте или в боте Manyplug.',
          'Если ИИ-приложение передаёт с запросами анонимный идентификатор пользователя (так делает ChatGPT), мы храним только его необратимый хеш, чтобы считать расход по аккаунту ИИ.',
        ],
      },
      {
        title: 'Данные из сервисов Google',
        paragraphs: [
          'Если вы подключаете Gmail, Google Календарь или Google Диск, Manyplug получает доступ только к тем данным, которые нужны для запроса вашего ИИ-ассистента: найти и прочитать письма, отправить ответ, посмотреть или создать событие, найти и прочитать файл. Данные передаются только выбранному вами ИИ-приложению и не сохраняются. Исключение: результат действия, например отправки письма, несколько минут хранится в памяти, чтобы повторный запрос не отправил письмо дважды.',
          'Мы не продаём данные из сервисов Google, не используем их для рекламы, не передаём их брокерам данных и не используем их для обучения моделей ИИ. Сотрудники не читают эти данные, кроме случаев, когда вы сами об этом попросили, когда это нужно для безопасности или этого требует закон.',
          'Использование и передача Manyplug любым другим приложениям информации, полученной через API Google, соответствуют правилам Google API Services User Data Policy (https://developers.google.com/terms/api-services-user-data-policy), включая требования Limited Use.',
          'Отозвать доступ можно в любой момент: отключите аккаунт в кабинете Manyplug или в настройках аккаунта Google (myaccount.google.com/permissions).',
        ],
      },
      {
        title: 'Защита',
        paragraphs: [
          'Данные для входа в сервисы (пароли, API-ключи, токены) шифруются (AES-256-GCM) отдельным ключом для каждого аккаунта. Пароль Manyplug хранится как хеш scrypt, токены входа — только в виде хешей SHA-256. Доступна двухэтапная проверка и вход по ключу доступа (passkey).',
          'Ключ личного аккаунта, подключённого после создания вашего сейфа, запечатан на этот сейф: открыть его может только запрос из вашего браузера, разрешённого ИИ-приложения или личного токена, а у сервера нет ключа, который его открывает. Ключи аккаунтов команд, мессенджеров и личных аккаунтов, подключённых до появления сейфа, пока завёрнуты мастер-ключом сервера. Подробно — на странице «Доверие» (/trust).',
          'Сохранённая переписка мессенджеров (текст, отправители, названия чатов, сведения о вложениях), очередь исходящих сообщений и состояние сессии шифруются тем же ключом аккаунта. Идентификаторы чатов и сообщений из мессенджера хранятся только в виде хешей с секретным ключом, а поиск работает по таким же хешам слов, а не по читаемому тексту.',
          'Опасные действия можно настроить так, чтобы они выполнялись только после вашего подтверждения.',
        ],
      },
      {
        title: 'Сроки хранения и удаление',
        paragraphs: [
          `Журнал действий хранится столько, сколько предусматривает тариф: ${history('free')} дней на бесплатном, ${history('personal')} на «Личном», ${history('pro')} на «Про». Во время бесплатного пробного периода действует срок «Про». Более старые записи удаляются раз в сутки. Журнал команды хранится по тарифу того, кто за неё платит.`,
          'Переписка мессенджера хранится столько, сколько выбрано на странице этого аккаунта: 30, 90 или 365 дней либо пока аккаунт подключён. Новый аккаунт начинает с 90 дней. Сообщения старше этого срока раз в сутки удаляются из нашей копии (в самом мессенджере они остаются). Если мессенджер сообщает, что сообщение удалено, его текст и вложения стираются и из копии. Исходящие сообщения удаляются из очереди отправки через 30 дней после отправки (в самой переписке они остаются).',
          'Вы можете отключить любой аккаунт сервиса: сразу удаляются его ключи, а у мессенджера ещё и вся сохранённая переписка, очередь отправки и сессия. Или удалите свой аккаунт Manyplug в настройках: все подключения, ключи, токены, переписка и история будут удалены.',
          'Разрешение вести разговор заканчивается само по сроку (не больше 72 часов) или когда вы его отзываете. Подтверждения, на которые вы ответили, удаляются через сутки.',
          'Удалённые данные ещё до 30 дней могут оставаться в зашифрованных резервных копиях базы, пока эти копии не удалятся.',
        ],
      },
      {
        title: 'Скоро: автоматизации со своим ключом ИИ',
        paragraphs: [
          'Мы готовим правила, которые реагируют на новые события (например, новое письмо) и могут разбудить модель ИИ по вашему собственному API-ключу (OpenAI и других). Сейчас это не работает. Когда функция появится, ваш ключ будет храниться зашифрованным, как остальные данные для входа, а текст события, который правило передаёт модели, будет уходить этому провайдеру по его правилам. Мы обновим эту политику до включения функции.',
        ],
      },
      {
        title: 'Cookie',
        paragraphs: [
          'Мы используем только необходимые cookie: сессия входа, защита форм от подделки, выбранный язык. Рекламных и аналитических cookie нет. Выбранная тема хранится в вашем браузере.',
        ],
      },
      {
        title: 'Статистика посещений',
        paragraphs: [
          'Мы сами считаем посещения сайта, без сторонних счётчиков и без cookie. Из IP-адреса и названия браузера вычисляется анонимный идентификатор с секретом, который меняется каждый день и удаляется через два дня, поэтому визит нельзя связать с человеком. IP-адрес не сохраняется.',
          'Сохраняются страница, сайт или рекламная метка, с которых пришёл посетитель, страна, язык браузера и тип устройства. При регистрации мы запоминаем, откуда пришёл новый пользователь, по визиту из того же браузера в тот же или предыдущий день, чтобы понимать, какая реклама работает.',
        ],
      },
      {
        title: 'Ваши права',
        paragraphs: [
          'Подключения и журнал действий видны в личном кабинете. Копию своих данных можно скачать одним файлом в настройках кабинета («Ваши данные»), а профиль там же удалить. Попросить об исправлении данных или о помощи с копией и удалением можно по адресу ниже. Мы отвечаем в течение 30 дней.',
          'Manyplug не предназначен для детей младше 16 лет, и мы сознательно не собираем их данные.',
          'При изменении политики новая редакция публикуется на этой странице с датой. О существенных изменениях мы сообщаем на сайте до того, как они вступят в силу.',
        ],
      },
      {
        title: 'Контакты',
        paragraphs: [`Вопросы о данных и запросы на их удаление присылайте на ${contact}.`],
      },
    ],
  }),
  en: ({ contact, site, merchant }) => ({
    title: 'Privacy policy',
    updated: PRIVACY_UPDATED.en,
    intro: `This page explains what data Manyplug (${site}) collects, why, and how we protect it. In short: we keep only what connections need, encrypt access keys and never sell data.`,
    sections: [
      {
        title: 'What we store',
        paragraphs: [
          'Your account: email address, name and Google ID if you sign in with Google; a hash of your password if you set one; passkey public keys and two-step verification settings; sign-up and last sign-in dates; interface language.',
          'Your private vault: its public key, and its private key wrapped only under secrets we do not hold (a device key in your browser’s cookie, your AI apps’ tokens, an optional recovery key).',
          'Connections: names of your connected service accounts, their settings and credentials (OAuth tokens, API keys, app passwords). Credentials are stored only encrypted, each account with its own key.',
          'Messengers (personal Telegram, Telegram Bot, WhatsApp): if you connect a messenger, Manyplug keeps its own copy of the chats that reach it, so your AI app can read and search messages quickly without asking the messenger every time. The copy holds chat names, message text, senders, dates and attachment details (file name, type and size, not the file itself), plus outgoing messages waiting to be sent. Messages are saved as they are sent and received, not only when your AI app asks. A personal Telegram account also copies the latest messages of your recent chats when you connect it, and keeps the session keys and the list of people you chat with that Telegram needs to stay signed in. A Telegram bot keeps the chats that reach that bot.',
          'Conversations your AI carries on: if you let an AI app carry on a conversation in a chat, we keep that permission (which chat, which AI app, the goal you gave, until when and how many messages) until it ends or you revoke it.',
          'Teams: which teams you belong to and your role, invitations (the invited email), whom you shared your accounts with and at what level, and who pays for the team.',
          `Billing: your plan, the subscription status and its ${merchant?.name ?? 'payment provider'} id. Card details and billing address stay with ${merchant?.name ?? 'the provider'} and never reach us.`,
          'Notification bot: if you link Telegram for confirmations, we keep the id of your chat with the Manyplug bot and its language.',
          'Activity log: which tool was called, when, by which AI app and whether it succeeded. Call arguments and the contents of your mail, files and messages are not logged.',
          'Technical data: IP address and browser, for sign-in sessions and abuse protection.',
        ],
      },
      {
        title: 'How we use data',
        paragraphs: [
          'To run your AI assistant’s requests to the services you connected, to show you history and usage, and to protect your account from break-ins and abuse.',
          'Content of your mail, calendars, files and other services passes through Manyplug only during a request, goes to the AI app you gave access to and is not stored. Messengers are the exception: their chats are stored as described above.',
          'When your AI app replies in a messenger chat, Manyplug first marks that chat as read up to the latest incoming message, as if you had opened it, so the other person sees the messages as read. Reading a chat through the AI never marks it as read.',
          'We do not use the content of your services or messages to train models and do not look at it.',
        ],
      },
      {
        title: 'Who receives data',
        paragraphs: [
          'AI apps you connected (Claude, ChatGPT, Cursor and others) receive tool results they asked for. Their own policies govern how they treat that data.',
          'Connected services receive your requests made on your behalf.',
          'Members of your teams get the team accounts and those of your accounts you shared with them, at the level you chose. A team’s owner and admins do not see your personal accounts you did not share. Whoever pays for a team sees the team’s actions in their plan’s usage count, not what the actions were.',
          `${merchant ? `${merchant.name} (our reseller and Merchant of Record)` : 'Our payment provider'} receives what a payment needs: email, country and plan. Render (Frankfurt, EU) hosts the encrypted database. Our email provider receives the address and text of the emails we send you. An error tracker, when enabled, receives error reports with arguments, tokens and contents removed.`,
          'We do not sell data or share it with ad networks.',
        ],
      },
      {
        title: 'AI apps and your conversations',
        paragraphs: [
          'Manyplug never receives your chat history, the AI app’s memory or files you gave the AI app. For each request the AI app sends only the name of a tool and the arguments it needs, for example a search query. The arguments are used for that one request and are not stored, with three exceptions: a write action is remembered for a few minutes so that a repeated request does not run it twice; an action waiting for your confirmation is kept encrypted until you answer and deleted a day after that; and a message sent through a messenger becomes part of the stored chat.',
          'If you chose to confirm actions in the AI chat, the AI app shows you the action and asks you, and its repeat of the same call from the same app runs it. With confirmation by link, the decision is made only on the website or in the Manyplug bot.',
          'If an AI app sends an anonymous user ID with requests (ChatGPT does), we keep only a one-way hash of it, to count usage per AI account.',
        ],
      },
      {
        title: 'Data from Google services',
        paragraphs: [
          'If you connect Gmail, Google Calendar or Google Drive, Manyplug accesses only the data your AI assistant needs for a request: finding and reading emails, sending a reply, viewing or creating an event, finding and reading a file. The data goes only to the AI app you chose and is not stored, except that the result of a write action (for example, a sent email) is kept in memory for a few minutes so that a repeated request does not send it twice.',
          'We do not sell data from Google services, use it for advertising, transfer it to data brokers or use it to train AI models. No person reads this data unless you ask us to, it is needed for security, or the law requires it.',
          'Manyplug’s use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy (https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.',
          'You can revoke access at any time: disconnect the account in the Manyplug dashboard or in your Google Account settings (myaccount.google.com/permissions).',
        ],
      },
      {
        title: 'Protection',
        paragraphs: [
          'Credentials are encrypted (AES-256-GCM) with a separate key per account. Your Manyplug password is stored as a scrypt hash and sign-in tokens only as SHA-256 hashes. Two-step verification and passkeys are available.',
          'The key of a personal account connected after your vault was created is sealed to that vault: only a request from your browser, an AI app or a personal token you allowed can open it, and the server keeps no key that does. Keys of team accounts, messengers and personal accounts connected before your vault existed are still wrapped by the server’s master key. The Trust page (/trust) explains this in detail.',
          'Stored messenger chats (text, senders, chat names, attachment details), the queue of outgoing messages and the session state are encrypted with the same per-account key. Chat and message ids from the messenger are stored only as keyed hashes, and search works on keyed hashes of words rather than on readable text.',
          'Risky actions can be set to run only after you confirm them.',
        ],
      },
      {
        title: 'Retention and deletion',
        paragraphs: [
          `The activity log is kept as long as your plan includes: ${history('free')} days on Free, ${history('personal')} on Personal, ${history('pro')} on Pro. During the free trial the Pro period applies. Older entries are deleted once a day. A team’s log follows the plan of whoever pays for it.`,
          'A messenger’s chats are kept for the period chosen on that account’s page: 30, 90 or 365 days, or as long as the account stays connected. A newly connected account starts with 90 days. Messages past the period are deleted from our copy once a day (they stay in the messenger itself). When the messenger reports that a message was deleted, its text and attachments are erased from the copy as well. Outgoing messages are deleted from the sending queue 30 days after they were sent (they stay in the chat itself).',
          'You can disconnect any service account: its credentials are deleted at once, and for a messenger so are all its stored chats, sending queue and session. Or delete your Manyplug account in Settings: all connections, keys, tokens, chats and history are removed.',
          'A permission to carry on a conversation ends on its own when its time runs out (72 hours at most) or when you revoke it. Answered confirmations are deleted a day later.',
          'Deleted data can stay in encrypted database backups for up to 30 more days, until those backups are deleted.',
        ],
      },
      {
        title: 'Coming soon: automations with your own AI key',
        paragraphs: [
          'We are building rules that react to new events (for example a new email) and can wake an AI model with your own API key (OpenAI and others). This does not work yet. When it ships, your key will be stored encrypted like other credentials, and the event text a rule passes to the model will go to that provider under its terms. We will update this policy before the feature is turned on.',
        ],
      },
      {
        title: 'Cookies',
        paragraphs: [
          'We only use necessary cookies: the sign-in session, form protection and your language. No advertising or analytics cookies. Your theme choice is kept in your browser.',
        ],
      },
      {
        title: 'Visit statistics',
        paragraphs: [
          'We count visits to the website ourselves, without third-party trackers and without cookies. An anonymous id is computed from the IP address and the browser name with a secret that changes every day and is deleted after two days, so a visit cannot be linked to a person. The IP address is not stored.',
          'We store the page, the referring site or ad tag a visitor came from, the country, the browser language and the device type. When you sign up, we note where you came from, using the visit from the same browser on that day or the day before, to understand which ads work.',
        ],
      },
      {
        title: 'Your rights',
        paragraphs: [
          'You can see your connections and activity in the dashboard, download a copy of your data as one file in Settings (“Your data”), and delete your account there. To have data corrected, or for help with a copy or deletion, write to the contact below. We answer within 30 days.',
          'Manyplug is not meant for children under 16, and we do not knowingly collect their data.',
          'When this policy changes, the new version is published on this page with its date. Material changes are announced on the website before they take effect.',
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
  ru: ({ contact, site, operator, merchant }) => ({
    title: 'Условия использования',
    updated: CURRENT.ru,
    intro: `Эти условия действуют, когда вы пользуетесь сервисом Manyplug (${site}). Регистрируясь, вы с ними соглашаетесь. ${operator ? `Сервисом управляет ${operator}, частное лицо в Объединённых Арабских Эмиратах.` : 'Сервисом управляет частное лицо в Объединённых Арабских Эмиратах.'}`,
    sections: [
      {
        title: 'Что делает сервис',
        paragraphs: [
          'Manyplug даёт ИИ-ассистентам доступ к сервисам, которые вы подключили, по протоколу MCP. Вы сами выбираете, какие аккаунты подключать, каким приложениям давать доступ и какие действия требуют подтверждения.',
          'Сервис также хранит переписку подключённых мессенджеров, чтобы ИИ мог по ней искать, позволяет работать командой через общий адрес и по вашей просьбе даёт ИИ вести разговор в чате. Как обращаемся с данными, описано в политике конфиденциальности (/privacy) и на странице «Доверие» (/trust).',
        ],
      },
      {
        title: 'Ваш аккаунт',
        paragraphs: [
          'Вы отвечаете за сохранность доступа к своему аккаунту и за действия, которые ИИ-приложения выполняют от вашего имени с выданным вами доступом. Рекомендуем включить двухэтапную проверку и подтверждение опасных действий.',
          'Подключайте только аккаунты, которыми вы вправе пользоваться, и соблюдайте правила самих сервисов.',
          'Ключи ваших личных аккаунтов запечатаны в личном сейфе, который открывают ваши браузеры, ИИ-приложения и ключ восстановления. Если вы потеряете их все и не создали ключ восстановления, мы не сможем открыть сейф за вас: такие аккаунты придётся подключить заново. Данные в самих сервисах при этом не теряются.',
        ],
      },
      {
        title: 'Подтверждения',
        paragraphs: [
          'Рискованные действия (например, отправка писем и сообщений) по умолчанию ждут вашего подтверждения по ссылке или в боте Manyplug. Вы можете выбрать подтверждение прямо в чате ИИ: тогда ИИ-приложение спрашивает вас само, и вы отвечаете за то, что разрешили. Удаление аккаунтов и расширение доступа всегда подтверждаются вне чата.',
        ],
      },
      {
        title: 'Мессенджеры и разговоры',
        paragraphs: [
          'Сообщения, которые ваш ИИ отправляет через подключённый мессенджер, уходят от вашего имени, и за них отвечаете вы. Соблюдайте правила мессенджера: не пишите людям массово и тем, кто не ждёт ваших сообщений.',
          'Вести разговор в чате ИИ может только после вашего одобрения, в одном чате, ограниченное время и число сообщений. Вы можете остановить разговор в любой момент. Когда ИИ отвечает, чат отмечается прочитанным, и собеседник это видит.',
        ],
      },
      {
        title: 'Команды',
        paragraphs: [
          'Владелец и администраторы команды подключают и меняют аккаунты команды, приглашают и удаляют участников. Каждый участник входит под своим аккаунтом и сам решает, делиться ли своими аккаунтами.',
          'Команда работает на тарифе того, кто за неё платит, и её действия входят в лимиты этого тарифа. Когда участник выходит, его аккаунты возвращаются в его личное пространство.',
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
        title: 'Оплата',
        paragraphs: [
          merchant
            ? `Платежи принимает наш реселлер ${merchant.legalName} (Merchant of Record): он выставляет счёт, списывает оплату, начисляет налоги и обрабатывает возвраты. При оплате действуют также условия покупателя ${merchant.name} (${merchant.buyerTerms}).`
            : 'Платежи принимает наш платёжный провайдер: он списывает оплату и обрабатывает возвраты.',
          'Подписка продлевается автоматически в конце каждого периода, пока вы её не отмените. Отменить можно в любой момент в разделе «Тариф и лимиты» или из чата; тариф остаётся до конца оплаченного периода. Возвраты описаны в политике возврата (/refunds).',
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
          'Вы можете в любой момент удалить аккаунт в настройках: все подключения и данные удаляются сразу. Мы можем закрыть аккаунт при нарушении этих условий.',
        ],
      },
      {
        title: 'Изменения условий',
        paragraphs: [
          'Новая редакция публикуется на этой странице с датой. О существенных изменениях мы сообщаем на сайте до того, как они вступят в силу.',
        ],
      },
      {
        title: 'Контакты',
        paragraphs: [`Вопросы по условиям присылайте на ${contact}.`],
      },
    ],
  }),
  en: ({ contact, site, operator, merchant }) => ({
    title: 'Terms of service',
    updated: CURRENT.en,
    intro: `These terms apply when you use Manyplug (${site}). By signing up you accept them. ${operator ? `Manyplug is operated by ${operator}, an individual based in the United Arab Emirates.` : 'Manyplug is operated by an individual based in the United Arab Emirates.'}`,
    sections: [
      {
        title: 'What the service does',
        paragraphs: [
          'Manyplug gives AI assistants access to services you connected, over the MCP protocol. You choose which accounts to connect, which apps get access and which actions need your confirmation.',
          'It also keeps the chats of connected messengers so your AI can search them, lets a team work through one shared address, and, when you ask, lets your AI carry on a conversation in a chat. How we handle data is described in the privacy policy (/privacy) and on the Trust page (/trust).',
        ],
      },
      {
        title: 'Your account',
        paragraphs: [
          'You are responsible for keeping access to your account safe and for what AI apps do on your behalf with the access you granted. We recommend turning on two-step verification and confirmations for risky actions.',
          'Only connect accounts you are allowed to use, and follow the rules of those services.',
          'Keys to your personal accounts are sealed in your private vault, which your browsers, AI apps and recovery key open. If you lose all of them and did not create a recovery key, we cannot open the vault for you: those accounts have to be connected again. Your data in the services themselves is not lost.',
        ],
      },
      {
        title: 'Confirmations',
        paragraphs: [
          'Risky actions (such as sending email and messages) wait for your confirmation by link or in the Manyplug bot by default. You can choose to confirm right in the AI chat instead: the AI app then asks you itself, and you are responsible for what you allow. Removing accounts and widening access are always confirmed outside the chat.',
        ],
      },
      {
        title: 'Messengers and conversations',
        paragraphs: [
          'Messages your AI sends through a connected messenger go out in your name, and you are responsible for them. Follow the messenger’s rules: no bulk messages, and no messages to people who do not expect to hear from you.',
          'Your AI can carry on a conversation in a chat only after you approve it, in one chat, for a limited time and number of messages. You can stop it at any moment. When the AI replies, the chat is marked as read, and the other person sees that.',
        ],
      },
      {
        title: 'Teams',
        paragraphs: [
          'A team’s owner and admins connect and change team accounts and invite and remove members. Every member signs in as themselves and decides whether to share their own accounts.',
          'A team runs on the plan of whoever pays for it, and its actions count toward that plan’s limits. When a member leaves, their accounts go back to their personal space.',
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
        title: 'Payments',
        paragraphs: [
          merchant
            ? `Our order process is conducted by our online reseller ${merchant.legalName}. ${merchant.legalName} is the Merchant of Record for all our orders: it invoices you, takes the payment, handles taxes and processes refunds. ${merchant.name}’s buyer terms (${merchant.buyerTerms}) also apply to your purchase.`
            : 'Payments are taken by our payment provider, which charges you and processes refunds.',
          'Subscriptions renew automatically at the end of each period until you cancel. You can cancel at any time on the Plan and limits page or from the chat; the plan stays until the end of the paid period. Refunds are covered by our refund policy (/refunds).',
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
          'You can delete your account at any time in Settings: every connection and all data are deleted at once. We may close accounts that break these terms.',
        ],
      },
      {
        title: 'Changes to these terms',
        paragraphs: [
          'A new version is published on this page with its date. Material changes are announced on the website before they take effect.',
        ],
      },
      {
        title: 'Contact',
        paragraphs: [`Send questions about these terms to ${contact}.`],
      },
    ],
  }),
};

const refunds: Record<Locale, Builder> = {
  ru: ({ contact, site, merchant }) => ({
    title: 'Политика возврата',
    updated: REFUNDS_UPDATED.ru,
    intro: `Здесь описано, когда и как можно вернуть деньги за платный тариф Manyplug (${site}). Коротко: в течение 14 дней после любой оплаты вернём деньги полностью, без объяснения причин.`,
    sections: [
      {
        title: '14 дней на возврат',
        paragraphs: [
          'Если тариф не подошёл, напишите нам в течение 14 дней после оплаты (первой или очередного продления, месячной или годовой), и мы вернём всю сумму этого платежа. Объяснять причину не нужно.',
          'После возврата подписка отменяется и аккаунт переходит на бесплатный тариф. Подключённые аккаунты и настройки сохраняются.',
        ],
      },
      {
        title: 'После 14 дней',
        paragraphs: [
          'Позже 14 дней оплаченный период не возвращается, но вы можете в любой момент отменить подписку: тариф останется до конца оплаченного периода, и новых списаний не будет.',
          'Если сервис не работал по нашей вине или с вас списали деньги по ошибке, мы вернём деньги и позже — напишите нам.',
        ],
      },
      {
        title: 'Как запросить возврат',
        paragraphs: [
          `Напишите на ${contact} с адреса, с которого оформлена подписка, или ответьте на чек от ${merchant?.name ?? 'платёжного провайдера'}. Возврат проводит ${merchant ? `наш реселлер ${merchant.legalName}` : 'платёжный провайдер'} на ту же карту или счёт; обычно деньги приходят за 5–10 рабочих дней в зависимости от банка.`,
        ],
      },
      {
        title: 'Пробный период',
        paragraphs: ['Пробный период Pro бесплатный: деньги за него не списываются, и возвращать нечего.'],
      },
    ],
  }),
  en: ({ contact, site, merchant }) => ({
    title: 'Refund policy',
    updated: REFUNDS_UPDATED.en,
    intro: `This page explains when and how you can get your money back for a paid Manyplug plan (${site}). In short: within 14 days of any payment we refund it in full, no questions asked.`,
    sections: [
      {
        title: '14-day money-back guarantee',
        paragraphs: [
          'If the plan is not right for you, contact us within 14 days of a payment (the first one or a renewal, monthly or yearly) and we refund that payment in full. You do not need to give a reason.',
          'After a refund the subscription is canceled and the account moves to the free plan. Connected accounts and settings are kept.',
        ],
      },
      {
        title: 'After 14 days',
        paragraphs: [
          'After 14 days the paid period is not refunded, but you can cancel at any time: the plan stays until the end of the paid period and you are not charged again.',
          'If the service did not work because of us, or you were charged by mistake, we refund later payments too. Just write to us.',
        ],
      },
      {
        title: 'How to request a refund',
        paragraphs: [
          `Write to ${contact} from the address you subscribed with, or reply to your ${merchant?.name ?? 'payment'} receipt. Refunds are processed by ${merchant ? `our reseller ${merchant.legalName}` : 'our payment provider'} to the original card or account and usually arrive within 5–10 business days, depending on your bank.`,
        ],
      },
      {
        title: 'Free trial',
        paragraphs: ['The Pro trial is free: you are not charged for it, so there is nothing to refund.'],
      },
    ],
  }),
};
