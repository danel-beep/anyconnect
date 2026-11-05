import { BRAND } from '../brand.js';
import type { MailMessage } from '../mail/mailer.js';
import { type Key, type Locale, translator } from './i18n.js';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One of the hub's emails: a greeting, a few short paragraphs and one button. */
export interface EmailContent {
  tag: string;
  subject: Key;
  paragraphs: Key[];
  cta: { label: Key; url: string };
  vars: Record<string, string | number>;
  /** Dates written in the recipient's language (`{name}` in the texts). */
  dates?: Record<string, Date>;
  /** A plan id whose localized name fills `{plan}`. */
  plan?: string;
}

/**
 * Renders an email in the recipient's language as plain text and simple inline-styled HTML (mail
 * clients ignore stylesheets). Every value is escaped; links are only the hub's own URLs.
 */
export function composeEmail(
  to: { email: string; name: string | null; locale: Locale },
  content: EmailContent,
  opts: { billingUrl: string },
): MailMessage {
  const t = translator(to.locale);
  const vars: Record<string, string | number> = { brand: BRAND.name, ...content.vars };
  for (const [key, date] of Object.entries(content.dates ?? {})) {
    vars[key] = date.toLocaleDateString(to.locale === 'ru' ? 'ru-RU' : 'en-US', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }
  if (content.plan) vars.plan = t(`plan.${content.plan}.name` as Key);
  const name = to.name?.trim().split(/\s+/)[0];
  const hello = t('email.hello', { name: name ? ` ${name}` : '' });
  const paragraphs = content.paragraphs.map((key) => t(key, vars));
  const cta = t(content.cta.label, vars);
  const signoff = t('email.signoff', vars);
  const footer = t('email.footer', { ...vars, url: opts.billingUrl });
  const text = [hello, ...paragraphs, `${cta}: ${content.cta.url}`, signoff, '', footer].join('\n\n');
  const p = (s: string) => `<p style="margin:0 0 16px;line-height:1.5">${esc(s)}</p>`;
  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">',
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">',
    `<p style="margin:0 0 20px;font-weight:700;font-size:18px;color:#f97316">${esc(BRAND.name)}</p>`,
    p(hello),
    ...paragraphs.map(p),
    `<p style="margin:24px 0"><a href="${esc(content.cta.url)}" style="display:inline-block;background:#f97316;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${esc(cta)}</a></p>`,
    p(signoff),
    `<p style="margin:24px 0 0;font-size:12px;color:#71717a;line-height:1.5">${esc(footer)}</p>`,
    '</div></body></html>',
  ].join('');
  return { to: to.email, subject: t(content.subject, vars), text, html, tag: content.tag };
}
