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
  { name: 'Telegram', icon: 'telegram', category: 'messengers' },
  { name: 'WhatsApp', icon: 'whatsapp', category: 'messengers' },
  { name: 'Jira', icon: 'jira', category: 'tasks' },
  { name: 'Linear', icon: 'linear', category: 'tasks' },
  { name: 'Trello', icon: 'trello', category: 'tasks' },
  { name: 'Airtable', icon: 'airtable', category: 'docs' },
  { name: 'HubSpot', icon: 'hubspot', category: 'crm' },
  { name: 'Zendesk', icon: 'zendesk', category: 'crm' },
  { name: 'Intercom', icon: 'intercom', category: 'crm' },
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
