import { BRAND } from '../brand.js';
import type { Locale } from './i18n.js';
import type { LegalDoc } from './site.js';

/**
 * The support page (`/support`): how to reach us and answers to what people ask most. AI app
 * directories link to it as the listing's support URL. Plain data, like the legal pages.
 */
export function supportDoc(
  lang: Locale,
  facts: { publicUrl: string; supportEmail?: string | undefined },
): LegalDoc {
  const mcp = `${facts.publicUrl}/mcp`;
  return lang === 'ru' ? ru(mcp, facts.supportEmail) : en(mcp, facts.supportEmail);
}

function en(mcp: string, email: string | undefined): LegalDoc {
  return {
    title: 'Support',
    updated: 'We usually answer within one business day.',
    intro: email
      ? `Questions, problems and feedback: write to ${email}. Tell us which AI app you use and what you tried; never send passwords or keys.`
      : 'Questions, problems and feedback: use the contact link in the page footer. Tell us which AI app you use and what you tried; never send passwords or keys.',
    sections: [
      {
        title: 'Connect an AI app',
        paragraphs: [
          `Add ${BRAND.name} as a connector (custom connector, MCP server) in your AI app with the address ${mcp}. The app opens a sign-in page; after you allow access it sees your connected services. Step-by-step guides for Claude, ChatGPT, Cursor, VS Code and others are in the documentation (/docs).`,
          `No services connected yet? Ask the assistant to connect one, for example "connect my Gmail with ${BRAND.name}": it gives you a link, and you sign in to the service on our site, not in the chat.`,
        ],
      },
      {
        title: 'Something does not work',
        paragraphs: [
          'The app says it cannot reach the server or sign-in fails: remove the connector in the app and add it again with the address above.',
          'A service account shows an error: open the dashboard (/app), find the account and reconnect it. Its page says what the service answered.',
          'An action waits for confirmation: the dashboard and, if you set it up, Telegram show the request; confirm or decline it there.',
        ],
      },
      {
        title: 'Disconnect and delete',
        paragraphs: [
          'Stop an AI app from using your accounts: dashboard → AI apps, then revoke its access. You can also remove the connector in the app itself.',
          'Disconnect one service account: open it in the dashboard and choose Remove; its credentials are deleted at once.',
          'Delete your whole account: dashboard → Settings → Delete account. All connections, keys and history are removed.',
        ],
      },
      {
        title: 'Security reports',
        paragraphs: [
          email
            ? `Found a vulnerability? Write to ${email} with "Security" in the subject. Please do not test against other people’s accounts. We confirm receipt within two business days.`
            : 'Found a vulnerability? Use the contact link in the page footer with "Security" in the subject. Please do not test against other people’s accounts.',
        ],
      },
    ],
  };
}

function ru(mcp: string, email: string | undefined): LegalDoc {
  return {
    title: 'Поддержка',
    updated: 'Обычно отвечаем в течение одного рабочего дня.',
    intro: email
      ? `Вопросы, проблемы и пожелания присылайте на ${email}. Напишите, каким ИИ-приложением пользуетесь и что пробовали; никогда не присылайте пароли и ключи.`
      : 'Вопросы, проблемы и пожелания присылайте через ссылку для связи внизу страницы. Напишите, каким ИИ-приложением пользуетесь и что пробовали; никогда не присылайте пароли и ключи.',
    sections: [
      {
        title: 'Подключить ИИ-приложение',
        paragraphs: [
          `Добавьте ${BRAND.name} в ИИ-приложение как коннектор (пользовательский коннектор, MCP-сервер) с адресом ${mcp}. Приложение откроет страницу входа; после того как вы разрешите доступ, оно увидит подключённые сервисы. Пошаговые инструкции для Claude, ChatGPT, Cursor, VS Code и других — в документации (/docs).`,
          `Сервисов ещё нет? Попросите ассистента подключить, например: «подключи мой Gmail через ${BRAND.name}». Он даст ссылку, и вы войдёте в сервис на нашем сайте, а не в чате.`,
        ],
      },
      {
        title: 'Что-то не работает',
        paragraphs: [
          'Приложение пишет, что не может связаться с сервером, или вход не проходит: удалите коннектор в приложении и добавьте снова с адресом выше.',
          'У аккаунта сервиса ошибка: откройте личный кабинет (/app), найдите аккаунт и подключите заново. На его странице написано, что ответил сервис.',
          'Действие ждёт подтверждения: запрос виден в личном кабинете и, если настроено, в Telegram; подтвердите или отклоните его там.',
        ],
      },
      {
        title: 'Отключение и удаление',
        paragraphs: [
          'Запретить ИИ-приложению доступ к аккаунтам: личный кабинет → ИИ-приложения, затем отзовите доступ. Можно также удалить коннектор в самом приложении.',
          'Отключить один аккаунт сервиса: откройте его в личном кабинете и выберите «Удалить подключение»; данные для входа сразу удаляются.',
          'Удалить аккаунт целиком: личный кабинет → Настройки → Удалить аккаунт. Все подключения, ключи и история удаляются.',
        ],
      },
      {
        title: 'Сообщить об уязвимости',
        paragraphs: [
          email
            ? `Нашли уязвимость? Напишите на ${email} с темой «Security». Пожалуйста, не проверяйте её на чужих аккаунтах. Мы подтвердим получение в течение двух рабочих дней.`
            : 'Нашли уязвимость? Напишите через ссылку для связи внизу страницы с темой «Security». Пожалуйста, не проверяйте её на чужих аккаунтах.',
        ],
      },
    ],
  };
}
