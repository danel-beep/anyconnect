import { bearerAuthChallengeResponse, verifyBearerToken } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { principalFromAuthInfo } from '../core/auth.js';
import { isMcpSubPath } from '../core/mcp-paths.js';
import { bearerVaultSecret } from '../core/vault-scope.js';
import { VISITOR_CALLABLE } from '../hub/visitor.js';
import { clientRateKey, publicCors } from '../web/http.js';
import type { AppContext, AppEnv } from './context.js';

/**
 * The MCP endpoints: `/mcp` (the user's personal workspace), `/mcp/<persona>` (one persona's
 * accounts) and `/mcp/team/<slug>` (a team: every member signs in as themselves, see
 * `core/teams.ts`). Each URL is its own OAuth protected resource: a token only works on the URL it
 * was issued for.
 *
 * With `MCP_ANONYMOUS`, a request to `/mcp` without an `Authorization` header is served by the
 * visitor handler (see `hub/visitor.ts`), rate-limited per IP, unless it calls a tool that needs an
 * account: that one gets the usual 401 challenge, so the app starts OAuth (sign-in). Persona and
 * team URLs always need a token.
 */
export function mcpRoutes() {
  const app = new Hono<AppEnv>();
  app.use('/mcp', publicCors());
  app.use('/mcp/*', publicCors());

  /** `path` is what follows `/mcp/`: a persona slug or `team/<slug>`; undefined for `/mcp` itself. */
  const handle = async (c: AppContext, path?: string) => {
    const s = c.get('services');
    if (path !== undefined && !isMcpSubPath(path)) return c.text('Not found', 404);
    const authorization = c.req.header('authorization');

    if (!authorization && path === undefined && s.visitorMcp) {
      const ip = clientRateKey(c, s.config.trustProxy);
      const limit = s.rateLimiter.consume(`mcp:anon:${ip}`, s.config.anonymousMcp.perMinute, 60_000);
      if (!limit.allowed) {
        return c.json(
          {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: 'Too many requests; sign in to continue.' },
          },
          429,
          { 'Retry-After': String(limit.retryAfterSeconds) },
        );
      }
      if (!(await needsSignIn(c.req.raw))) return s.visitorMcp.fetch(c.req.raw);
    }

    const resource = path ? `${s.config.mcpUrl}/${path}` : s.config.mcpUrl;
    const resourceMetadataUrl = `${s.config.publicUrl}/.well-known/oauth-protected-resource/mcp${path ? `/${path}` : ''}`;
    const requiredScopes = ['mcp'];
    let authInfo: Awaited<ReturnType<typeof verifyBearerToken>>;
    try {
      authInfo = await verifyBearerToken(authorization, {
        verifier: s.verifier,
        requiredScopes,
        resourceMetadataUrl,
        expectedResource: new URL(resource),
      });
    } catch (error) {
      return bearerAuthChallengeResponse(error, { requiredScopes, resourceMetadataUrl });
    }
    // The caller's vault opens (lazily) with the token it presented: sealed accounts work only here.
    const secret = authInfo.token
      ? bearerVaultSecret(principalFromAuthInfo(authInfo), authInfo.token)
      : undefined;
    return s.vaultScopes.run(secret, () => s.mcp.fetch(c.req.raw, { authInfo }));
  };

  app.all('/mcp', (c) => handle(c));
  app.all('/mcp/', (c) => handle(c));
  app.all('/mcp/team/:team', (c) => handle(c, `team/${c.req.param('team')}`));
  app.all('/mcp/:persona', (c) => handle(c, c.req.param('persona')));
  return app;
}

/** Whether a JSON-RPC message (or batch) calls a tool a visitor may not call. */
async function needsSignIn(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return false; // the MCP handler answers malformed bodies itself
  }
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    if (typeof message !== 'object' || message === null) return false;
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
    if (method !== 'tools/call') return false;
    const name = params?.name;
    return typeof name !== 'string' || !VISITOR_CALLABLE.has(name);
  });
}
