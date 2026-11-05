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
  | 'marketing'
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
  'marketing',
  'custom',
  'other',
];

export interface ServiceMeta {
  icon?: string;
  glyph?: IconName;
  category: ServiceCategory;
  blurb: { ru: string; en: string };
  /** Extra words people search this service by (other spellings, the other language). */
  keywords?: string;
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
    icon: 'outlook',
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
    icon: 'slack',
    glyph: 'hash',
    category: 'messengers',
    blurb: { ru: 'Каналы, поиск по сообщениям, отправка.', en: 'Channels, message search, posting.' },
  },
  telegram: {
    icon: 'telegram',
    category: 'messengers',
    blurb: {
      ru: 'Ваш бот, а с Telegram Business и личные чаты: поиск по переписке, ответы.',
      en: 'Your bot, and with Telegram Business your own chats: message search, replies.',
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
    icon: 'pipedrive',
    category: 'crm',
    blurb: { ru: 'Сделки, люди и организации.', en: 'Deals, people and organizations.' },
  },
  freshdesk: {
    icon: 'freshdesk',
    category: 'crm',
    blurb: { ru: 'Тикеты, ответы клиентам, заметки.', en: 'Tickets, customer replies, notes.' },
  },
  mailchimp: {
    icon: 'mailchimp',
    category: 'marketing',
    blurb: { ru: 'Подписчики, теги, отчёты рассылок.', en: 'Subscribers, tags, campaign reports.' },
  },
  monday: {
    icon: 'monday',
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
    category: 'marketing',
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
  zoom: {
    icon: 'zoom',
    category: 'calendar',
    blurb: { ru: 'Встречи, ссылки, переносы, записи.', en: 'Meetings, links, reschedules, recordings.' },
  },
  miro: {
    icon: 'miro',
    category: 'docs',
    blurb: { ru: 'Доски, стикеры и карточки.', en: 'Boards, stickies and cards.' },
  },
  sendgrid: {
    icon: 'sendgrid',
    category: 'marketing',
    blurb: { ru: 'Письма, шаблоны, контакты, статистика.', en: 'Emails, templates, contacts, stats.' },
  },
  smartsheet: {
    icon: 'smartsheet',
    category: 'tasks',
    blurb: { ru: 'Таблицы, строки и комментарии.', en: 'Sheets, rows and comments.' },
  },
  twilio: {
    icon: 'twilio',
    keywords: 'sms смс',
    category: 'messengers',
    blurb: { ru: 'SMS, номера и журнал звонков.', en: 'SMS, numbers and the call log.' },
  },
  postmark: {
    icon: 'postmark',
    category: 'marketing',
    blurb: { ru: 'Транзакционные письма и доставка.', en: 'Transactional email and delivery.' },
  },
  pagerduty: {
    icon: 'pagerduty',
    category: 'dev',
    blurb: { ru: 'Инциденты, заметки, дежурства.', en: 'Incidents, notes, on-call.' },
  },
  netlify: {
    icon: 'netlify',
    category: 'dev',
    blurb: { ru: 'Сайты, деплои, сборки, формы.', en: 'Sites, deploys, builds, forms.' },
  },
  harvest: {
    glyph: 'clock',
    category: 'tasks',
    blurb: { ru: 'Учёт времени, таймеры, отчёты.', en: 'Time tracking, timers, reports.' },
  },
  toggl: {
    icon: 'toggl',
    category: 'tasks',
    blurb: { ru: 'Таймеры и записи времени.', en: 'Timers and time entries.' },
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

/**
 * The services most people connect first, most common first. The dashboard shows the first few that
 * can be connected here before the full list; reorder this list to change what people see first.
 */
export const POPULAR_SERVICES: readonly string[] = [
  'gmail',
  'gcal',
  'outlook',
  'slack',
  'telegram',
  'notion',
  'gdrive',
  'github',
  'whatsapp',
  'imap',
  'todoist',
  'hubspot',
  'gsheets',
  'linear',
  'jira',
  'zoom',
  'stripe',
];

/**
 * Sample services: their accounts are test data a new hub starts with (`SEED_DEMO_ACCOUNTS`), so the
 * dashboard folds them into one row with a button that removes them all.
 */
export const SAMPLE_SERVICES: ReadonlySet<string> = new Set(['demo']);

/** What the dashboard's "Add a service" card shows: a short popular row and the full list by category. */
export interface CatalogLayout<T> {
  popular: T[];
  groups: [ServiceCategory, T[]][];
  unavailable: T[];
}

/**
 * Splits the catalog for the dashboard (pure, so it is easy to test): `popular` holds up to `limit`
 * services that can be connected now, in `POPULAR_SERVICES` order and topped up by name; `groups`
 * holds every connectable service by category in `CATEGORY_ORDER` (the user's own servers under
 * "custom"), by name; `unavailable` holds the services that cannot be connected here yet, by name.
 */
export function arrangeCatalog<T extends { service: string; name: string; ready: boolean; custom?: boolean }>(
  entries: readonly T[],
  limit = 9,
): CatalogLayout<T> {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const rank = (id: string) => {
    const i = POPULAR_SERVICES.indexOf(id);
    return i < 0 ? POPULAR_SERVICES.length : i;
  };
  const ready = entries.filter((e) => e.ready);
  const popular = [...ready]
    .sort((a, b) => rank(a.service) - rank(b.service) || byName(a, b))
    .slice(0, limit);
  const groups: [ServiceCategory, T[]][] = [];
  for (const category of CATEGORY_ORDER) {
    const inCategory = ready
      .filter((e) => (e.custom ? 'custom' : (serviceMeta(e.service)?.category ?? 'other')) === category)
      .sort(byName);
    if (inCategory.length) groups.push([category, inCategory]);
  }
  const unavailable = entries.filter((e) => !e.ready).sort(byName);
  return { popular, groups, unavailable };
}

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
  mail: 'почта письма ящик имейл mail email e-mail inbox',
  messengers: 'мессенджер чат сообщения messenger chat messages',
  calendar: 'календарь встречи события calendar meetings events',
  files: 'файлы диск документы files drive storage',
  docs: 'документы заметки база знаний docs notes wiki',
  tasks: 'задачи дела проекты tasks todo projects',
  dev: 'код репозиторий разработка баг ошибки code repository dev bug bugs',
  payments: 'платежи оплата счета payments billing invoices',
  crm: 'клиенты сделки продажи поддержка crm customers deals sales support',
  marketing: 'рассылки маркетинг письма почта newsletter marketing campaigns email e-mail',
  custom: 'свой api сервер custom server',
  other: '',
};

/**
 * Text a service is found by in the search boxes: name, id, description, its blurb in both languages
 * (people search in either) and category words.
 */
export function searchText(id: string, name: string, description: string): string {
  const meta = serviceMeta(id);
  const blurbs = meta ? `${meta.blurb.en} ${meta.blurb.ru}` : '';
  return `${name} ${id} ${description} ${blurbs} ${meta?.keywords ?? ''} ${CATEGORY_WORDS[meta?.category ?? 'other']}`;
}
