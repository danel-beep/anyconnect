import { describe, expect, it } from 'vitest';
import { ResendMailer, readMailConfig } from '../src/mail/mailer.js';
import { composeEmail } from '../src/web/emails.js';

describe('mail', () => {
  it('reads the provider and refuses a missing key', () => {
    expect(readMailConfig({}, { from: 'X <a@b.c>' })).toEqual({ provider: undefined, from: 'X <a@b.c>' });
    expect(readMailConfig({ MAIL_PROVIDER: 'log', MAIL_FROM: 'Y <y@z.w>' }, { from: 'X' }).from).toBe(
      'Y <y@z.w>',
    );
    expect(() => readMailConfig({ MAIL_PROVIDER: 'resend' }, { from: 'X' })).toThrow(/RESEND_API_KEY/);
    expect(() => readMailConfig({ MAIL_PROVIDER: 'smtp' }, { from: 'X' })).toThrow();
  });

  it('sends through Resend', async () => {
    const calls: { url: string; auth: string; body: any }[] = [];
    const mailer = new ResendMailer({
      apiKey: 're_test',
      from: 'Manyplug <hello@manyplug.com>',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({
          url,
          auth: new Headers(init.headers).get('authorization')!,
          body: JSON.parse(String(init.body)),
        });
        return new Response('{"id":"1"}', { status: 200 });
      }) as typeof fetch,
    });
    await mailer.send({
      to: 'ann@example.com',
      subject: 'Hi',
      text: 't',
      html: '<p>t</p>',
      tag: 'billing.x',
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.resend.com/emails',
      auth: 'Bearer re_test',
      body: {
        to: ['ann@example.com'],
        from: 'Manyplug <hello@manyplug.com>',
        tags: [{ value: 'billing_x' }],
      },
    });
    const failing = new ResendMailer({
      apiKey: 'k',
      from: 'f',
      fetch: (async () => new Response('no', { status: 422 })) as unknown as typeof fetch,
    });
    await expect(failing.send({ to: 'a', subject: 's', text: 't', html: 'h', tag: 'x' })).rejects.toThrow(
      /422/,
    );
  });

  it('renders the email in the recipient language and escapes values', () => {
    const mail = composeEmail(
      { email: 'ann@example.com', name: '<b>Ann</b> Lee', locale: 'en' },
      {
        tag: 'billing.limit_reached',
        subject: 'email.limitReached.subject',
        paragraphs: ['email.limitReached.body'],
        cta: { label: 'email.limitReached.cta', url: 'https://hub.example/app/billing?a=1&b=2' },
        vars: { limit: 150 },
        dates: { date: new Date('2026-12-01T00:00:00Z') },
        plan: 'free',
      },
      { billingUrl: 'https://hub.example/app/billing' },
    );
    expect(mail.subject).toBe('You have used all 150 Manyplug actions this month');
    expect(mail.text).toContain('December 1, 2026');
    expect(mail.html).toContain('&lt;b&gt;Ann&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>Ann');
    expect(mail.html).toContain('href="https://hub.example/app/billing?a=1&amp;b=2"');
    const ru = composeEmail(
      { email: 'a', name: null, locale: 'ru' },
      {
        tag: 't',
        subject: 'email.trialEnding.subject',
        paragraphs: [],
        cta: { label: 'email.trialEnding.cta', url: 'u' },
        vars: { n: 2 },
      },
      { billingUrl: 'u' },
    );
    expect(ru.subject).toBe('Пробный период Pro в Manyplug закончится через 2 дня');
    expect(ru.text.startsWith('Здравствуйте!')).toBe(true);
  });
});
