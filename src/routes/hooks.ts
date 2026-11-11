import { Hono } from 'hono';
import { isId } from '../lib/ids.js';
import type { AppEnv } from './context.js';

/** Webhook bodies larger than this are rejected (Telegram and Meta send a few KB). */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Inbound webhooks of messenger accounts with a direct transport (Telegram Bot API, WhatsApp
 * Cloud API): `/hooks/messenger/<account id>`. The connector verifies the request (secret token
 * header, HMAC signature) and turns it into messages; the hub stores them.
 */
export function hookRoutes() {
  const app = new Hono<AppEnv>();

  app.on(['GET', 'POST'], '/hooks/messenger/:accountId', async (c) => {
    const s = c.get('services');
    const accountId = c.req.param('accountId');
    // The address is public: anything that is not an account id is turned away before any lookup.
    if (!isId('acc', accountId)) return c.text('Not found', 404);
    const resolved = await s.messaging.service.resolve(accountId);
    const transport = resolved?.transport;
    if (!resolved?.row.enabled || transport?.kind !== 'direct' || !transport.webhook) {
      return c.text('Not found', 404);
    }
    // Counted per account only once the account is known to exist, so made-up ids cannot fill the
    // rate limiter and push out the counters that guard sign-in.
    const limited = s.rateLimiter.consume(`hook:${accountId}`, 600, 60_000);
    if (!limited.allowed)
      return c.text('Too many requests', 429, { 'retry-after': String(limited.retryAfterSeconds) });
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > MAX_BODY_BYTES) return c.text('Payload too large', 413);
    const body = c.req.method === 'POST' ? await c.req.text() : '';
    if (body.length > MAX_BODY_BYTES) return c.text('Payload too large', 413);

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const ctx = await s.messaging.service.context(resolved, AbortSignal.timeout(20_000));
    const endpoint = s.messaging.service.forAccount(accountId).webhook();
    try {
      const response = await transport.webhook.handle(
        { method: c.req.method, headers, query: c.req.query(), body },
        ctx,
        { ...endpoint, ...s.messaging.service.inbound(accountId) },
      );
      return new Response(response.body ?? null, {
        status: response.status,
        headers: { 'content-type': response.contentType ?? 'text/plain; charset=utf-8' },
      });
    } catch (error) {
      // A 500 makes the messenger retry later, which is what we want: ingestion is idempotent.
      s.logger.error({ err: error, account: accountId }, 'messenger webhook failed');
      return c.text('Internal error', 500);
    }
  });

  return app;
}
