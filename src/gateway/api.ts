import { Hono } from 'hono';
import { z } from 'zod';
import { ConnectorError } from '../connectors/sdk.js';
import { safeEqual } from '../lib/crypto.js';
import type { Logger } from '../logger.js';
import { LoginStepInput, StartLoginInput } from '../messaging/gateway-client.js';
import type { SessionHost } from './host.js';

const DownloadInput = z.object({
  chatExternalId: z.string().min(1),
  messageExternalId: z.string().min(1),
  attachment: z.object({
    externalId: z.string(),
    kind: z.string(),
    name: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
    locator: z.unknown().optional(),
  }),
});

/**
 * Internal API of the gateway, reachable only on the private network and only with the shared
 * GATEWAY_TOKEN. The hub calls it for operations that need the live session (login, files,
 * older history); everything else goes through the database.
 */
export function gatewayApi(deps: { host: SessionHost; token: string; logger: Logger; version: string }) {
  const app = new Hono();

  app.get('/healthz', (c) =>
    c.json({ status: 'ok', version: deps.version, sessions: deps.host.sessionCount() }),
  );

  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !safeEqual(token, deps.token))
      return c.json({ error: { kind: 'auth', message: 'unauthorized' } }, 401);
    await next();
  });

  const body = async <T extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, schema: T) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new ConnectorError('invalid_input', 'Invalid request body');
    return parsed.data as z.output<T>;
  };

  app.post('/v1/accounts/:id/login', async (c) =>
    c.json(await deps.host.startLogin(c.req.param('id'), await body(c, StartLoginInput))),
  );
  app.get('/v1/accounts/:id/login/:login', (c) =>
    c.json(deps.host.getLogin(c.req.param('id'), c.req.param('login'))),
  );
  app.post('/v1/accounts/:id/login/:login', async (c) =>
    c.json(
      await deps.host.submitLogin(c.req.param('id'), c.req.param('login'), await body(c, LoginStepInput)),
    ),
  );
  app.delete('/v1/accounts/:id/login/:login', async (c) => {
    await deps.host.cancelLogin(c.req.param('id'), c.req.param('login'));
    return c.body(null, 204);
  });
  app.post('/v1/accounts/:id/logout', async (c) => {
    await deps.host.logout(c.req.param('id'));
    return c.body(null, 204);
  });

  app.post('/v1/accounts/:id/resolve', async (c) => {
    const { to } = await body(c, z.object({ to: z.string().min(1).max(64) }));
    const live = deps.host.live(c.req.param('id'));
    if (!live.resolveRecipient)
      throw new ConnectorError('invalid_input', 'This account can only write to existing chats.');
    return c.json(await live.resolveRecipient(to));
  });
  app.post('/v1/accounts/:id/download', async (c) => {
    const ref = await body(c, DownloadInput);
    const live = deps.host.live(c.req.param('id'));
    if (!live.download) throw new ConnectorError('invalid_input', 'This account cannot download files.');
    const file = await live.download(ref as Parameters<NonNullable<typeof live.download>>[0]);
    return new Response(file.data, {
      headers: {
        'content-type': file.mimeType || 'application/octet-stream',
        ...(file.name ? { 'x-file-name': encodeURIComponent(file.name) } : {}),
      },
    });
  });
  app.post('/v1/accounts/:id/backfill', async (c) => {
    const { chatExternalId, limit } = await body(
      c,
      z.object({ chatExternalId: z.string().min(1), limit: z.number().int().min(1).max(500) }),
    );
    const live = deps.host.live(c.req.param('id'));
    if (!live.backfill) throw new ConnectorError('invalid_input', 'This account cannot load older history.');
    return c.json({ ingested: await live.backfill(chatExternalId, limit) });
  });

  app.onError((error, c) => {
    if (error instanceof ConnectorError) {
      const status =
        error.kind === 'not_found'
          ? 404
          : error.kind === 'invalid_input'
            ? 400
            : error.kind === 'auth'
              ? 401
              : 502;
      return c.json({ error: { kind: error.kind, message: error.message } }, status);
    }
    deps.logger.error({ err: error, path: c.req.path }, 'gateway request failed');
    return c.json({ error: { kind: 'upstream', message: 'Gateway internal error' } }, 500);
  });

  return app;
}
