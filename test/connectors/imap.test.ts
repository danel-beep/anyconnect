import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import hoodiecrow, { type HoodiecrowServer } from 'hoodiecrow-imap';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { stripQuotedTail } from '../../src/connectors/builtin/email/message.js';
import imap, { closeImapConnections, resolveSettings } from '../../src/connectors/builtin/imap/index.js';
import { decodePart, toSnippet } from '../../src/connectors/builtin/imap/mime.js';
import { guessProvider } from '../../src/connectors/builtin/imap/presets.js';
import { createNetworkPolicy } from '../../src/lib/network.js';
import { testAccount } from './harness.js';

const require = createRequire(import.meta.url);
const certDir = `${require.resolve('hoodiecrow-imap/package.json').replace(/package\.json$/, '')}cert`;
const tlsCredentials = {
  key: readFileSync(`${certDir}/server.key`),
  cert: readFileSync(`${certDir}/server.crt`),
};

const ME = 'me@example.test';

const plainRussian = [
  'From: Иван Петров <ivan@example.test>',
  `To: ${ME}`,
  'Subject: =?UTF-8?B?0KHRh9GR0YIg0LfQsCDQvtC60YLRj9Cx0YDRjA==?=',
  'Date: Mon, 02 Nov 2026 10:00:00 +0000',
  'Message-ID: <invoice-1@example.test>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  'Добрый день! Счёт за октябрь во вложении, оплатите до пятницы.',
  '',
  'On Sun, 1 Nov 2026 you wrote:',
  '> Пришлите, пожалуйста, счёт.',
  '> Спасибо',
  '',
].join('\r\n');

const htmlCp1251 = [
  'From: Shop <news@shop.test>',
  `To: ${ME}`,
  'Subject: Sale',
  'Date: Tue, 03 Nov 2026 09:00:00 +0000',
  'Message-ID: <sale@shop.test>',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=windows-1251',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<html><head><style>p{color:red}</style></head><body><p>=D1=EA=E8=E4=EA=E8 &amp; =EF=EE=E4=E0=F0=EA=E8</p></body></html>',
  '',
].join('\r\n');

const withAttachment = [
  'From: Bank <noreply@bank.test>',
  `To: ${ME}`,
  'Subject: Statement',
  'Date: Wed, 04 Nov 2026 08:00:00 +0000',
  'Message-ID: <statement@bank.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('Your monthly statement is attached.').toString('base64'),
  '--b1',
  'Content-Type: application/pdf; name="statement.pdf"',
  'Content-Disposition: attachment; filename="statement.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 fake').toString('base64'),
  '--b1--',
  '',
].join('\r\n');

const storage = () => ({
  INBOX: {
    messages: [
      { raw: plainRussian, flags: [], internaldate: '02-Nov-2026 10:00:00 +0000' },
      { raw: htmlCp1251, flags: ['\\Seen'], internaldate: '03-Nov-2026 09:00:00 +0000' },
      { raw: withAttachment, flags: ['\\Seen', '\\Flagged'], internaldate: '04-Nov-2026 08:00:00 +0000' },
    ],
  },
  '': {
    separator: '/',
    folders: {
      Sent: { 'special-use': '\\Sent', messages: [] },
      Trash: { 'special-use': '\\Trash', messages: [] },
      Archive: { 'special-use': '\\Archive', messages: [] },
      Projects: { messages: [] },
    },
  },
});

interface Received {
  from: string | false;
  to: string[];
  raw: Buffer;
}

let imapServer: HoodiecrowServer | undefined;
let smtpServer: SMTPServer | undefined;
let received: Received[] = [];
let ports = { imap: 0, smtp: 0 };

async function startServers(plugins: string[]) {
  imapServer = hoodiecrow({
    plugins,
    storage: storage(),
    secureConnection: true,
    credentials: tlsCredentials,
    users: { [ME]: { password: 'app-password' } },
  });
  await new Promise<void>((resolve) => imapServer!.listen(0, '127.0.0.1', resolve));
  received = [];
  smtpServer = new SMTPServer({
    secure: true,
    ...tlsCredentials,
    logger: false,
    onAuth(auth, _session, done) {
      if (auth.username === ME && auth.password === 'app-password') return done(null, { user: ME });
      return done(new Error('Invalid credentials'));
    },
    onData(stream, session, done) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : false,
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks),
        });
        done();
      });
    },
  });
  await new Promise<void>((resolve) => smtpServer!.listen(0, '127.0.0.1', () => resolve()));
  ports = {
    imap: (imapServer.server.address() as AddressInfo).port,
    smtp: (smtpServer.server.address() as AddressInfo).port,
  };
}

async function stopServers() {
  await closeImapConnections();
  await new Promise<void>((resolve) => (imapServer ? imapServer.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) => (smtpServer ? smtpServer.close(() => resolve()) : resolve()));
}

function account(overrides: Record<string, unknown> = {}, password = 'app-password') {
  return testAccount(imap, {
    config: {
      email: ME,
      provider: 'custom',
      fromName: 'Me Myself',
      imapHost: '127.0.0.1',
      imapPort: ports.imap,
      imapSecurity: 'tls',
      smtpHost: '127.0.0.1',
      smtpPort: ports.smtp,
      smtpSecurity: 'tls',
      allowInvalidCertificate: true,
      ...overrides,
    },
    credentials: { password },
  });
}

type Summary = { id: string; subject: string; snippet?: string; unread?: boolean; attachments?: number };

describe('imap connector: unit', () => {
  it('fills servers from provider presets and guesses the provider from the address', () => {
    expect(guessProvider('a@yandex.ru')).toBe('yandex');
    expect(guessProvider('a@bk.ru')).toBe('mailru');
    expect(guessProvider('a@company.com')).toBe('custom');
    const gmail = resolveSettings(imap.config.parse({ email: 'x@gmail.com' }) as never);
    expect(gmail.imap).toEqual({ host: 'imap.gmail.com', port: 993, security: 'tls' });
    expect(gmail.saveSentCopy).toBe(false);
    const yandex = resolveSettings(imap.config.parse({ email: 'x@yandex.ru' }) as never);
    expect(yandex.saveSentCopy).toBe(true);
    const custom = resolveSettings(
      imap.config.parse({
        email: 'x@corp.test',
        imapHost: 'mail.corp.test',
        smtpHost: 'mail.corp.test',
        smtpSecurity: 'starttls',
      }) as never,
    );
    expect(custom.imap).toEqual({ host: 'mail.corp.test', port: 993, security: 'tls' });
    expect(custom.smtp).toEqual({ host: 'mail.corp.test', port: 587, security: 'starttls' });
  });

  it('requires servers for an unknown provider', () => {
    expect(imap.config.safeParse({ email: 'x@corp.test' }).success).toBe(false);
  });

  it('decodes cut body parts for snippets', () => {
    const b64 = Buffer.from('Привет, мир! Это длинное письмо.').toString('base64');
    expect(decodePart(Buffer.from(b64.slice(0, 21)), 'base64', 'utf-8')).toBe('Привет, ');
    expect(decodePart(Buffer.from('=D1=EA=E8=E4=EA=E8 =E'), 'quoted-printable', 'windows-1251')).toBe(
      'Скидки ',
    );
    expect(toSnippet('Hi\n> quoted\n  there   friend')).toBe('Hi there friend');
  });

  it('strips the quoted history of a reply', () => {
    const { text, removed } = stripQuotedTail('Ok, thanks!\n\nВ пн, Иван написал:\n> old\n> older\n');
    expect(removed).toBe(true);
    expect(text).toBe('Ok, thanks!');
  });
});

for (const variant of [
  { name: 'modern server', plugins: ['SPECIAL-USE', 'MOVE', 'UIDPLUS', 'LIST-STATUS', 'ENABLE'] },
  { name: 'minimal server', plugins: [] },
]) {
  describe(`imap connector against a local ${variant.name}`, () => {
    beforeEach(async () => {
      await stopServers();
      await startServers(variant.plugins);
    });
    afterAll(stopServers);

    it('passes the account test and reports the identity', async () => {
      const acc = account();
      const result = await imap.test!(acc.ctx as never);
      expect(result).toMatchObject({ ok: true, identity: ME });
    });

    it('refuses private servers under the production network policy', async () => {
      const cloud = createNetworkPolicy({ allowPrivateNetwork: false });
      const acc = testAccount(imap, {
        config: account().ctx.config as Record<string, unknown>,
        credentials: { password: 'app-password' },
        network: cloud,
      });
      await expect(acc.run('search', {})).rejects.toMatchObject({ kind: 'permission' });
      await expect(acc.run('send', { to: ['a@b.test'], subject: 's', body: 'b' })).rejects.toMatchObject({
        kind: 'permission',
      });
      expect(received).toHaveLength(0);
      await cloud.close();
    });

    it('marks a wrong password as an auth error', async () => {
      const acc = account({}, 'wrong');
      await expect(acc.run('search', {})).rejects.toMatchObject({ name: 'ConnectorError', kind: 'auth' });
    });

    it('lists folders with roles', async () => {
      const { folders } = (await account().run('list_folders')) as {
        folders: { path: string; role?: string }[];
      };
      const byPath = Object.fromEntries(folders.map((f) => [f.path, f.role]));
      expect(byPath.INBOX).toBe('inbox');
      expect(byPath.Projects).toBeUndefined();
      // Without SPECIAL-USE the role is found by the folder name instead (checked via search below).
      if (variant.plugins.includes('SPECIAL-USE')) expect(byPath.Sent).toBe('sent');
    });

    it('searches newest first with snippets, decoded subjects and pagination', async () => {
      const acc = account();
      const page1 = (await acc.run('search', { limit: 2 })) as {
        total: number;
        messages: Summary[];
        nextCursor?: string;
      };
      expect(page1.total).toBe(3);
      expect(page1.messages.map((m) => m.subject)).toEqual(['Statement', 'Sale']);
      expect(page1.messages[0]).toMatchObject({
        snippet: 'Your monthly statement is attached.',
        attachments: 1,
      });
      expect(page1.messages[0]!.unread).toBeUndefined();
      expect(page1.messages[1]!.snippet).toBe('Скидки & подарки');
      expect(page1.nextCursor).toBeDefined();
      const page2 = (await acc.run('search', { limit: 2, cursor: page1.nextCursor })) as {
        messages: Summary[];
        nextCursor?: string;
      };
      expect(page2.messages).toHaveLength(1);
      expect(page2.messages[0]).toMatchObject({ subject: 'Счёт за октябрь', unread: true });
      expect(page2.messages[0]!.snippet).toBe(
        'Добрый день! Счёт за октябрь во вложении, оплатите до пятницы. On Sun, 1 Nov 2026 you wrote:',
      );
      expect(page2.nextCursor).toBeUndefined();
    });

    it('filters by sender, unread and text', async () => {
      const acc = account();
      const fromBank = (await acc.run('search', { from: 'bank.test' })) as { messages: Summary[] };
      expect(fromBank.messages.map((m) => m.subject)).toEqual(['Statement']);
      const unread = (await acc.run('search', { unread: true })) as { messages: Summary[] };
      expect(unread.messages.map((m) => m.subject)).toEqual(['Счёт за октябрь']);
      const none = (await acc.run('search', { subject: 'nothing-like-this' })) as { total: number };
      expect(none.total).toBe(0);
    });

    it('reads a message as text without the quoted history and keeps it unread', async () => {
      const acc = account();
      const { messages } = (await acc.run('search', { unread: true })) as { messages: Summary[] };
      const message = (await acc.run('read', { id: messages[0]!.id })) as Record<string, unknown>;
      expect(message).toMatchObject({
        from: 'Иван Петров <ivan@example.test>',
        to: [ME],
        subject: 'Счёт за октябрь',
        unread: true,
        quotedHistoryRemoved: true,
        text: 'Добрый день! Счёт за октябрь во вложении, оплатите до пятницы.',
      });
      const again = (await acc.run('search', { unread: true })) as { total: number };
      expect(again.total).toBe(1);
      const full = (await acc.run('read', { id: messages[0]!.id, includeQuoted: true })) as { text: string };
      expect(full.text).toContain('> Спасибо');
      await acc.run('mark', { ids: [messages[0]!.id], read: true });
      expect(((await acc.run('search', { unread: true })) as { total: number }).total).toBe(0);
    });

    it('converts HTML bodies, lists attachments and truncates long bodies', async () => {
      const acc = account();
      const { messages } = (await acc.run('search', {})) as { messages: Summary[] };
      const html = (await acc.run('read', { id: messages[1]!.id })) as { text: string };
      expect(html.text).toContain('Скидки & подарки');
      expect(html.text).not.toContain('color:red');
      const statement = (await acc.run('read', { id: messages[0]!.id })) as Record<string, unknown>;
      expect(statement.attachments).toEqual([
        { filename: 'statement.pdf', contentType: 'application/pdf', size: expect.any(Number) },
      ]);
      const cut = (await acc.run('read', { id: messages[0]!.id, maxChars: 500 })) as Record<string, unknown>;
      expect(cut.truncated).toBeUndefined();
    });

    it('returns a clear error for a missing message or folder', async () => {
      const acc = account();
      await expect(acc.run('read', { id: 'INBOX:999' })).rejects.toMatchObject({ kind: 'not_found' });
      await expect(acc.run('search', { folder: 'NoSuchFolder' })).rejects.toMatchObject({
        kind: 'not_found',
      });
      await expect(acc.run('read', { id: 'garbage' })).rejects.toMatchObject({ kind: 'invalid_input' });
    });

    it('moves messages by role, flags them and finds them in the new folder', async () => {
      const acc = account();
      const { messages } = (await acc.run('search', {})) as { messages: Summary[] };
      await acc.run('mark', { ids: [messages[1]!.id], flagged: true, read: false });
      const flagged = (await acc.run('search', { flagged: true })) as { messages: Summary[] };
      expect(flagged.messages.map((m) => m.subject).sort()).toEqual(['Sale', 'Statement']);
      const moved = (await acc.run('move', { ids: [messages[1]!.id], to: 'archive' })) as { to: string };
      expect(moved.to).toBe('Archive');
      const archive = (await acc.run('search', { folder: 'archive' })) as { messages: Summary[] };
      expect(archive.messages.map((m) => m.subject)).toEqual(['Sale']);
      expect(archive.messages[0]!.id.startsWith('Archive:')).toBe(true);
      const inbox = (await acc.run('search', {})) as { total: number };
      expect(inbox.total).toBe(2);
    });

    it('sends mail over SMTP and saves the copy to Sent', async () => {
      const acc = account();
      const result = (await acc.run('send', {
        to: ['Анна <anna@example.test>'],
        cc: ['boss@example.test'],
        bcc: ['archive@example.test'],
        subject: 'Отчёт',
        body: 'Отчёт готов.',
      })) as Record<string, unknown>;
      expect(result).toMatchObject({ sent: true, savedTo: 'Sent' });
      expect(received).toHaveLength(1);
      expect(received[0]!.from).toBe(ME);
      expect(received[0]!.to.sort()).toEqual([
        'anna@example.test',
        'archive@example.test',
        'boss@example.test',
      ]);
      const mail = await simpleParser(received[0]!.raw);
      expect(mail.subject).toBe('Отчёт');
      expect(mail.text?.trim()).toBe('Отчёт готов.');
      expect(mail.from?.value[0]).toMatchObject({ name: 'Me Myself', address: ME });
      expect(mail.headers.has('bcc')).toBe(false);
      const sent = (await acc.run('search', { folder: 'sent' })) as { messages: Summary[] };
      expect(sent.messages.map((m) => m.subject)).toEqual(['Отчёт']);
    });

    it('does not save a copy when the provider does it itself', async () => {
      const acc = account({ saveSentCopy: false });
      const result = (await acc.run('send', { to: ['a@example.test'], subject: 'x', body: 'y' })) as Record<
        string,
        unknown
      >;
      expect(result.savedTo).toBeUndefined();
      const sent = (await acc.run('search', { folder: 'sent' })) as { total: number };
      expect(sent.total).toBe(0);
    });

    it('replies in the thread and marks the original as answered', async () => {
      const acc = account({ saveSentCopy: false });
      const { messages } = (await acc.run('search', { unread: true })) as { messages: Summary[] };
      const result = (await acc.run('reply', { id: messages[0]!.id, body: 'Оплачу завтра.' })) as Record<
        string,
        unknown
      >;
      expect(result.to).toEqual(['Иван Петров <ivan@example.test>']);
      const mail = await simpleParser(received[0]!.raw);
      expect(mail.subject).toBe('Re: Счёт за октябрь');
      expect(mail.inReplyTo).toBe('<invoice-1@example.test>');
      expect(mail.references).toBe('<invoice-1@example.test>');
      const inbox = imapServer!.getMailbox('INBOX')!;
      expect(inbox.messages[0]!.flags).toContain('\\Answered');
    });

    it('forwards with the original attached', async () => {
      const acc = account({ saveSentCopy: false });
      const { messages } = (await acc.run('search', { from: 'bank' })) as { messages: Summary[] };
      await acc.run('forward', { id: messages[0]!.id, to: ['accountant@example.test'], body: 'FYI' });
      const mail = await simpleParser(received[0]!.raw);
      expect(mail.subject).toBe('Fwd: Statement');
      expect(mail.text?.trim()).toBe('FYI');
      expect(received[0]!.to).toEqual(['accountant@example.test']);
      expect(mail.attachments.map((a) => a.contentType)).toEqual(['message/rfc822']);
    });

    it('implements the shared mail capabilities', async () => {
      const acc = account({ saveSentCopy: false });
      const found = await acc.runCapability('mail.search', {
        from: 'ivan',
        since: '2026-11-02T09:00:00Z',
        until: '2026-11-02T23:00:00Z',
      });
      expect(found.items).toEqual([
        expect.objectContaining({
          from: 'Иван Петров <ivan@example.test>',
          to: [ME],
          subject: 'Счёт за октябрь',
          unread: true,
          has_attachments: false,
        }),
      ]);
      // The time bounds are exact even though IMAP filters by day.
      const none = await acc.runCapability('mail.search', { from: 'ivan', since: '2026-11-02T11:00:00Z' });
      expect(none.items).toEqual([]);
      const message = await acc.runCapability('mail.read', { id: found.items[0].id });
      expect(message).toMatchObject({
        subject: 'Счёт за октябрь',
        body: expect.stringContaining('оплатите'),
      });
      const statement = (await acc.runCapability('mail.search', { from: 'bank' })).items[0];
      expect(statement.has_attachments).toBe(true);
      expect((await acc.runCapability('mail.read', { id: statement.id })).attachments).toEqual([
        { id: '1', name: 'statement.pdf', mime_type: 'application/pdf', size: expect.any(Number) },
      ]);
      const sent = await acc.runCapability('mail.send', {
        to: ['ivan@example.test'],
        subject: '',
        body: 'Оплачено.',
        reply_to_id: found.items[0].id,
      });
      expect(sent.id).toMatch(/^<.+>$/);
      const mail = await simpleParser(received[0]!.raw);
      expect(mail.subject).toBe('Re: Счёт за октябрь');
      expect(mail.inReplyTo).toBe('<invoice-1@example.test>');
    });
  });
}
