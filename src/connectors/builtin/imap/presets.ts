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
}

export const PROVIDERS = {
  gmail: {
    label: 'Gmail / Google Workspace',
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    savesSentCopy: true,
    appPasswordHelp: 'https://myaccount.google.com/apppasswords',
  },
  yandex: {
    label: 'Яндекс Почта',
    imap: { host: 'imap.yandex.ru', port: 993, security: 'tls' },
    smtp: { host: 'smtp.yandex.ru', port: 465, security: 'tls' },
    savesSentCopy: false,
    appPasswordHelp: 'https://id.yandex.ru/security/app-passwords',
  },
  mailru: {
    label: 'Mail.ru',
    imap: { host: 'imap.mail.ru', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.ru', port: 465, security: 'tls' },
    savesSentCopy: false,
    appPasswordHelp: 'https://account.mail.ru/user/2-step-auth/passwords',
  },
  icloud: {
    label: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    savesSentCopy: false,
    appPasswordHelp: 'https://account.apple.com/account/manage',
  },
  outlook: {
    label: 'Outlook.com / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    savesSentCopy: true,
  },
  fastmail: {
    label: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
    savesSentCopy: false,
    appPasswordHelp: 'https://app.fastmail.com/settings/security/apps',
  },
} as const satisfies Record<string, ProviderPreset>;

export type ProviderId = keyof typeof PROVIDERS | 'custom';
export const PROVIDER_IDS = [...(Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]), 'custom'] as const;

/** Guess the provider from the address (used as the default when the user leaves it empty). */
export function guessProvider(email: string): ProviderId {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (['gmail.com', 'googlemail.com'].includes(domain)) return 'gmail';
  if (/^(yandex\.(ru|com|by|kz|ua)|ya\.ru|narod\.ru)$/.test(domain)) return 'yandex';
  if (['mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'internet.ru'].includes(domain)) return 'mailru';
  if (['icloud.com', 'me.com', 'mac.com'].includes(domain)) return 'icloud';
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'outlook';
  if (['fastmail.com', 'fastmail.fm'].includes(domain)) return 'fastmail';
  return 'custom';
}
