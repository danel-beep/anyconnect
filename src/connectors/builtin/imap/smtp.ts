import net from 'node:net';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { ConnectorError } from '../../sdk.js';
import { type ResolveHost, toConnectorError, unreachableHost } from './connection.js';
import type { ServerSettings } from './presets.js';

export interface SmtpLogin {
  server: ServerSettings;
  user: string;
  password: string;
  allowInvalidCertificate?: boolean;
}

/** Builds the raw RFC 5322 message once, so the very same bytes are sent and saved to Sent. */
export async function composeMessage(mail: Mail.Options): Promise<Buffer> {
  return new MailComposer(mail).compile().build();
}

export async function sendRaw(
  login: SmtpLogin,
  resolveHost: ResolveHost,
  envelope: { from: string; to: string[] },
  raw: Buffer,
): Promise<{ messageId?: string; accepted: string[]; rejected: string[] }> {
  const { host, port, security } = login.server;
  let address: string;
  try {
    address = await resolveHost(host);
  } catch (error) {
    throw unreachableHost('SMTP', host, error);
  }
  const transport = nodemailer.createTransport({
    host: address,
    port,
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    auth: { user: login.user, pass: login.password },
    tls: {
      rejectUnauthorized: !login.allowInvalidCertificate,
      ...(net.isIP(host) ? {} : { servername: host }),
    },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
  });
  try {
    const info = await transport.sendMail({ envelope, raw });
    const asStrings = (list: unknown[] | undefined) =>
      (list ?? []).map((a) => (typeof a === 'string' ? a : ((a as { address?: string }).address ?? '')));
    return {
      ...(info.messageId ? { messageId: info.messageId } : {}),
      accepted: asStrings(info.accepted),
      rejected: asStrings(info.rejected),
    };
  } catch (error) {
    const e = error as { responseCode?: number; code?: string; response?: string };
    if (e.responseCode && e.responseCode >= 500 && e.code === 'EENVELOPE') {
      throw new ConnectorError('invalid_input', `SMTP rejected a recipient: ${e.response ?? ''}`.trim(), {
        cause: error,
      });
    }
    throw toConnectorError(error, 'SMTP');
  } finally {
    transport.close();
  }
}
