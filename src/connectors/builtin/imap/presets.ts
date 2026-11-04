/**
 * Server settings of popular mail providers, so that connecting a mailbox only needs the address
 * and an app password. `custom` means the user enters the servers by hand.
 */

export type Security = 'tls' | 'starttls';

export interface ServerSettings {
  host: string;
  port: number;
  security: Security;
}

export interface ProviderPreset {
  label: string;
  imap: ServerSettings;
  smtp: ServerSettings;
  /**
   * Whether the provider stores a copy of mail sent over SMTP in the Sent folder by itself.
   * When it does not, the connector appends the copy over IMAP.
   */
  savesSentCopy: boolean;
  /** Where the user creates the app password; shown in the account form. */
  appPasswordHelp?: string;
  /** Address domains of the provider: the provider is guessed from them when the user leaves it empty. */
  domains: readonly string[];
}

export const PROVIDERS = {
  gmail: {
    label: 'Gmail / Google Workspace',
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    savesSentCopy: true,
    appPasswordHelp: 'https://myaccount.google.com/apppasswords',
    domains: ['gmail.com', 'googlemail.com'],
  },
  outlook: {
    label: 'Outlook.com / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    savesSentCopy: true,
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
  },
  icloud: {
    label: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    savesSentCopy: false,
    appPasswordHelp: 'https://account.apple.com/account/manage',
    domains: ['icloud.com', 'me.com', 'mac.com'],
  },
  fastmail: {
    label: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
    savesSentCopy: false,
    appPasswordHelp: 'https://app.fastmail.com/settings/security/apps',
    domains: ['fastmail.com', 'fastmail.fm'],
  },
  yandex: {
    label: 'Yandex Mail',
    imap: { host: 'imap.yandex.ru', port: 993, security: 'tls' },
    smtp: { host: 'smtp.yandex.ru', port: 465, security: 'tls' },
    savesSentCopy: false,
    appPasswordHelp: 'https://id.yandex.ru/security/app-passwords',
    domains: ['yandex.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'yandex.ua', 'ya.ru', 'narod.ru'],
  },
  mailru: {
    label: 'Mail.ru',
    imap: { host: 'imap.mail.ru', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.ru', port: 465, security: 'tls' },
    savesSentCopy: false,
    appPasswordHelp: 'https://account.mail.ru/user/2-step-auth/passwords',
    domains: ['mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'internet.ru'],
  },
} as const satisfies Record<string, ProviderPreset>;

export type ProviderId = keyof typeof PROVIDERS | 'custom';
export const PROVIDER_IDS = [...(Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]), 'custom'] as const;

/** Guess the provider from the address (used as the default when the user leaves it empty). */
export function guessProvider(email: string): ProviderId {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  const found = (Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]).find((id) =>
    (PROVIDERS[id].domains as readonly string[]).includes(domain),
  );
  return found ?? 'custom';
}

/** Address domains per provider, for the connect form to pick the right setup steps as the user types. */
export const PROVIDER_DOMAINS: Record<string, string[]> = Object.fromEntries(
  Object.entries(PROVIDERS).map(([id, preset]) => [id, [...preset.domains]]),
);
