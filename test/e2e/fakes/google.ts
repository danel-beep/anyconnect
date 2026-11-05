import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { FakeInternet } from '../fake-internet.js';

/**
 * A fake Google: the sign-in page and OAuth server (accounts.google.com, oauth2.googleapis.com)
 * plus a small Gmail API (gmail.googleapis.com). It behaves like the real thing where the hub
 * depends on it: codes are single-use and bound to the client, redirect URI and PKCE challenge;
 * the client secret is checked; ID tokens carry the nonce; access tokens expire and are refreshed
 * with the refresh token; the API answers 401 to anything but a live access token.
 *
 * Gmail is just enough for the hub's connector: profile, search (a substring match over
 * from/to/subject/body), metadata and raw messages, send and labels.
 */

export interface GoogleUser {
  sub: string;
  email: string;
  name: string;
  /** Google Workspace domain (`hd` claim). */
  hd?: string;
  mailbox: GmailMessage[];
  sent: { raw: string; threadId?: string }[];
  drafts: { raw: string; threadId?: string }[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
  labels: string[];
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  scope: string;
  nonce: string | undefined;
  challenge: string | undefined;
  user: GoogleUser;
}

interface IssuedToken {
  user: GoogleUser;
  clientId: string;
  scope: string;
  expiresAt: number;
}

export class FakeGoogle {
  readonly clientId = 'manyplug-test.apps.googleusercontent.com';
  readonly clientSecret = 'google-test-secret';
  /** Lifetime of new access tokens, in seconds. */
  accessTokenTtl = 3600;
  /** The Google account signed in in the test browser; the consent screen approves as this user. */
  signedIn: GoogleUser | undefined;
  /** What the user does on Google's consent screen. */
  consent: 'allow' | 'deny' = 'allow';

  private readonly users = new Map<string, GoogleUser>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly accessTokens = new Map<string, IssuedToken>();
  private readonly refreshTokens = new Map<string, Omit<IssuedToken, 'expiresAt'>>();
  readonly revoked: string[] = [];
  private nextId = 1;

  /** Env for the hub: one Google client for sign-in and for Gmail/Calendar/Drive (as in production). */
  get env(): Record<string, string> {
    return { LOGIN_GOOGLE_CLIENT_ID: this.clientId, LOGIN_GOOGLE_CLIENT_SECRET: this.clientSecret };
  }

  addUser(user: {
    email: string;
    name?: string;
    hd?: string;
    mailbox?: Omit<GmailMessage, 'id' | 'threadId'>[];
  }) {
    const created: GoogleUser = {
      sub: String(100_000 + this.users.size),
      email: user.email,
      name: user.name ?? user.email.split('@')[0]!,
      ...(user.hd ? { hd: user.hd } : {}),
      mailbox: (user.mailbox ?? []).map((m) => {
        const id = `m${this.nextId++}`;
        return { ...m, id, threadId: `t${id}` };
      }),
      sent: [],
      drafts: [],
    };
    this.users.set(created.email, created);
    return created;
  }

  /** Makes every issued access token expire now (the next API call gets a 401). */
  expireAccessTokens(): void {
    for (const token of this.accessTokens.values()) token.expiresAt = 0;
  }

  /** Revokes the user's grant on Google's side (as from "Third-party apps" in the Google account). */
  revokeUser(user: GoogleUser): void {
    for (const [token, issued] of this.refreshTokens)
      if (issued.user === user) this.refreshTokens.delete(token);
    for (const [token, issued] of this.accessTokens)
      if (issued.user === user) this.accessTokens.delete(token);
  }

  install(internet: FakeInternet): this {
    internet.serve('accounts.google.com', this.accounts().fetch);
    internet.serve('oauth2.googleapis.com', this.oauth().fetch);
    internet.serve('gmail.googleapis.com', this.gmail().fetch);
    return this;
  }

  /** The sign-in and consent page: answers at once as `signedIn`, the way a remembered account does. */
  private accounts() {
    return new Hono().get('/o/oauth2/v2/auth', (c) => {
      const q = (name: string) => c.req.query(name);
      if (q('client_id') !== this.clientId) return c.text('Error 401: invalid_client', 401);
      const redirect = new URL(q('redirect_uri')!);
      if (q('state')) redirect.searchParams.set('state', q('state')!);
      if (!this.signedIn || this.consent === 'deny') {
        redirect.searchParams.set('error', 'access_denied');
        return c.redirect(redirect.toString(), 302);
      }
      const code = `4/${randomBytes(12).toString('base64url')}`;
      const challenge = q('code_challenge');
      if (challenge && q('code_challenge_method') !== 'S256')
        return c.text('Error 400: invalid_request', 400);
      this.codes.set(code, {
        clientId: q('client_id')!,
        redirectUri: q('redirect_uri')!,
        scope: q('scope') ?? '',
        nonce: q('nonce'),
        challenge,
        user: this.signedIn,
      });
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('scope', q('scope') ?? '');
      return c.redirect(redirect.toString(), 302);
    });
  }

  private oauth() {
    const app = new Hono();
    app.post('/token', async (c) => {
      const form = new URLSearchParams(await c.req.text());
      if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret) {
        return c.json({ error: 'invalid_client', error_description: 'The OAuth client was not found.' }, 401);
      }
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const code = this.codes.get(form.get('code') ?? '');
        this.codes.delete(form.get('code') ?? '');
        if (!code || code.clientId !== this.clientId || code.redirectUri !== form.get('redirect_uri')) {
          return c.json({ error: 'invalid_grant', error_description: 'Malformed auth code.' }, 400);
        }
        if (code.challenge) {
          const verifier = form.get('code_verifier') ?? '';
          if (createHash('sha256').update(verifier).digest('base64url') !== code.challenge) {
            return c.json({ error: 'invalid_grant', error_description: 'Invalid code verifier.' }, 400);
          }
        }
        return c.json(this.issue(code.user, code.scope, code.nonce, true));
      }
      if (grant === 'refresh_token') {
        const issued = this.refreshTokens.get(form.get('refresh_token') ?? '');
        if (!issued) {
          return c.json(
            { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
            400,
          );
        }
        // Google keeps the refresh token and only hands out a new access token.
        return c.json(this.issue(issued.user, issued.scope, undefined, false));
      }
      return c.json({ error: 'unsupported_grant_type' }, 400);
    });
    app.post('/revoke', async (c) => {
      const token = new URLSearchParams(await c.req.text()).get('token') ?? c.req.query('token') ?? '';
      this.revoked.push(token);
      this.refreshTokens.delete(token);
      this.accessTokens.delete(token);
      return c.json({});
    });
    return app;
  }

  private issue(user: GoogleUser, scope: string, nonce: string | undefined, withRefresh: boolean) {
    const access = `ya29.${randomBytes(16).toString('base64url')}`;
    this.accessTokens.set(access, {
      user,
      clientId: this.clientId,
      scope,
      expiresAt: Date.now() + this.accessTokenTtl * 1000,
    });
    const refresh =
      withRefresh && scope.split(' ').some((s) => s.startsWith('https://'))
        ? `1//${randomBytes(16).toString('base64url')}`
        : undefined;
    if (refresh) this.refreshTokens.set(refresh, { user, clientId: this.clientId, scope });
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const idToken = `${part({ alg: 'RS256', kid: 'test' })}.${part({
      iss: 'https://accounts.google.com',
      azp: this.clientId,
      aud: this.clientId,
      sub: user.sub,
      email: user.email,
      email_verified: true,
      name: user.name,
      ...(user.hd ? { hd: user.hd } : {}),
      ...(nonce ? { nonce } : {}),
      iat: now,
      exp: now + 3600,
    })}.c2lnbmF0dXJl`;
    return {
      access_token: access,
      expires_in: this.accessTokenTtl,
      token_type: 'Bearer',
      scope,
      ...(refresh ? { refresh_token: refresh } : {}),
      ...(scope.includes('openid') ? { id_token: idToken } : {}),
    };
  }

  private gmail() {
    const app = new Hono<{ Variables: { user: GoogleUser } }>().basePath('/gmail/v1/users/me');
    app.use('*', async (c, next) => {
      const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
      const issued = this.accessTokens.get(token);
      if (!issued || issued.expiresAt <= Date.now()) {
        return c.json(
          {
            error: {
              code: 401,
              message: 'Request had invalid authentication credentials.',
              status: 'UNAUTHENTICATED',
            },
          },
          401,
        );
      }
      if (!issued.scope.includes('https://www.googleapis.com/auth/gmail.modify')) {
        return c.json(
          { error: { code: 403, message: 'Request had insufficient authentication scopes.' } },
          403,
        );
      }
      c.set('user', issued.user);
      await next();
    });
    app.get('/profile', (c) => {
      const user = c.get('user');
      return c.json({ emailAddress: user.email, messagesTotal: user.mailbox.length });
    });
    app.get('/labels', (c) =>
      c.json({
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'UNREAD', name: 'UNREAD', type: 'system' },
        ],
      }),
    );
    app.get('/messages', (c) => {
      const words = (c.req.query('q') ?? '')
        .split(/\s+/)
        .filter((w) => w && !w.includes(':'))
        .map((w) => w.toLowerCase());
      const max = Number(c.req.query('maxResults') ?? 100);
      const found = c
        .get('user')
        .mailbox.filter((m) =>
          words.every((w) => `${m.from} ${m.to} ${m.subject} ${m.body}`.toLowerCase().includes(w)),
        )
        .sort((a, b) => b.date.localeCompare(a.date));
      return c.json({
        messages: found.slice(0, max).map((m) => ({ id: m.id, threadId: m.threadId })),
        resultSizeEstimate: found.length,
      });
    });
    app.get('/messages/:id', (c) => {
      const message = c.get('user').mailbox.find((m) => m.id === c.req.param('id'));
      if (!message) return c.json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404);
      const base = {
        id: message.id,
        threadId: message.threadId,
        labelIds: message.labels,
        snippet: message.body.slice(0, 100),
        internalDate: String(Date.parse(message.date)),
      };
      if (c.req.query('format') === 'raw') return c.json({ ...base, raw: rawOf(message) });
      return c.json({
        ...base,
        payload: {
          headers: [
            { name: 'From', value: message.from },
            { name: 'To', value: message.to },
            { name: 'Subject', value: message.subject },
            { name: 'Date', value: new Date(message.date).toUTCString() },
          ],
        },
      });
    });
    app.post('/messages/send', async (c) => {
      const body = (await c.req.json()) as { raw: string; threadId?: string };
      const user = c.get('user');
      user.sent.push(body);
      return c.json({
        id: `sent${user.sent.length}`,
        threadId: body.threadId ?? `tsent${user.sent.length}`,
        labelIds: ['SENT'],
      });
    });
    app.post('/drafts', async (c) => {
      const body = (await c.req.json()) as { message: { raw: string; threadId?: string } };
      const user = c.get('user');
      user.drafts.push(body.message);
      const n = user.drafts.length;
      return c.json({
        id: `r${n}`,
        message: { id: `draft${n}`, threadId: body.message.threadId ?? `td${n}` },
      });
    });
    return app;
  }
}

/** RFC 822 source of a message, base64url-encoded as Gmail returns it. */
function rawOf(message: GmailMessage): string {
  const source = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${new Date(message.date).toUTCString()}`,
    `Message-ID: <${message.id}@mail.example>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    message.body,
  ].join('\r\n');
  return Buffer.from(source).toString('base64url');
}

/** Decodes a sent message's raw source (for assertions on what the hub sent). */
export function decodeSent(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}
