import { getPlan } from '../billing/plans.js';
import type { MerchantOfRecord } from '../billing/provider.js';
import type { Locale } from './i18n.js';

/**
 * The trust page (`/trust`): what is encrypted, who can see what and how to delete data. Plain data
 * like the legal texts (`legal.ts`), so it can be corrected without touching page code. Every claim
 * here has to match the code today (docs/VAULTS.md, docs/MESSENGERS.md, docs/TEAMS.md); when the
 * protection of something changes, change its row here and the privacy policy together.
 */

/** How a kind of data is protected, shown as a badge on its row. */
export type Protection = 'sealed' | 'server' | 'hash' | 'plain' | 'transit';

export interface TrustRow {
  data: string;
  protection: Protection;
  how: string;
  who: string;
}

export interface TrustParty {
  name: string;
  sees: string[];
  never: string[];
}

export interface TrustDoc {
  title: string;
  description: string;
  updated: string;
  lead: string;
  glance: { icon: 'lock' | 'eye' | 'trash'; title: string; text: string }[];
  encrypted: {
    title: string;
    intro: string;
    columns: [string, string, string];
    badges: Record<Protection, string>;
    rows: TrustRow[];
  };
  who: { title: string; intro: string; seesLabel: string; neverLabel: string; parties: TrustParty[] };
  remove: { title: string; intro: string; steps: { title: string; text: string }[]; after: string[] };
  limits: { title: string; intro: string; items: string[] };
  more: { title: string; links: { label: string; href: string }[] };
}

interface Facts {
  supportEmail?: string | undefined;
  /** The active payment provider when it resells the plans (Paddle, Creem); unset = a plain processor or none. */
  merchant?: MerchantOfRecord | undefined;
}

const UPDATED = { en: 'Last updated November 12, 2026', ru: 'Редакция от 12 ноября 2026 года' };

const history = (id: 'free' | 'personal' | 'pro') => getPlan(id).limits.historyDays;

export function trustDoc(lang: Locale, facts: Facts): TrustDoc {
  return (lang === 'ru' ? ru : en)(facts);
}

function en({ supportEmail, merchant }: Facts): TrustDoc {
  const ask = supportEmail ? `Write to ${supportEmail}` : 'Write to the support address on the Support page';
  return {
    title: 'Trust: how your data is handled',
    description:
      'What Manyplug encrypts, who can see what (you, your AI apps, your team, us) and how to delete your data. Written to match how the service works today, including what is not protected yet.',
    updated: UPDATED.en,
    lead: 'What we encrypt, who can see what, and how to delete everything. Each line matches how the service works today, including the parts that are not as protected as we want yet.',
    glance: [
      {
        icon: 'lock',
        title: 'Your logins are sealed to you',
        text: 'Keys to the personal accounts you connect are locked in your private vault. Only your browsers and the AI apps you allowed can open it. A copy of our database plus our server key opens none of them.',
      },
      {
        icon: 'eye',
        title: 'Content passes through',
        text: 'Mail, files, calendars and documents go from the service to your AI app during a request and are not stored. Messenger chats are the exception: they are kept encrypted so your AI can search them.',
      },
      {
        icon: 'trash',
        title: 'Delete it yourself, at once',
        text: 'Remove one account, disconnect an AI app or delete your whole profile from the dashboard. Nothing waits for us. Encrypted backups roll off within 30 days.',
      },
    ],
    encrypted: {
      title: 'What is encrypted',
      intro:
        'Everything sensitive is encrypted with AES-256-GCM, each connected account with its own key. What differs is who holds the key that opens that account key.',
      columns: ['Data', 'How it is protected', 'Who can open it'],
      badges: {
        sealed: 'Sealed to you',
        server: 'Server key',
        hash: 'Hash only',
        plain: 'Not encrypted',
        transit: 'Not stored',
      },
      rows: [
        {
          data: 'Keys to your personal accounts: OAuth tokens, API keys, app passwords',
          protection: 'sealed',
          how: 'Encrypted with the account’s own key, and that key is sealed to your private vault. The vault is created on your first sign-in in a browser, with nothing to set up.',
          who: 'Only a request that brings a key to your vault: a browser you approved, an AI app or personal token you allowed, or your recovery key. The server keeps no key that opens it.',
        },
        {
          data: 'Keys to team accounts, and to personal accounts connected before your vault existed',
          protection: 'server',
          how: 'Encrypted with the account’s own key, which is wrapped by the server’s master key. Several team members use the same account, so it cannot be sealed to one person yet.',
          who: 'The server, to run a request. Someone holding both the database and the master key could decrypt them. Moving these accounts into vaults is our next step.',
        },
        {
          data: 'Messenger chats and sessions: Telegram, Telegram Bot, WhatsApp',
          protection: 'server',
          how: 'Message text, senders, chat names, attachment details, the sending queue and the session are encrypted with the account’s own key under the master key, so the messenger keeps syncing while no browser is open. Chat and message ids are stored only as keyed hashes, and search runs on keyed hashes of words.',
          who: 'The server, to sync, search and send. The same caveat as above applies.',
        },
        {
          data: 'Actions waiting for your confirmation',
          protection: 'server',
          how: 'The action and its arguments are encrypted until you answer, and deleted a day after that.',
          who: 'The server, to run the action once you approve it.',
        },
        {
          data: 'Your password and every sign-in token',
          protection: 'hash',
          how: 'The password is stored as a scrypt hash. Browser sessions, AI app tokens and personal tokens are stored only as SHA-256 hashes.',
          who: 'Nobody: a hash cannot be turned back into the password or token.',
        },
        {
          data: 'Your mail, files, calendars, documents and other service content',
          protection: 'transit',
          how: 'Fetched from the service during a request and handed to the AI app that asked. Only a write action’s result is remembered for a few minutes, so a repeated request does not run it twice.',
          who: 'The AI app that made the request, and the service itself.',
        },
        {
          data: 'Your email, name, account names, plan and the activity log',
          protection: 'plain',
          how: `Stored as is and protected by access control. The activity log records which tool ran, when, from which AI app and whether it worked, never the arguments or contents. It is kept ${history('free')} days on Free, ${history('personal')} on Personal and ${history('pro')} on Pro.`,
          who: 'You in the dashboard. The admin panel shows a summary (see below).',
        },
      ],
    },
    who: {
      title: 'Who can see what',
      intro: 'Each party that touches your data, what it gets and what it never gets.',
      seesLabel: 'Sees',
      neverLabel: 'Never sees',
      parties: [
        {
          name: 'Your AI apps',
          sees: [
            'The tools you allow, and the results of the calls it makes, within your rules and access profiles',
            'The names of the connected accounts it can use',
            'A request to confirm a risky action, if you chose to confirm in the chat',
          ],
          never: [
            'Your passwords and service keys: they never leave Manyplug',
            'Accounts outside its access profile',
            'What your other AI apps asked for',
          ],
        },
        {
          name: 'Your team',
          sees: [
            'Team accounts, which every member can use',
            'A personal account you shared with them, at the level you chose',
            'The member list: names and emails',
            'Whoever pays for the team: the team’s actions counted in their plan’s usage, not what they were',
          ],
          never: [
            'Your personal accounts that you did not share, including the team’s owner and admins',
            'Your sign-in, your other AI apps or your own plan’s usage',
          ],
        },
        {
          name: 'Manyplug staff (the admin panel)',
          sees: [
            'Your email, name, how you sign in and your active sessions',
            'Your plan, payment status and usage counts',
            'Which services you connected, their names and whether they work',
            'Which AI apps are signed in',
          ],
          never: [
            'Service keys or tokens: no admin screen decrypts anything',
            'The contents of your mail, files or messages',
            'Call arguments or your AI chats',
          ],
        },
        {
          name: 'People who run the servers',
          sees: [
            'Manyplug is run by one person today. With both the database and the server’s master key, that person could technically decrypt team accounts, messenger chats and accounts not yet in a vault. We don’t, and we say plainly that it is possible.',
          ],
          never: [
            'Your sealed accounts: opening them would take shipping changed code to the server and waiting for one of your own requests',
          ],
        },
        {
          name: 'The services you connect',
          sees: [
            'The requests made on your behalf, as if you used the service yourself',
            'In messengers, your contacts see the messages your AI sends and, once it replies, that the chat was read. Reading alone marks nothing as read.',
          ],
          never: ['Which AI app made the request, unless the request itself says so'],
        },
        {
          name: 'Providers we rely on',
          sees: [
            `${merchant ? `${merchant.name}, our reseller and Merchant of Record` : 'Our payment provider'}: your payment details and billing address. We get only the plan, status and subscription id.`,
            'Render (Frankfurt, EU): hosts the servers and the encrypted database',
            'Our email provider: the address and text of emails we send you',
            'An error tracker, when enabled: error reports scrubbed of arguments, tokens and contents',
          ],
          never: ['Your service keys in readable form', 'Card numbers on our side: we never see them'],
        },
      ],
    },
    remove: {
      title: 'How to delete your data',
      intro: 'All of it is self-service and takes effect at once.',
      steps: [
        {
          title: 'Remove one account',
          text: 'In the dashboard open **Services**, open the account and press **Remove**. Or ask your AI, for example “remove my old Gmail”: removal from the chat waits for your confirmation. Its keys are erased at once, and for a messenger so are all stored chats, the sending queue and the session. To revoke access on the service’s side too, use its own settings (for Google: myaccount.google.com/permissions).',
        },
        {
          title: 'Disconnect an AI app',
          text: 'Open **AI apps**, open the app and press **Disconnect**. Its tokens and its access to your vault are deleted. It can connect again only after you sign in.',
        },
        {
          title: 'Delete your Manyplug profile',
          text: 'Open **Settings**, find **Delete account**, type your email and press **Delete for good**. Every connected account, key, token, chat and the history are deleted right away.',
        },
      ],
      after: [
        `The activity log already deletes itself: entries older than your plan’s period (${history('free')}, ${history('personal')} or ${history('pro')} days) are removed every day.`,
        'Deleted data can stay in encrypted database backups for up to 30 days, until those backups expire.',
        `${merchant?.name ?? 'Our payment provider'} keeps records of payments as tax law requires, under its own policy.`,
        `Want a copy of your data, or something deleted that you cannot reach? ${ask}. We answer within 30 days.`,
      ],
    },
    limits: {
      title: 'What we do not claim',
      intro: 'So that the rest of this page can be trusted:',
      items: [
        'Manyplug is not end-to-end encrypted. To send an email for you, the server has to see that email for the moment it sends it.',
        'It is not “zero-knowledge” yet: team accounts, messengers and accounts from before your vault use the server key, as described above.',
        'Code running on the server could capture a key while one of your real requests runs. What protects you here is who can change and deploy that code.',
        'There is no external audit or certification (such as SOC 2) yet.',
        'Your AI app’s provider receives the results it asked for and handles them under its own policy.',
      ],
    },
    more: {
      title: 'Read more',
      links: [
        { label: 'Privacy policy', href: '/privacy' },
        { label: 'Terms of service', href: '/terms' },
        { label: 'System status', href: '/status' },
        { label: 'Support', href: '/support' },
      ],
    },
  };
}

function ru({ supportEmail, merchant }: Facts): TrustDoc {
  const ask = supportEmail ? `Напишите на ${supportEmail}` : 'Напишите на адрес со страницы поддержки';
  return {
    title: 'Доверие: как мы обращаемся с данными',
    description:
      'Что Manyplug шифрует, кто что видит (вы, ваши ИИ-приложения, команда, мы) и как удалить свои данные. Написано так, как сервис работает сегодня, включая то, что пока защищено слабее.',
    updated: UPDATED.ru,
    lead: 'Что мы шифруем, кто что видит и как удалить всё. Каждая строка описывает, как сервис работает сегодня, в том числе то, что пока защищено не так, как нам хочется.',
    glance: [
      {
        icon: 'lock',
        title: 'Ключи запечатаны для вас',
        text: 'Ключи к личным аккаунтам, которые вы подключаете, заперты в вашем личном сейфе. Открыть его могут только ваши браузеры и ИИ-приложения, которым вы разрешили. Копия нашей базы вместе с ключом сервера не открывает ни один из них.',
      },
      {
        icon: 'eye',
        title: 'Содержимое проходит насквозь',
        text: 'Письма, файлы, календари и документы идут из сервиса в ваше ИИ-приложение во время запроса и не сохраняются. Исключение — чаты мессенджеров: они хранятся зашифрованными, чтобы ИИ мог по ним искать.',
      },
      {
        icon: 'trash',
        title: 'Удаляете сами и сразу',
        text: 'Уберите один аккаунт, отключите ИИ-приложение или удалите весь профиль в кабинете. Ждать нас не нужно. Зашифрованные бэкапы обновляются в течение 30 дней.',
      },
    ],
    encrypted: {
      title: 'Что шифруется',
      intro:
        'Всё чувствительное шифруется AES-256-GCM, у каждого подключённого аккаунта свой ключ. Разница в том, у кого ключ, который открывает ключ аккаунта.',
      columns: ['Данные', 'Как защищены', 'Кто может открыть'],
      badges: {
        sealed: 'Запечатано для вас',
        server: 'Ключ сервера',
        hash: 'Только хеш',
        plain: 'Без шифрования',
        transit: 'Не хранится',
      },
      rows: [
        {
          data: 'Ключи к вашим личным аккаунтам: OAuth-токены, API-ключи, пароли приложений',
          protection: 'sealed',
          how: 'Зашифрованы ключом аккаунта, а сам этот ключ запечатан на ваш личный сейф. Сейф создаётся при первом входе в браузере, настраивать ничего не нужно.',
          who: 'Только запрос, который приносит ключ к сейфу: одобренный вами браузер, разрешённое ИИ-приложение или личный токен, ключ восстановления. У сервера нет ключа, который его открывает.',
        },
        {
          data: 'Ключи к аккаунтам команды и к личным аккаунтам, подключённым до появления сейфа',
          protection: 'server',
          how: 'Зашифрованы ключом аккаунта, который завёрнут мастер-ключом сервера. Аккаунтом команды пользуются несколько человек, поэтому запечатать его на одного пока нельзя.',
          who: 'Сервер, чтобы выполнить запрос. Тот, у кого есть и база, и мастер-ключ, технически может их расшифровать. Перевод этих аккаунтов в сейфы — наш следующий шаг.',
        },
        {
          data: 'Чаты и сессии мессенджеров: Telegram, Telegram Bot, WhatsApp',
          protection: 'server',
          how: 'Текст сообщений, отправители, названия чатов, данные о вложениях, очередь отправки и сессия зашифрованы ключом аккаунта под мастер-ключом, чтобы мессенджер синхронизировался, даже когда ни один браузер не открыт. Id чатов и сообщений хранятся только как хеши с ключом, поиск идёт по хешам слов.',
          who: 'Сервер, чтобы синхронизировать, искать и отправлять. Оговорка та же, что строкой выше.',
        },
        {
          data: 'Действия, которые ждут вашего подтверждения',
          protection: 'server',
          how: 'Действие и его аргументы зашифрованы до вашего ответа и удаляются через сутки после него.',
          who: 'Сервер, чтобы выполнить действие, когда вы его одобрите.',
        },
        {
          data: 'Ваш пароль и все токены входа',
          protection: 'hash',
          how: 'Пароль хранится как хеш scrypt. Сессии браузера, токены ИИ-приложений и личные токены хранятся только как хеши SHA-256.',
          who: 'Никто: из хеша нельзя получить пароль или токен.',
        },
        {
          data: 'Ваши письма, файлы, календари, документы и другое содержимое сервисов',
          protection: 'transit',
          how: 'Берутся из сервиса во время запроса и передаются ИИ-приложению, которое спросило. Только результат действия, которое что-то меняет, помнится несколько минут, чтобы повторный запрос не выполнил его дважды.',
          who: 'ИИ-приложение, сделавшее запрос, и сам сервис.',
        },
        {
          data: 'Ваша почта, имя, названия аккаунтов, тариф и журнал действий',
          protection: 'plain',
          how: `Хранятся как есть и защищены правами доступа. В журнале — какой инструмент, когда, из какого ИИ-приложения и получилось ли, без аргументов и содержимого. Хранится ${history('free')} дней на Free, ${history('personal')} на Personal и ${history('pro')} на Pro.`,
          who: 'Вы в кабинете. Админка показывает сводку (см. ниже).',
        },
      ],
    },
    who: {
      title: 'Кто что видит',
      intro: 'Все, кто касается ваших данных: что получает каждый и чего не получает никогда.',
      seesLabel: 'Видит',
      neverLabel: 'Не видит',
      parties: [
        {
          name: 'Ваши ИИ-приложения',
          sees: [
            'Разрешённые вами инструменты и результаты своих вызовов — в пределах ваших правил и профилей доступа',
            'Названия подключённых аккаунтов, которыми может пользоваться',
            'Просьбу подтвердить рискованное действие, если вы выбрали подтверждение в чате',
          ],
          never: [
            'Ваши пароли и ключи к сервисам: они не покидают Manyplug',
            'Аккаунты вне своего профиля доступа',
            'Что спрашивали другие ваши ИИ-приложения',
          ],
        },
        {
          name: 'Ваша команда',
          sees: [
            'Аккаунты команды, которыми пользуются все участники',
            'Личный аккаунт, которым вы поделились, на выбранном вами уровне',
            'Список участников: имена и почту',
            'Тот, кто платит за команду: действия команды в счётчике своего тарифа, но не какие именно',
          ],
          never: [
            'Ваши личные аккаунты, которыми вы не делились, — в том числе владелец и администраторы команды',
            'Ваш вход, другие ваши ИИ-приложения и расход вашего личного тарифа',
          ],
        },
        {
          name: 'Сотрудники Manyplug (админка)',
          sees: [
            'Вашу почту, имя, способы входа и активные сессии',
            'Тариф, статус оплаты и счётчики использования',
            'Какие сервисы подключены, их названия и работают ли они',
            'Какие ИИ-приложения вошли',
          ],
          never: [
            'Ключи и токены к сервисам: ни один экран админки ничего не расшифровывает',
            'Содержимое ваших писем, файлов и сообщений',
            'Аргументы вызовов и ваши чаты с ИИ',
          ],
        },
        {
          name: 'Те, кто управляет серверами',
          sees: [
            'Сейчас Manyplug ведёт один человек. Имея и базу, и мастер-ключ сервера, он технически может расшифровать аккаунты команд, чаты мессенджеров и аккаунты, ещё не попавшие в сейф. Мы этого не делаем и прямо говорим, что это возможно.',
          ],
          never: [
            'Ваши запечатанные аккаунты: чтобы их открыть, пришлось бы выложить на сервер изменённый код и дождаться вашего собственного запроса',
          ],
        },
        {
          name: 'Подключённые сервисы',
          sees: [
            'Запросы от вашего имени, как если бы вы пользовались сервисом сами',
            'В мессенджерах собеседники видят сообщения, которые отправил ваш ИИ, и, когда он отвечает, что чат прочитан. Само чтение ничего не отмечает прочитанным.',
          ],
          never: ['Какое ИИ-приложение сделало запрос, если в самом запросе этого нет'],
        },
        {
          name: 'Наши подрядчики',
          sees: [
            `${merchant ? `${merchant.name}, наш реселлер и Merchant of Record` : 'Платёжный провайдер'}: платёжные данные и адрес для счёта. Нам приходят только тариф, статус и id подписки.`,
            'Render (Франкфурт, ЕС): серверы и зашифрованная база',
            'Почтовый провайдер: адрес и текст писем, которые мы вам отправляем',
            'Сервис ошибок, если включён: отчёты об ошибках без аргументов, токенов и содержимого',
          ],
          never: ['Ваши ключи к сервисам в читаемом виде', 'Номер карты на нашей стороне: мы его не видим'],
        },
      ],
    },
    remove: {
      title: 'Как удалить свои данные',
      intro: 'Всё делается самостоятельно и срабатывает сразу.',
      steps: [
        {
          title: 'Удалить один аккаунт',
          text: 'В кабинете откройте **Сервисы**, откройте аккаунт и нажмите **Удалить подключение**. Или попросите ИИ, например «удали мой старый Gmail»: удаление из чата ждёт вашего подтверждения. Ключи стираются сразу, а у мессенджера — ещё и все сохранённые чаты, очередь отправки и сессия. Чтобы закрыть доступ и на стороне сервиса, используйте его настройки (для Google: myaccount.google.com/permissions).',
        },
        {
          title: 'Отключить ИИ-приложение',
          text: 'Откройте **ИИ-приложения**, выберите приложение и нажмите **Отключить**. Его токены и доступ к сейфу удаляются. Подключиться снова оно сможет только после вашего входа.',
        },
        {
          title: 'Удалить профиль Manyplug',
          text: 'Откройте **Настройки**, найдите **Удаление профиля Manyplug**, введите свою почту и нажмите **Удалить навсегда**. Все подключения, ключи, токены, чаты и история удаляются сразу.',
        },
      ],
      after: [
        `Журнал действий чистится сам: записи старше срока вашего тарифа (${history('free')}, ${history('personal')} или ${history('pro')} дней) удаляются каждый день.`,
        'Удалённые данные могут оставаться в зашифрованных бэкапах базы до 30 дней, пока эти бэкапы не удалятся.',
        `${merchant?.name ?? 'Платёжный провайдер'} хранит записи о платежах столько, сколько требует налоговое право, по своей политике.`,
        `Нужна копия данных или удалить то, до чего не дотянуться? ${ask}. Отвечаем в течение 30 дней.`,
      ],
    },
    limits: {
      title: 'Чего мы не утверждаем',
      intro: 'Чтобы остальному на этой странице можно было верить:',
      items: [
        'Manyplug не использует сквозное шифрование. Чтобы отправить письмо за вас, сервер должен видеть это письмо в момент отправки.',
        'Это пока не «zero-knowledge»: аккаунты команд, мессенджеры и аккаунты, подключённые до сейфа, открываются ключом сервера, как описано выше.',
        'Код на сервере мог бы перехватить ключ во время вашего настоящего запроса. Защита здесь в том, кто может менять и выкладывать этот код.',
        'Внешнего аудита и сертификатов (например, SOC 2) пока нет.',
        'Компания вашего ИИ-приложения получает результаты, которые оно запросило, и обращается с ними по своей политике.',
      ],
    },
    more: {
      title: 'Подробнее',
      links: [
        { label: 'Политика конфиденциальности', href: '/privacy' },
        { label: 'Условия использования', href: '/terms' },
        { label: 'Статус системы', href: '/status' },
        { label: 'Поддержка', href: '/support' },
      ],
    },
  };
}
