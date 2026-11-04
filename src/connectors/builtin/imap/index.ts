import net from 'node:net';
import type { ImapFlow } from 'imapflow';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { z } from 'zod';
import { type AccountContext, ConnectorError, defineConnector } from '../../sdk.js';
import { day, dayAfter, mailRead, mailSearch, mailSend } from '../email/capability.js';
import {
  Addresses,
  buildForward,
  buildReply,
  composeMessage,
  envelopeRecipients,
  parseRaw,
  ReadOptions,
  readResult,
  threadingHeaders,
} from '../email/message.js';
import { type ImapLogin, ImapPool, type ResolveHost, toConnectorError } from './connection.js';
import {
  decodeId,
  encodeId,
  FOLDER_ROLES,
  fetchMessage,
  fetchRaw,
  groupIds,
  resolveFolder,
  roleOf,
  searchFolder,
  toSearchObject,
} from './mailbox.js';
import {
  guessProvider,
  PROVIDER_DOMAINS,
  PROVIDER_IDS,
  PROVIDERS,
  type Security,
  type ServerSettings,
} from './presets.js';
import { sendRaw } from './smtp.js';

const security = z.enum(['tls', 'starttls']);

const Config = z
  .object({
    email: z.email().describe('Mailbox address, e.g. me@icloud.com'),
    provider: z
      .enum(PROVIDER_IDS)
      .optional()
      .describe('Mail provider; guessed from the address when empty. "custom" requires the server fields'),
    fromName: z.string().trim().max(100).optional().describe('Sender name shown to recipients'),
    username: z.string().trim().max(200).optional().describe('Login, if it differs from the address'),
    imapHost: z.string().trim().max(253).optional().describe('IMAP server (overrides the provider)'),
    imapPort: z.number().int().min(1).max(65535).optional(),
    imapSecurity: security.optional().describe('tls (port 993) or starttls (port 143)'),
    smtpHost: z.string().trim().max(253).optional().describe('SMTP server (overrides the provider)'),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpSecurity: security.optional().describe('tls (port 465) or starttls (port 587)'),
    allowInvalidCertificate: z
      .boolean()
      .default(false)
      .describe('Accept a self-signed server certificate (self-hosted servers, Proton Mail Bridge only)'),
    saveSentCopy: z
      .boolean()
      .optional()
      .describe('Save a copy of sent mail to the Sent folder; the default depends on the provider'),
  })
  .superRefine((config, ctx) => {
    const provider = config.provider ?? guessProvider(config.email);
    if (provider !== 'custom') return;
    if (!config.imapHost)
      ctx.addIssue({ code: 'custom', path: ['imapHost'], message: 'required for a custom provider' });
    if (!config.smtpHost)
      ctx.addIssue({ code: 'custom', path: ['smtpHost'], message: 'required for a custom provider' });
  });

const Credentials = z.object({
  password: z
    .string()
    .min(1)
    .describe('App password of the mailbox (or the regular password if the provider allows it)'),
  smtpPassword: z.string().min(1).optional().describe('Only if SMTP uses a different password'),
});

type ConfigT = z.output<typeof Config>;
type CredentialsT = z.output<typeof Credentials>;
type Ctx = AccountContext<ConfigT, CredentialsT>;

interface ResolvedSettings {
  imap: ServerSettings;
  smtp: ServerSettings;
  saveSentCopy: boolean;
}

export function resolveSettings(config: ConfigT): ResolvedSettings {
  const provider = config.provider ?? guessProvider(config.email);
  const preset = provider === 'custom' ? undefined : PROVIDERS[provider];
  const server = (
    host: string | undefined,
    port: number | undefined,
    sec: Security | undefined,
    fallback: ServerSettings | undefined,
    defaults: { tls: number; starttls: number },
  ): ServerSettings => {
    const chosen = sec ?? fallback?.security ?? 'tls';
    return {
      host: host ?? fallback?.host ?? '',
      port: port ?? (host ? defaults[chosen] : fallback?.port) ?? defaults[chosen],
      security: chosen,
    };
  };
  return {
    imap: server(config.imapHost, config.imapPort, config.imapSecurity, preset?.imap, {
      tls: 993,
      starttls: 143,
    }),
    smtp: server(config.smtpHost, config.smtpPort, config.smtpSecurity, preset?.smtp, {
      tls: 465,
      starttls: 587,
    }),
    saveSentCopy: config.saveSentCopy ?? !(preset?.savesSentCopy ?? false),
  };
}

/**
 * Resolves the configured server under the hub's network policy (no private addresses in the
 * cloud). The connector then connects to the returned address, so the check cannot be bypassed by
 * DNS rebinding; the hostname is still used for TLS verification.
 */
function hostResolver(ctx: Ctx): ResolveHost {
  return (hostname) => {
    if (net.isIP(hostname.replace(/^\[|\]$/g, ''))) {
      ctx.network.assertHostAllowed(hostname);
      return Promise.resolve(hostname);
    }
    return new Promise((resolve, reject) =>
      ctx.network.lookup(hostname, { all: true }, (error, addresses) => {
        if (error) return reject(error);
        const first = Array.isArray(addresses) ? addresses[0]?.address : addresses;
        if (!first) return reject(new Error(`${hostname} has no address`));
        resolve(first);
      }),
    );
  };
}

const pool = new ImapPool();

/** Closes pooled IMAP connections (used by tests and on shutdown). */
export const closeImapConnections = () => pool.closeAll();

function imapLogin(ctx: Ctx): ImapLogin {
  return {
    server: resolveSettings(ctx.config).imap,
    user: ctx.config.username || ctx.config.email,
    password: ctx.credentials.password,
    allowInvalidCertificate: ctx.config.allowInvalidCertificate,
  };
}

async function withImap<T>(ctx: Ctx, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  try {
    return await pool.use(ctx.account.id, imapLogin(ctx), hostResolver(ctx), fn);
  } catch (error) {
    throw toConnectorError(error, 'IMAP');
  }
}

const sender = (ctx: Ctx) =>
  ctx.config.fromName ? { name: ctx.config.fromName, address: ctx.config.email } : ctx.config.email;

/** Sends a composed message over SMTP and, if the provider does not do it itself, saves it to Sent. */
async function deliver(ctx: Ctx, mail: Mail.Options): Promise<Record<string, unknown>> {
  const settings = resolveSettings(ctx.config);
  const raw = await composeMessage({ ...mail, from: sender(ctx) });
  const envelope = { from: ctx.config.email, to: envelopeRecipients(mail) };
  const result = await sendRaw(
    {
      server: settings.smtp,
      user: ctx.config.username || ctx.config.email,
      password: ctx.credentials.smtpPassword ?? ctx.credentials.password,
      allowInvalidCertificate: ctx.config.allowInvalidCertificate,
    },
    hostResolver(ctx),
    envelope,
    raw,
  );
  let savedTo: string | undefined;
  if (settings.saveSentCopy) {
    savedTo = await withImap(ctx, async (client) => {
      const sent = await resolveFolder(client, 'sent').catch(() => undefined);
      if (!sent) return undefined;
      await client.append(sent, raw, ['\\Seen']);
      return sent;
    }).catch((error) => {
      ctx.logger.warn({ err: (error as Error).message }, 'could not save the sent copy');
      return undefined;
    });
  }
  return {
    sent: true,
    ...(result.messageId ? { messageId: result.messageId } : {}),
    accepted: result.accepted,
    ...(result.rejected.length ? { rejected: result.rejected } : {}),
    ...(savedTo ? { savedTo } : {}),
  };
}

const MessageId = z.string().min(3).max(500).describe('Message id from imap_search, e.g. "INBOX:4521"');
const Folder = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe(`Folder role (${FOLDER_ROLES.join(', ')}) or a folder path from imap_list_folders`);

export default defineConnector({
  id: 'imap',
  name: 'Email (IMAP/SMTP)',
  description:
    'Any mailbox over IMAP/SMTP: Gmail, iCloud, Fastmail or your company mail. Search, read, send, reply, forward, move and flag messages.',
  version: '1.0.0',
  homepage: 'https://datatracker.ietf.org/doc/html/rfc9051',
  instructions:
    'Message ids look like "INBOX:4521" (folder:uid). imap_search returns newest first with a short snippet; call imap_read only for messages you need in full. Folders accept roles: inbox, sent, drafts, trash, junk, archive, all. To delete, move to "trash".',
  config: Config,
  credentials: Credentials,
  async test(ctx) {
    const status = await withImap(ctx, async (client) => client.status('INBOX', { messages: true }));
    const count = status ? (status.messages ?? 0) : 0;
    return { ok: true, identity: ctx.config.email, message: `INBOX: ${count} messages` };
  },
  ui: {
    primaryFields: ['email', 'password', 'provider'],
    // The app password steps follow the chosen provider, or the one the address points to.
    setupVariants: { field: 'provider', emailField: 'email', domains: PROVIDER_DOMAINS },
    locales: {
      ru: {
        setup: {
          form: {
            summary: 'Адрес почты и пароль приложения. Около двух минут.',
            variantsTitle: 'Пароль приложения: шаги для вашего сервиса',
            steps: [
              {
                text: 'Введите адрес почты в форме.',
              },
              {
                text: 'Создайте пароль приложения в настройках безопасности почты: шаги для вашего сервиса — прямо здесь.',
              },
              {
                text: 'Вставьте его в форму и нажмите «Подключить». Manyplug сразу проверит ящик.',
              },
            ],
            variants: {
              gmail: {
                title: 'Gmail / Google Workspace',
                steps: [
                  {
                    text: 'Включите двухэтапную аутентификацию в аккаунте Google, если она ещё не включена.',
                    link: {
                      label: 'Открыть двухэтапную аутентификацию',
                      url: 'https://myaccount.google.com/signinoptions/twosv',
                    },
                  },
                  {
                    text: 'Откройте «Пароли приложений», введите название Manyplug и нажмите «Создать».',
                    link: {
                      label: 'Открыть пароли приложений',
                      url: 'https://myaccount.google.com/apppasswords',
                    },
                  },
                  {
                    text: 'Скопируйте пароль из 16 букв и вставьте в форму. Пробелы не важны.',
                  },
                ],
              },
              outlook: {
                title: 'Outlook.com / Microsoft 365',
                steps: [
                  {
                    text: 'Аккаунты Microsoft больше не принимают пароли по IMAP. Подключите вместо этого сервис Outlook: он входит через Microsoft.',
                  },
                ],
              },
              icloud: {
                title: 'iCloud Mail',
                steps: [
                  {
                    text: 'Войдите в аккаунт Apple и откройте «Вход и безопасность» → «Пароли приложений».',
                    link: {
                      label: 'Открыть аккаунт Apple',
                      url: 'https://account.apple.com/account/manage',
                    },
                  },
                  {
                    text: 'Нажмите «+», назовите пароль Manyplug и скопируйте его (xxxx-xxxx-xxxx-xxxx).',
                  },
                  {
                    text: 'В форме укажите адрес @icloud.com, а не почту аккаунта Apple, если они отличаются.',
                  },
                ],
              },
              fastmail: {
                title: 'Fastmail',
                steps: [
                  {
                    text: 'Откройте Settings → Privacy & Security → Manage app passwords and access, затем New app password.',
                    link: {
                      label: 'Открыть пароли приложений Fastmail',
                      url: 'https://app.fastmail.com/settings/security/apps',
                    },
                  },
                  {
                    text: 'Выберите доступ Mail (IMAP/SMTP), назовите пароль Manyplug и нажмите Generate.',
                  },
                  {
                    text: 'Скопируйте пароль и вставьте в форму.',
                  },
                ],
              },
              yandex: {
                title: 'Яндекс Почта',
                steps: [
                  {
                    text: 'В настройках Яндекс Почты откройте «Почтовые программы» и разрешите доступ по IMAP с паролями приложений.',
                    link: {
                      label: 'Открыть настройки почтовых программ',
                      url: 'https://mail.yandex.ru/#setup/client',
                    },
                  },
                  {
                    text: 'Откройте Яндекс ID → «Безопасность» → «Пароли приложений», выберите «Почта», назовите Manyplug и создайте.',
                    link: {
                      label: 'Открыть пароли приложений',
                      url: 'https://id.yandex.ru/security/app-passwords',
                    },
                  },
                  {
                    text: 'Скопируйте пароль и вставьте в форму.',
                  },
                ],
              },
              mailru: {
                title: 'Mail.ru',
                steps: [
                  {
                    text: 'Откройте аккаунт Mail.ru → «Безопасность» → «Пароли для внешних приложений» и добавьте пароль.',
                    link: {
                      label: 'Открыть пароли для внешних приложений',
                      url: 'https://account.mail.ru/user/2-step-auth/passwords',
                    },
                  },
                  {
                    text: 'Назовите его Manyplug, выберите полный доступ к ящику (IMAP, SMTP), скопируйте пароль и вставьте в форму.',
                  },
                ],
              },
              custom: {
                title: 'Другой сервер',
                steps: [
                  {
                    text: 'Узнайте адреса и порты серверов IMAP и SMTP в справке почтового сервиса или у администратора почты.',
                  },
                  {
                    text: 'В форме выберите «Другой сервер» и заполните их в разделе «Дополнительные настройки».',
                  },
                  {
                    text: 'Используйте пароль приложения, если сервис их выдаёт, иначе — пароль ящика.',
                  },
                ],
              },
            },
            tips: ['Несколько ящиков? Подключите каждый: ИИ ищет в одном или сразу во всех.'],
          },
        },
        prompts: [
          'Покажи непрочитанные письма за сегодня в рабочей почте.',
          'Найди подтверждение брони отеля в Лиссабоне.',
          'Ответь на последнее письмо Тома, что я участвую.',
          'Перенеси рассылки за прошлую неделю в архив.',
        ],
        name: 'Почта (IMAP/SMTP)',
        description:
          'Любой почтовый ящик по IMAP/SMTP: Gmail, Яндекс Почта, Mail.ru, iCloud, Fastmail или корпоративная почта. Поиск, чтение, отправка, ответы, пересылка, папки и отметки.',
        fields: {
          email: { label: 'Адрес почты', placeholder: 'me@yandex.ru' },
          provider: {
            label: 'Почтовый сервис',
            hint: 'Обычно определяется по адресу. Для своего сервера выберите «Другой сервер» и укажите серверы IMAP и SMTP в разделе «Дополнительно».',
            placeholder: 'Определить по адресу',
            options: {
              gmail: 'Gmail / Google Workspace',
              outlook: 'Outlook.com / Microsoft 365',
              icloud: 'iCloud',
              fastmail: 'Fastmail',
              yandex: 'Яндекс Почта',
              mailru: 'Mail.ru',
              custom: 'Другой сервер',
            },
          },
          fromName: {
            label: 'Имя отправителя',
            hint: 'Его увидят получатели ваших писем',
            placeholder: 'Анна Иванова',
          },
          username: { label: 'Логин', hint: 'Если он отличается от адреса почты' },
          imapHost: {
            label: 'Адрес сервера IMAP',
            hint: 'Нужен для другого сервера или если настройки почтового сервиса не подходят',
            placeholder: 'imap.example.com',
          },
          imapPort: {
            label: 'Порт IMAP',
            hint: 'Обычно 993 для SSL/TLS или 143 для STARTTLS',
            placeholder: '993',
          },
          imapSecurity: {
            label: 'Шифрование IMAP',
            placeholder: 'Как у почтового сервиса',
            options: { tls: 'SSL/TLS', starttls: 'STARTTLS' },
          },
          smtpHost: {
            label: 'Адрес сервера SMTP',
            hint: 'Нужен для другого сервера или если настройки почтового сервиса не подходят',
            placeholder: 'smtp.example.com',
          },
          smtpPort: {
            label: 'Порт SMTP',
            hint: 'Обычно 465 для SSL/TLS или 587 для STARTTLS',
            placeholder: '465',
          },
          smtpSecurity: {
            label: 'Шифрование SMTP',
            placeholder: 'Как у почтового сервиса',
            options: { tls: 'SSL/TLS', starttls: 'STARTTLS' },
          },
          allowInvalidCertificate: {
            label: 'Доверять самоподписанному сертификату',
            hint: 'Только для своего почтового сервера или Proton Mail Bridge',
          },
          saveSentCopy: {
            label: 'Сохранять копии отправленных писем',
            hint: 'В папку «Отправленные». Gmail и Outlook делают это сами.',
          },
          password: {
            label: 'Пароль приложения',
            hint: 'Создаётся в настройках безопасности почты. Обычный пароль подойдёт, только если сервис это разрешает.',
          },
          smtpPassword: {
            label: 'Пароль для SMTP',
            hint: 'Только если для отправки писем нужен другой пароль',
          },
        },
        actions: {
          list_folders: {
            title: 'Список папок',
            description:
              'Папки почты с их назначением (входящие, отправленные, корзина…), числом писем и непрочитанных.',
          },
          search: {
            title: 'Поиск писем',
            description:
              'Ищет письма в папке, сначала новые. Показывает дату, отправителя, тему, начало текста и прочитано ли письмо.',
          },
          read: {
            title: 'Чтение письма',
            description:
              'Открывает письмо как обычный текст, без цитат прошлой переписки, с заголовками и списком вложений.',
          },
          send: {
            title: 'Отправка письма',
            description: 'Отправляет новое письмо с этого ящика. Текст — без оформления.',
          },
          reply: {
            title: 'Ответ на письмо',
            description: 'Отвечает в той же цепочке писем. Можно ответить всем получателям.',
          },
          forward: {
            title: 'Пересылка письма',
            description: 'Пересылает письмо со всеми вложениями и, если нужно, с вашим комментарием.',
          },
          move: {
            title: 'Перемещение писем',
            description: 'Переносит письма в архив, корзину, спам или любую другую папку.',
          },
          mark: {
            title: 'Отметки писем',
            description: 'Отмечает письма прочитанными или непрочитанными, ставит и снимает флажок.',
          },
        },
      },
      en: {
        setup: {
          form: {
            summary: 'Your email address and an app password. Takes about two minutes.',
            variantsTitle: 'App password: steps for your provider',
            steps: [
              {
                text: 'Enter your email address in the form.',
              },
              {
                text: 'Create an app password in your mail account’s security settings: the steps for your provider are right here.',
              },
              {
                text: 'Paste it into the form and click Connect. Manyplug checks the mailbox right away.',
              },
            ],
            variants: {
              gmail: {
                title: 'Gmail / Google Workspace',
                steps: [
                  {
                    text: 'Turn on 2-Step Verification for your Google account, if it is not on yet.',
                    link: {
                      label: 'Open 2-Step Verification',
                      url: 'https://myaccount.google.com/signinoptions/twosv',
                    },
                  },
                  {
                    text: 'Open App passwords, type Manyplug as the app name and click Create.',
                    link: {
                      label: 'Open App passwords',
                      url: 'https://myaccount.google.com/apppasswords',
                    },
                  },
                  {
                    text: 'Copy the 16-letter password and paste it into the form. Spaces do not matter.',
                  },
                ],
              },
              outlook: {
                title: 'Outlook.com / Microsoft 365',
                steps: [
                  {
                    text: 'Microsoft accounts no longer accept passwords over IMAP. Connect the Outlook service instead: it signs in with Microsoft.',
                  },
                ],
              },
              icloud: {
                title: 'iCloud Mail',
                steps: [
                  {
                    text: 'Sign in to your Apple Account and open Sign-In and Security → App-Specific Passwords.',
                    link: {
                      label: 'Open Apple Account',
                      url: 'https://account.apple.com/account/manage',
                    },
                  },
                  {
                    text: 'Click Add (+), name it Manyplug and copy the password (xxxx-xxxx-xxxx-xxxx).',
                  },
                  {
                    text: 'In the form, use your @icloud.com address, not the Apple Account email, if they differ.',
                  },
                ],
              },
              fastmail: {
                title: 'Fastmail',
                steps: [
                  {
                    text: 'Open Settings → Privacy & Security → Manage app passwords and access, then New app password.',
                    link: {
                      label: 'Open Fastmail app passwords',
                      url: 'https://app.fastmail.com/settings/security/apps',
                    },
                  },
                  {
                    text: 'Choose access to Mail (IMAP/SMTP), name it Manyplug and click Generate.',
                  },
                  {
                    text: 'Copy the password and paste it into the form.',
                  },
                ],
              },
              yandex: {
                title: 'Yandex Mail',
                steps: [
                  {
                    text: 'In Yandex Mail settings, open Email clients and allow access via IMAP with app passwords.',
                    link: {
                      label: 'Open mail client settings',
                      url: 'https://mail.yandex.ru/#setup/client',
                    },
                  },
                  {
                    text: 'Open Yandex ID → Security → App passwords, choose Mail, name it Manyplug and create it.',
                    link: {
                      label: 'Open app passwords',
                      url: 'https://id.yandex.ru/security/app-passwords',
                    },
                  },
                  {
                    text: 'Copy the password and paste it into the form.',
                  },
                ],
              },
              mailru: {
                title: 'Mail.ru',
                steps: [
                  {
                    text: 'Open Mail.ru account → Security → Passwords for external apps and add one.',
                    link: {
                      label: 'Open passwords for external apps',
                      url: 'https://account.mail.ru/user/2-step-auth/passwords',
                    },
                  },
                  {
                    text: 'Name it Manyplug, choose full access to the mailbox (IMAP, SMTP), copy the password and paste it into the form.',
                  },
                ],
              },
              custom: {
                title: 'Other server',
                steps: [
                  {
                    text: 'Find the IMAP and SMTP server names and ports in your provider’s help or ask your mail admin.',
                  },
                  {
                    text: 'In the form, choose Other server and fill them in under Advanced settings.',
                  },
                  {
                    text: 'Use an app password if your provider offers them, otherwise the mailbox password.',
                  },
                ],
              },
            },
            tips: ['Several mailboxes? Connect each one; the AI can search them one by one or all at once.'],
          },
        },
        prompts: [
          'Show today’s unread emails in my Fastmail.',
          'Find the hotel booking confirmation for Lisbon.',
          'Reply to Tom’s last email that I am in.',
          'Move last week’s newsletters to Archive.',
        ],
        fields: {
          email: { label: 'Email address', placeholder: 'me@example.com' },
          provider: {
            label: 'Mail provider',
            hint: 'Usually detected from the address. For your own server choose “Other server” and enter the IMAP and SMTP servers under “Advanced”.',
            placeholder: 'Detect from the address',
            options: {
              gmail: 'Gmail / Google Workspace',
              outlook: 'Outlook.com / Microsoft 365',
              icloud: 'iCloud',
              fastmail: 'Fastmail',
              yandex: 'Yandex Mail',
              mailru: 'Mail.ru',
              custom: 'Other server',
            },
          },
          fromName: {
            label: 'Sender name',
            hint: 'Recipients of your emails see it',
            placeholder: 'Ann Smith',
          },
          username: { label: 'Username', hint: 'If it differs from the email address' },
          imapHost: {
            label: 'IMAP server',
            hint: 'Needed for another server, or when the provider settings do not fit',
            placeholder: 'imap.example.com',
          },
          imapPort: {
            label: 'IMAP port',
            hint: 'Usually 993 for SSL/TLS or 143 for STARTTLS',
            placeholder: '993',
          },
          imapSecurity: {
            label: 'IMAP encryption',
            placeholder: 'As the provider sets it',
            options: { tls: 'SSL/TLS', starttls: 'STARTTLS' },
          },
          smtpHost: {
            label: 'SMTP server',
            hint: 'Needed for another server, or when the provider settings do not fit',
            placeholder: 'smtp.example.com',
          },
          smtpPort: {
            label: 'SMTP port',
            hint: 'Usually 465 for SSL/TLS or 587 for STARTTLS',
            placeholder: '465',
          },
          smtpSecurity: {
            label: 'SMTP encryption',
            placeholder: 'As the provider sets it',
            options: { tls: 'SSL/TLS', starttls: 'STARTTLS' },
          },
          allowInvalidCertificate: {
            label: 'Trust a self-signed certificate',
            hint: 'Only for your own mail server or Proton Mail Bridge',
          },
          saveSentCopy: {
            label: 'Save copies of sent mail',
            hint: 'To the Sent folder. Gmail and Outlook do this themselves.',
          },
          password: {
            label: 'App password',
            hint: 'Create one in your mailbox security settings. Your regular password works only if the provider allows it.',
          },
          smtpPassword: { label: 'SMTP password', hint: 'Only if sending mail needs a different password' },
        },
        actions: {
          list_folders: {
            title: 'List folders',
            description: 'Mail folders with their role (inbox, sent, trash…) and message and unread counts.',
          },
          search: {
            title: 'Search mail',
            description:
              'Finds messages in a folder, newest first, with date, sender, subject, a snippet and read status.',
          },
          read: {
            title: 'Read a message',
            description:
              'Opens a message as plain text without the quoted history, with headers and attachments.',
          },
          send: { title: 'Send an email', description: 'Sends a new plain-text email from this mailbox.' },
          reply: { title: 'Reply', description: 'Replies in the same thread, optionally to all recipients.' },
          forward: {
            title: 'Forward',
            description: 'Forwards a message with all its attachments and an optional note.',
          },
          move: {
            title: 'Move messages',
            description: 'Moves messages to the archive, trash, junk or any other folder.',
          },
          mark: {
            title: 'Mark messages',
            description: 'Marks messages read or unread and flags or unflags them.',
          },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'list_folders',
      title: 'List folders',
      description: 'Lists mail folders with their role (inbox, sent, trash, ...) and message/unread counts.',
      input: z.object({}),
      hints: { readOnly: true, idempotent: true },
      run: (_input, ctx) =>
        withImap(ctx, async (client) => {
          const folders = await client.list({ statusQuery: { messages: true, unseen: true } });
          return {
            folders: folders
              .filter((f) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'))
              .map((f) => {
                const role = roleOf(f);
                return {
                  path: f.path,
                  ...(role ? { role } : {}),
                  ...(f.status?.messages !== undefined ? { messages: f.status.messages } : {}),
                  ...(f.status?.unseen ? { unread: f.status.unseen } : {}),
                };
              }),
          };
        }),
    }),
    action({
      name: 'search',
      title: 'Search mail',
      description:
        'Finds messages in one folder, newest first. Returns id, date, from, subject, snippet, unread flag. Combine filters; all are optional.',
      input: z.object({
        folder: Folder.default('inbox'),
        query: z
          .string()
          .trim()
          .max(500)
          .optional()
          .describe('Text in subject, body or addresses. On Gmail, full Gmail search syntax works'),
        from: z.string().trim().max(320).optional().describe('Sender address or name contains'),
        to: z.string().trim().max(320).optional().describe('Recipient address or name contains'),
        subject: z.string().trim().max(500).optional().describe('Subject contains'),
        since: z.iso.date().optional().describe('Received on or after (YYYY-MM-DD)'),
        before: z.iso.date().optional().describe('Received before (YYYY-MM-DD)'),
        unread: z.boolean().optional().describe('true: only unread; false: only read'),
        flagged: z.boolean().optional().describe('true: only starred/flagged'),
        limit: z.number().int().min(1).max(50).default(15),
        cursor: z.string().max(20).optional().describe('nextCursor from the previous page'),
      }),
      hints: { readOnly: true, idempotent: true },
      capability: mailSearch((input) => ({
        folder: input.folder ?? 'inbox',
        query: input.query,
        from: input.from,
        to: input.to,
        ...(input.since ? { since: day(input.since) } : {}),
        ...(input.until ? { before: dayAfter(input.until) } : {}),
        ...(input.unread_only ? { unread: true } : {}),
        limit: input.limit,
      })),
      run: ({ folder, limit, cursor, ...filters }, ctx) =>
        withImap(ctx, async (client) => {
          const path = await resolveFolder(client, folder);
          const gmail = client.capabilities.has('X-GM-EXT-1');
          return searchFolder(client, path, toSearchObject(filters, gmail), {
            limit,
            cursor,
            snippets: true,
          });
        }),
    }),
    action({
      name: 'read',
      title: 'Read message',
      description:
        'Returns one message as plain text (HTML converted, quoted history removed by default) with headers and the attachment list.',
      input: z.object({ id: MessageId, ...ReadOptions }),
      hints: { readOnly: true, idempotent: true },
      capability: mailRead,
      run: ({ id, maxChars, includeQuoted }, ctx) =>
        withImap(ctx, async (client) => {
          const { folder, uid } = decodeId(id);
          const { parsed, flags } = await fetchMessage(client, folder, uid);
          return readResult(parsed, { id, maxChars, includeQuoted, unread: !flags.has('\\Seen') });
        }),
    }),
    action({
      name: 'send',
      title: 'Send email',
      description: 'Sends a new email from this mailbox. The body is plain text.',
      input: z.object({
        to: Addresses.min(1),
        cc: Addresses.optional(),
        bcc: Addresses.optional(),
        subject: z.string().trim().max(998).default('').describe('Default for replies: Re: original subject'),
        body: z.string().max(200_000).describe('Plain-text body'),
        replyToId: MessageId.optional().describe('Send as a reply in the thread of this message'),
      }),
      hints: { readOnly: false, destructive: false, idempotent: false },
      risk: 'write',
      capability: mailSend,
      run: async ({ to, cc, bcc, subject, body, replyToId }, ctx) => {
        let threading: Mail.Options = {};
        if (replyToId) {
          const { folder, uid } = decodeId(replyToId);
          const { parsed } = await withImap(ctx, (client) => fetchMessage(client, folder, uid));
          threading = threadingHeaders(parsed);
        }
        return deliver(ctx, { ...threading, to, cc, bcc, ...(subject ? { subject } : {}), text: body });
      },
    }),
    action({
      name: 'reply',
      title: 'Reply',
      description:
        'Replies to a message in the same thread (sets Re:, In-Reply-To and References). replyAll also copies the other recipients.',
      input: z.object({
        id: MessageId,
        body: z.string().max(200_000).describe('Plain-text reply, without the quoted original'),
        replyAll: z.boolean().default(false),
        cc: Addresses.optional().describe('Extra recipients in copy'),
      }),
      hints: { readOnly: false, destructive: false, idempotent: false },
      risk: 'write',
      run: async ({ id, body, replyAll, cc }, ctx) => {
        const { folder, uid } = decodeId(id);
        const original = await withImap(ctx, (client) => fetchMessage(client, folder, uid));
        const reply = buildReply(original.parsed, { me: ctx.config.email, body, replyAll, cc });
        const result = await deliver(ctx, reply);
        await withImap(ctx, async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            await client.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true });
          } finally {
            lock.release();
          }
        }).catch(() => {});
        return { ...result, to: reply.to, ...(reply.cc ? { cc: reply.cc } : {}) };
      },
    }),
    action({
      name: 'forward',
      title: 'Forward',
      description:
        'Forwards a message with all its attachments (attached as the original email) and an optional note.',
      input: z.object({
        id: MessageId,
        to: Addresses.min(1),
        body: z.string().max(200_000).default('').describe('Note above the forwarded message'),
      }),
      hints: { readOnly: false, destructive: false, idempotent: false },
      risk: 'write',
      run: async ({ id, to, body }, ctx) => {
        const { folder, uid } = decodeId(id);
        const raw = await withImap(ctx, (client) => fetchRaw(client, folder, uid));
        const parsed = await parseRaw(raw);
        return deliver(ctx, buildForward(raw, parsed.subject, { to, body }));
      },
    }),
    action({
      name: 'move',
      title: 'Move messages',
      description: 'Moves messages to another folder: archive, trash (delete), junk or any folder path.',
      input: z.object({
        ids: z.array(MessageId).min(1).max(200),
        to: Folder,
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      // Moving to trash is restorable until the server empties it.
      risk: 'write',
      run: ({ ids, to }, ctx) =>
        withImap(ctx, async (client) => {
          const destination = await resolveFolder(client, to);
          const moved: Record<string, string> = {};
          for (const [folder, uids] of groupIds(ids)) {
            if (folder === destination) continue;
            const lock = await client.getMailboxLock(folder);
            try {
              const result = (await client.messageMove(uids, destination, { uid: true })) || undefined;
              if (result?.uidMap) {
                for (const [from, next] of result.uidMap)
                  moved[encodeId(folder, from)] = encodeId(destination, next);
              }
            } finally {
              lock.release();
            }
          }
          return {
            moved: ids.length,
            to: destination,
            ...(Object.keys(moved).length ? { newIds: moved } : {}),
          };
        }),
    }),
    action({
      name: 'mark',
      title: 'Mark messages',
      description: 'Marks messages as read/unread and/or flagged (starred)/unflagged.',
      input: z.object({
        ids: z.array(MessageId).min(1).max(500),
        read: z.boolean().optional(),
        flagged: z.boolean().optional(),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      run: ({ ids, read, flagged }, ctx) => {
        if (read === undefined && flagged === undefined) {
          throw new ConnectorError('invalid_input', 'Pass "read" and/or "flagged".');
        }
        return withImap(ctx, async (client) => {
          for (const [folder, uids] of groupIds(ids)) {
            const lock = await client.getMailboxLock(folder);
            try {
              const apply = async (flag: string, on: boolean | undefined) => {
                if (on === undefined) return;
                if (on) await client.messageFlagsAdd(uids, [flag], { uid: true });
                else await client.messageFlagsRemove(uids, [flag], { uid: true });
              };
              await apply('\\Seen', read);
              await apply('\\Flagged', flagged);
            } finally {
              lock.release();
            }
          }
          return { updated: ids.length };
        });
      },
    }),
  ],
});
