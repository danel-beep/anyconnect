import { bearerAuthChallengeResponse, verifyBearerToken } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { PERSONA_SLUG } from '../security/personas.js';
import { publicCors } from '../web/http.js';
import type { AppContext, AppEnv } from './context.js';

/**
 * The MCP endpoints: `/mcp` (the whole workspace) and `/mcp/<persona>` (one persona's accounts).
 * Each URL is its own OAuth protected resource: a token only works on the URL it was issued for.
 */
export function mcpRoutes() {
  const app = new Hono<AppEnv>();
  app.use('/mcp', publicCors());
  app.use('/mcp/*', publicCors());

  const handle = async (c: AppContext, persona?: string) => {
    const s = c.get('services');
    if (persona !== undefined && !PERSONA_SLUG.test(persona)) return c.text('Not found', 404);
    const resource = persona ? `${s.config.mcpUrl}/${persona}` : s.config.mcpUrl;
    const resourceMetadataUrl = `${s.config.publicUrl}/.well-known/oauth-protected-resource/mcp${persona ? `/${persona}` : ''}`;
    const requiredScopes = ['mcp'];
    let authInfo: Awaited<ReturnType<typeof verifyBearerToken>>;
    try {
      authInfo = await verifyBearerToken(c.req.header('authorization'), {
        verifier: s.verifier,
        requiredScopes,
        resourceMetadataUrl,
        expectedResource: new URL(resource),
      });
    } catch (error) {
      return bearerAuthChallengeResponse(error, { requiredScopes, resourceMetadataUrl });
    }
    return s.mcp.fetch(c.req.raw, { authInfo });
  };

  app.all('/mcp', (c) => handle(c));
  app.all('/mcp/', (c) => handle(c));
  app.all('/mcp/:persona', (c) => handle(c, c.req.param('persona')));
  return app;
}
