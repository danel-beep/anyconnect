/**
 * Outgoing email from the hub itself (billing notices, later other account mail). One provider is
 * active at a time (`MAIL_PROVIDER`); without one the hub sends nothing and features that need
 * email simply skip it. Add a provider by implementing `Mailer` and listing it in `createMailer`.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** What kind of mail this is (`billing.trial_ending`...), for provider analytics and logs. */
  tag: string;
}

export interface Mailer {
  readonly id: string;
  send(message: MailMessage): Promise<void>;
}

export class MailError extends Error {}

export type MailProviderId = 'log' | 'resend';

export interface MailConfig {
  /** Undefined = no email. */
  provider: MailProviderId | undefined;
  /** `Name <address>` the mail comes from. */
  from: string;
  resend?: { apiKey: string };
}

export class MailConfigError extends Error {}

export function readMailConfig(source: NodeJS.ProcessEnv, defaults: { from: string }): MailConfig {
  const get = (name: string) => source[name]?.trim() || undefined;
  const raw = (get('MAIL_PROVIDER') ?? 'none').toLowerCase();
  const from = get('MAIL_FROM') ?? defaults.from;
  if (raw === 'none') return { provider: undefined, from };
  if (raw === 'log') return { provider: 'log', from };
  if (raw === 'resend') {
    const apiKey = get('RESEND_API_KEY');
    if (!apiKey) throw new MailConfigError('MAIL_PROVIDER=resend needs RESEND_API_KEY');
    return { provider: 'resend', from, resend: { apiKey } };
  }
  throw new MailConfigError('MAIL_PROVIDER must be one of none, log, resend');
}

/** Development: writes the kind and subject of each mail to the log (never the body or address). */
export class LogMailer implements Mailer {
  readonly id = 'log';
  constructor(private readonly log: (fields: Record<string, unknown>, msg: string) => void) {}
  async send(message: MailMessage): Promise<void> {
    this.log({ tag: message.tag, subject: message.subject }, 'mail (not sent: MAIL_PROVIDER=log)');
  }
}

/** Tests: keeps every message. */
export class MemoryMailer implements Mailer {
  readonly id = 'memory';
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** https://resend.com: one HTTPS call per message. */
export class ResendMailer implements Mailer {
  readonly id = 'resend';
  constructor(private readonly options: { apiKey: string; from: string; fetch?: typeof globalThis.fetch }) {}

  async send(message: MailMessage): Promise<void> {
    const response = await (this.options.fetch ?? fetch)('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.options.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        tags: [{ name: 'kind', value: message.tag.replace(/[^a-zA-Z0-9_-]/g, '_') }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new MailError(`Resend answered ${response.status}`);
  }
}

export function createMailer(
  config: MailConfig,
  deps: { log: (fields: Record<string, unknown>, msg: string) => void; fetch?: typeof globalThis.fetch },
): Mailer | undefined {
  switch (config.provider) {
    case 'log':
      return new LogMailer(deps.log);
    case 'resend':
      return new ResendMailer({
        apiKey: config.resend!.apiKey,
        from: config.from,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
    default:
      return undefined;
  }
}
