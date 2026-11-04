import { BRAND, LEGACY_SLUGS } from '../brand.js';
import { type ConnectorDefinition, connectorText, type UiLanguage } from '../connectors/sdk.js';
import type { IconName } from './ui.js';

/**
 * How services look on the website: logo, category and a short human description in both
 * languages. Connectors stay free of presentation; a service without an entry here still shows up
 * (first letter as logo, its own description, category "other").
 */
export type ServiceCategory =
  | 'mail'
  | 'messengers'
  | 'calendar'
  | 'files'
  | 'docs'
  | 'tasks'
  | 'dev'
  | 'payments'
  | 'crm'
  | 'custom'
  | 'other';

export const CATEGORY_ORDER: ServiceCategory[] = [
  'mail',
  'messengers',
  'calendar',
  'docs',
  'files',
  'tasks',
  'dev',
  'payments',
  'crm',
  'custom',
  'other',
];

export interface ServiceMeta {
  icon?: string;
  glyph?: IconName;
  category: ServiceCategory;
  blurb: { ru: string; en: string };
  /**
   * Another way in while this service cannot be connected here (its sign-in app is not set up):
   * a connector and form values to start it with, e.g. Gmail through IMAP with an app password.
   */
  alternative?: { connectorId: string; values?: Record<string, string> };
}

export const SERVICE_META: Record<string, ServiceMeta> = {
  gmail: {
    icon: 'gmail',
    category: 'mail',
    blurb: { ru: 'Поиск, чтение, черновики и отправка писем.', en: 'Search, read, draft and send email.' },
    alternative: { connectorId: 'imap', values: { 'config.provider': 'gmail' } },
  },
  outlook: {
    glyph: 'mail',
    category: 'mail',
    blurb: {
      ru: 'Почта и календарь Microsoft 365 и Outlook.com.',
      en: 'Microsoft 365 and Outlook.com mail and calendar.',
    },
  },
  imap: {
    glyph: 'mail',
    category: 'mail',
    blurb: {
      ru: 'Любой ящик по IMAP/SMTP: iCloud, Fastmail, Яндекс или корпоративная почта.',
      en: 'Any IMAP/SMTP mailbox: iCloud, Fastmail or your company mail.',
    },
  },
  slack: {
    glyph: 'hash',
    category: 'messengers',
    blurb: { ru: 'Каналы, поиск по сообщениям, отправка.', en: 'Channels, message search, posting.' },
  },
  telegram: {
    icon: 'telegram',
    category: 'messengers',
    blurb: {
      ru: 'Ваш бот: чаты, поиск по переписке, ответы.',
      en: 'Your bot: chats, message search, replies.',
    },
  },
  whatsapp: {
    icon: 'whatsapp',
    category: 'messengers',
    blurb: {
      ru: 'Номер WhatsApp Business через официальный API: чаты, поиск, ответы.',
      en: 'A WhatsApp Business number through the official API: chats, search, replies.',
    },
  },
  gcal: {
    icon: 'googlecalendar',
    category: 'calendar',
    blurb: { ru: 'События, свободное время, приглашения.', en: 'Events, free time, invitations.' },
  },
  gdrive: {
    icon: 'googledrive',
    category: 'files',
    blurb: { ru: 'Поиск файлов и чтение документов.', en: 'Find files and read documents.' },
  },
  notion: {
    icon: 'notion',
    category: 'docs',
    blurb: {
      ru: 'Страницы и базы: поиск, чтение и запись.',
      en: 'Pages and databases: search, read, write.',
    },
  },
  todoist: {
    icon: 'todoist',
    category: 'tasks',
    blurb: {
      ru: 'Задачи и проекты: списки, создание, закрытие.',
      en: 'Tasks and projects: list, add, complete.',
    },
  },
  github: {
    icon: 'github',
    category: 'dev',
    blurb: { ru: 'Репозитории, issues и pull requests.', en: 'Repositories, issues and pull requests.' },
  },
  stripe: {
    icon: 'stripe',
    category: 'payments',
    blurb: { ru: 'Платежи, клиенты, счета и возвраты.', en: 'Payments, customers, invoices and refunds.' },
  },
  jira: {
    icon: 'jira',
    category: 'tasks',
    blurb: {
      ru: 'Задачи по JQL, создание, статусы и комментарии.',
      en: 'Issues by JQL, create, change status, comment.',
    },
  },
  linear: {
    icon: 'linear',
    category: 'tasks',
    blurb: {
      ru: 'Задачи команд: поиск, создание, статусы.',
      en: 'Team issues: find, create, change status.',
    },
  },
  asana: {
    icon: 'asana',
    category: 'tasks',
    blurb: {
      ru: 'Задачи и проекты: списки, создание, выполнение.',
      en: 'Tasks and projects: list, add, complete.',
    },
  },
  trello: {
    icon: 'trello',
    category: 'tasks',
    blurb: { ru: 'Доски, списки и карточки.', en: 'Boards, lists and cards.' },
  },
  airtable: {
    icon: 'airtable',
    category: 'docs',
    blurb: { ru: 'Базы и таблицы: поиск и запись данных.', en: 'Bases and tables: find and write records.' },
  },
  hubspot: {
    icon: 'hubspot',
    category: 'crm',
    blurb: { ru: 'Контакты, компании и сделки.', en: 'Contacts, companies and deals.' },
  },
  confluence: {
    icon: 'confluence',
    category: 'docs',
    blurb: { ru: 'Поиск и чтение страниц, новые страницы.', en: 'Search and read pages, write new ones.' },
  },
  gsheets: {
    icon: 'googlesheets',
    category: 'docs',
    blurb: { ru: 'Чтение и запись ячеек, новые строки.', en: 'Read and write cells, append rows.' },
  },
  clickup: {
    icon: 'clickup',
    category: 'tasks',
    blurb: { ru: 'Ваши задачи, списки, статусы.', en: 'Your tasks, lists and statuses.' },
  },
  gitlab: {
    icon: 'gitlab',
    category: 'dev',
    blurb: { ru: 'Задачи и merge request’ы.', en: 'Issues and merge requests.' },
  },
  calendly: {
    icon: 'calendly',
    category: 'calendar',
    blurb: { ru: 'Записи на встречи и ссылки для записи.', en: 'Booked meetings and booking links.' },
  },
  zendesk: {
    icon: 'zendesk',
    category: 'crm',
    blurb: { ru: 'Тикеты, ответы клиентам, заметки.', en: 'Tickets, customer replies, notes.' },
  },
  intercom: {
    icon: 'intercom',
    category: 'crm',
    blurb: { ru: 'Разговоры с клиентами и контакты.', en: 'Customer conversations and contacts.' },
  },
  pipedrive: {
    glyph: 'users',
    category: 'crm',
    blurb: { ru: 'Сделки, люди и организации.', en: 'Deals, people and organizations.' },
  },
  freshdesk: {
    glyph: 'users',
    category: 'crm',
    blurb: { ru: 'Тикеты, ответы клиентам, заметки.', en: 'Tickets, customer replies, notes.' },
  },
  mailchimp: {
    icon: 'mailchimp',
    category: 'crm',
    blurb: { ru: 'Подписчики, теги, отчёты рассылок.', en: 'Subscribers, tags, campaign reports.' },
  },
  monday: {
    glyph: 'grid',
    category: 'tasks',
    blurb: { ru: 'Доски, элементы, статусы и апдейты.', en: 'Boards, items, statuses and updates.' },
  },
  sentry: {
    icon: 'sentry',
    category: 'dev',
    blurb: { ru: 'Ошибки, стек вызовов, решение проблем.', en: 'Errors, stack traces, resolving issues.' },
  },
  figma: {
    icon: 'figma',
    category: 'docs',
    blurb: { ru: 'Файлы, фреймы, экспорт, комментарии.', en: 'Files, frames, exports, comments.' },
  },
  typeform: {
    icon: 'typeform',
    category: 'docs',
    blurb: { ru: 'Формы и ответы на них.', en: 'Forms and their responses.' },
  },
  wordpress: {
    icon: 'wordpress',
    category: 'docs',
    blurb: { ru: 'Записи, черновики, публикация, комментарии.', en: 'Posts, drafts, publishing, comments.' },
  },
  vercel: {
    icon: 'vercel',
    category: 'dev',
    blurb: { ru: 'Деплои, логи сборки, домены.', en: 'Deployments, build logs, domains.' },
  },
  cloudflare: {
    icon: 'cloudflare',
    category: 'dev',
    blurb: { ru: 'DNS-записи и сброс кэша.', en: 'DNS records and cache purges.' },
  },
  bitbucket: {
    icon: 'bitbucket',
    category: 'dev',
    blurb: { ru: 'Pull request’ы, ревью и пайплайны.', en: 'Pull requests, reviews and pipelines.' },
  },
  brevo: {
    icon: 'brevo',
    category: 'crm',
    blurb: { ru: 'Контакты, списки, рассылки, письма.', en: 'Contacts, lists, campaigns, emails.' },
  },
  calcom: {
    icon: 'caldotcom',
    category: 'calendar',
    blurb: { ru: 'Записи на встречи и типы встреч.', en: 'Bookings and event types.' },
  },
  webflow: {
    icon: 'webflow',
    category: 'docs',
    blurb: { ru: 'CMS: черновики, правка, публикация.', en: 'CMS: drafts, edits, publishing.' },
  },
  http: {
    glyph: 'braces',
    category: 'custom',
    blurb: {
      ru: 'Любой REST/JSON API по адресу и ключу, без кода.',
      en: 'Any REST/JSON API by its address and key, no code.',
    },
  },
  manyplug: {
    glyph: 'settings',
    category: 'other',
    blurb: { ru: 'Настройка хаба прямо из чата.', en: 'Set up the hub from the chat.' },
  },
};

/** Services in the works, shown as "soon" on the website (they are not connectable yet). */
export const PLANNED_SERVICES: {
  name: string;
  icon?: string;
  glyph?: IconName;
  category: ServiceCategory;
}[] = [
  { name: 'Shopify', icon: 'shopify', category: 'payments' },
  { name: 'Dropbox', icon: 'dropbox', category: 'files' },
  { name: 'Discord', icon: 'discord', category: 'messengers' },
];

/** Hidden from public listings (test connector, the hub's own setup tools). */
export const HIDDEN_SERVICES = new Set(['demo', BRAND.slug, ...LEGACY_SLUGS]);

export function serviceMeta(id: string): ServiceMeta | undefined {
  return SERVICE_META[id];
}

/**
 * The other way in for a service that cannot be connected here yet (see `ServiceMeta.alternative`):
 * the alternative's name and the connect link that starts it with the preset values.
 */
export function serviceAlternative(
  id: string,
  connectors: readonly ConnectorDefinition[],
  lang: UiLanguage,
): { service: string; url: string } | undefined {
  const alternative = serviceMeta(id)?.alternative;
  const connector = alternative && connectors.find((c) => c.id === alternative.connectorId);
  if (!alternative || !connector) return undefined;
  const query = new URLSearchParams(alternative.values ?? {}).toString();
  return {
    service: connectorText(connector, lang).name,
    url: `/connect/${encodeURIComponent(connector.id)}${query ? `?${query}` : ''}`,
  };
}

/** Everyday words people search a category by, in both languages ("почта" finds Gmail). */
const CATEGORY_WORDS: Record<ServiceCategory, string> = {
  mail: 'почта письма ящик mail email inbox',
  messengers: 'мессенджер чат сообщения messenger chat messages',
  calendar: 'календарь встречи события calendar meetings events',
  files: 'файлы диск документы files drive storage',
  docs: 'документы заметки база знаний docs notes wiki',
  tasks: 'задачи дела проекты tasks todo projects',
  dev: 'код репозиторий разработка code repository dev',
  payments: 'платежи оплата счета payments billing invoices',
  crm: 'клиенты сделки продажи crm customers deals sales',
  custom: 'свой api сервер custom server',
  other: '',
};

/** Text a service is found by in the search boxes: name, id, description and category words. */
export function searchText(id: string, name: string, description: string): string {
  const meta = serviceMeta(id);
  return `${name} ${id} ${description} ${CATEGORY_WORDS[meta?.category ?? 'other']}`;
}
