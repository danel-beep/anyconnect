import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import gmail from '../../src/connectors/builtin/gmail.js';
import { fakeRoutes, json, type RecordedRequest, testAccount } from './harness.js';

const B = '/gmail/v1/users/me';
const original = [
  'From: Ivan <ivan@example.test>',
  'To: me@gmail.com, team@example.test',
  'Cc: boss@example.test',
  'Subject: Contract',
  'Message-ID: <c1@example.test>',
  'Date: Mon, 02 Nov 2026 10:00:00 +0000',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Please sign &amp; return.</p><blockquote>old</blockquote>',
].join('\r\n');

const meta = (id: string, labels: string[]) => ({
  id,
  threadId: `t-${id}`,
  labelIds: labels,
  snippet: 'Please sign &amp; return &#39;today&#39;',
  internalDate: '1793613600000',
  payload: {
    headers: [
      { name: 'From', value: 'Ivan <ivan@example.test>' },
      { name: 'Subject', value: 'Contract' },
      { name: 'Date', value: 'Mon, 02 Nov 2026 10:00:00 +0000' },
    ],
    parts: [{ filename: '' }, { filename: 'contract.pdf' }],
  },
});

function setup() {
  const service = fakeRoutes({
    [`GET ${B}/profile`]: { emailAddress: 'me@gmail.com', messagesTotal: 10 },
    [`GET ${B}/messages`]: {
      messages: [
        { id: 'm1', threadId: 't-m1' },
        { id: 'm2', threadId: 't-m2' },
      ],
      nextPageToken: 'p2',
      resultSizeEstimate: 42,
    },
    [`GET ${B}/messages/m1`]: (req: RecordedRequest) =>
      req.url.searchParams.get('format') === 'raw'
        ? json({
            id: 'm1',
            threadId: 't-m1',
            labelIds: ['INBOX', 'UNREAD'],
            raw: Buffer.from(original).toString('base64url'),
          })
        : json(meta('m1', ['INBOX', 'UNREAD'])),
    [`GET ${B}/messages/m2`]: meta('m2', ['INBOX', 'STARRED']),
    [`POST ${B}/messages/send`]: (req: RecordedRequest) =>
      json({ id: 'sent1', threadId: JSON.parse(req.body!).threadId ?? 'new' }),
    [`GET ${B}/labels`]: {
      labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'Label_7', name: 'Clients', type: 'user' },
      ],
    },
    [`POST ${B}/messages/batchModify`]: () => new Response(null, { status: 204 }),
    [`POST ${B}/drafts`]: { id: 'd1', message: { id: 'dm1' } },
  });
  return { service, acc: testAccount(gmail, { fetch: service.fetch, oauth: { accessToken: 'ya29.token' } }) };
}

const sentRaw = async (req: RecordedRequest) =>
  simpleParser(Buffer.from(JSON.parse(req.body!).raw ?? JSON.parse(req.body!).message.raw, 'base64url'));

describe('gmail', () => {
  it('needs an OAuth connection', async () => {
    const acc = testAccount(gmail, {});
    await expect(acc.run('search', {})).rejects.toMatchObject({ kind: 'auth' });
  });

  it('searches with snippets from metadata requests', async () => {
    const { acc, service } = setup();
    expect(await gmail.test!(acc.ctx as never)).toMatchObject({ identity: 'me@gmail.com' });
    const result = (await acc.run('search', { query: 'from:ivan', limit: 2 })) as {
      messages: Record<string, unknown>[];
      nextCursor?: string;
    };
    expect(result.nextCursor).toBe('p2');
    expect(result.messages[0]).toEqual({
      id: 'm1',
      threadId: 't-m1',
      date: '2026-11-02T10:00:00Z',
      from: 'Ivan <ivan@example.test>',
      subject: 'Contract',
      snippet: "Please sign & return 'today'",
      unread: true,
      attachments: true,
    });
    expect(result.messages[1]).toMatchObject({ id: 'm2', starred: true });
    const metaCall = service.calls.find((c) => c.url.pathname.endsWith('/m2'))!;
    expect(metaCall.url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'To', 'Subject', 'Date']);
    expect(metaCall.headers.get('authorization')).toBe('Bearer ya29.token');
  });

  it('reads HTML mail as text', async () => {
    const { acc } = setup();
    const message = (await acc.run('read', { id: 'm1' })) as Record<string, unknown>;
    expect(message).toMatchObject({
      id: 'm1',
      threadId: 't-m1',
      subject: 'Contract',
      unread: true,
      from: 'Ivan <ivan@example.test>',
    });
    expect(message.text).toContain('Please sign & return.');
  });

  it('replies to all in the thread without copying yourself', async () => {
    const { acc, service } = setup();
    const result = (await acc.run('reply', { id: 'm1', body: 'Signed.', replyAll: true })) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      sent: true,
      threadId: 't-m1',
      to: ['Ivan <ivan@example.test>'],
      cc: ['team@example.test', 'boss@example.test'],
    });
    const mail = await sentRaw(service.calls.at(-1)!);
    expect(mail.subject).toBe('Re: Contract');
    expect(mail.inReplyTo).toBe('<c1@example.test>');
  });

  it('archives, marks read and labels by name in one batch', async () => {
    const { acc, service } = setup();
    await acc.run('modify', { ids: ['m1', 'm2'], read: true, archive: true, addLabels: ['clients'] });
    expect(JSON.parse(service.calls.at(-1)!.body!)).toEqual({
      ids: ['m1', 'm2'],
      addLabelIds: ['Label_7'],
      removeLabelIds: ['UNREAD', 'INBOX'],
    });
    await expect(acc.run('modify', { ids: ['m1'], addLabels: ['Nope'] })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
  });

  it('creates a reply draft in the thread', async () => {
    const { acc, service } = setup();
    expect(await acc.run('create_draft', { body: 'Draft reply', replyToId: 'm1' })).toEqual({
      draftId: 'd1',
      messageId: 'dm1',
    });
    const body = JSON.parse(service.calls.at(-1)!.body!);
    expect(body.message.threadId).toBe('t-m1');
    const mail = await sentRaw(service.calls.at(-1)!);
    expect(mail.to && !Array.isArray(mail.to) ? mail.to.text : '').toContain('ivan@example.test');
  });
});
