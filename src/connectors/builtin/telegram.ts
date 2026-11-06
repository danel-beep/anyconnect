import { z } from 'zod';
import type { MessagingPort } from '../messaging.js';
import {
  conversationInstructions,
  messengerActions,
  messengerUiTexts,
  pacingConfig,
} from '../messaging-actions.js';
import { defineConnector } from '../sdk.js';

/**
 * Telegram as the user's own account: every chat, group and channel, messages sent as the user.
 * The account is a long-lived MTProto session in the messenger gateway
 * (`src/gateway/drivers/telegram`); the user logs in on the hub's page `/connect/messenger/<id>`
 * (QR code or phone number). Bots are a separate connector (`telegram-bot.ts`).
 */
const config = z.object({
  pacing: pacingConfig.optional(),
});

const credentials = z.object({});

export function createTelegramConnector(port: MessagingPort) {
  return defineConnector({
    id: 'telegram',
    name: 'Telegram',
    description:
      'Your personal Telegram account: read and search all your chats and groups, see what is new, reply and write as you. Any number of accounts.',
    version: '2.0.0',
    homepage: 'https://telegram.org',
    instructions:
      "Telegram tools read from the hub's synced copy of the chats, so reading and searching are fast and free. " +
      'Find chats with telegram_list_chats, then read or send by chat id. Use telegram_whats_new with the returned cursor to follow new messages. ' +
      'Messages are sent as the user. Before writing to someone who has not written to this account first, ask the user. ' +
      conversationInstructions('telegram'),
    config,
    credentials,
    messenger: {
      // The session lives in the gateway; personal accounts send at a person's pace (the hub's defaults).
      transport: () => ({ kind: 'session' }),
      pacing: () => ({}),
    },
    // The account is checked by logging in on the next page, through the gateway.
    async test() {
      return { ok: true };
    },
    ui: {
      locales: {
        ru: {
          description:
            'Ваш личный аккаунт Telegram: все чаты и группы, поиск по переписке, ответы от вашего имени.',
          setup: {
            form: {
              summary: 'Вы входите в свой аккаунт Telegram по QR-коду или по коду, который пришлёт Telegram.',
              minutes: 2,
              needs: ['Telegram на телефоне'],
              steps: [
                { text: 'Нажмите **Подключить**. Откроется страница входа с QR-кодом.' },
                {
                  text: 'В Telegram на телефоне откройте **Настройки → Устройства → Подключить устройство** и наведите камеру на код.',
                },
                {
                  text: 'Если у вас стоит облачный пароль, введите его на той же странице. Вместо QR-кода можно войти по номеру телефона и коду из Telegram.',
                },
              ],
              tips: [
                'Аккаунт видит все ваши чаты и группы, сообщения уходят от вашего имени. Сессию «Manyplug» можно завершить в Telegram: **Настройки → Устройства**.',
                'Код входа и облачный пароль вводите только на странице сайта. Никогда не пишите их в чат с ИИ.',
                'Нужен бот, а не личный аккаунт? Подключите сервис **Telegram Bot**.',
              ],
              problems: [
                {
                  problem: 'Телефон не распознаёт QR-код или пишет, что он устарел',
                  fix: 'Подождите несколько секунд: страница обновляет код сама. Если пишет «Время на вход истекло», начните вход заново.',
                },
                {
                  problem: 'Код из Telegram не приходит',
                  fix: 'Код приходит в чат «Telegram» в приложении, а не по SMS. Проверьте номер в международном формате, например +44 7700 900123.',
                },
                {
                  problem: 'Облачный пароль не подходит',
                  fix: 'Введите пароль двухэтапной проверки Telegram, а не код из сообщения. Подсказка к паролю показана над полем.',
                },
              ],
            },
          },
          prompts: [
            'Что нового в моих чатах Telegram за сегодня?',
            'Найди сообщения про доставку за эту неделю.',
            'Ответь Анне, что счёт будет вечером.',
          ],
          fields: { pacing: texts.ru.pacing },
          actions: texts.ru.actions,
        },
        en: {
          description:
            'Your personal Telegram account: read and search all your chats and groups, replies sent as you.',
          setup: {
            form: {
              summary:
                'You log in to your own Telegram account with a QR code or with a code Telegram sends you.',
              minutes: 2,
              needs: ['Telegram on your phone'],
              steps: [
                { text: 'Click **Connect**. The login page with a QR code opens.' },
                {
                  text: 'In Telegram on your phone open **Settings → Devices → Link Desktop Device** and point the camera at the code.',
                },
                {
                  text: 'If you have a cloud password, enter it on the same page. Instead of the QR code you can log in with your phone number and a code from Telegram.',
                },
              ],
              tips: [
                'The account sees all your chats and groups, and messages are sent as you. You can end the "Manyplug" session in Telegram under **Settings → Devices**.',
                'Type the login code and cloud password only on the website page. Never write them in the AI chat.',
                'Need a bot rather than your own account? Connect the **Telegram Bot** service.',
              ],
              problems: [
                {
                  problem: 'The phone does not read the QR code or says it has expired',
                  fix: 'Wait a few seconds: the page refreshes the code by itself. If it says "This login has expired", start the login again.',
                },
                {
                  problem: 'The code from Telegram does not arrive',
                  fix: 'The code arrives in the "Telegram" chat inside the app, not by SMS. Check that the number is in international format, for example +44 7700 900123.',
                },
                {
                  problem: 'The cloud password is not accepted',
                  fix: 'Enter your Telegram two-step verification password, not the code from a message. The password hint is shown above the field.',
                },
              ],
            },
          },
          prompts: [
            'What is new in my Telegram chats today?',
            'Find messages about delivery from this week.',
            'Tell Anna the invoice comes tonight.',
          ],
          fields: { pacing: texts.en.pacing },
          actions: texts.en.actions,
        },
      },
    },
    actions: (action) => messengerActions(action, port, { serviceName: 'Telegram' }),
  });
}

const texts = messengerUiTexts('Telegram');
