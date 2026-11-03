import { bearerAuthChallengeResponse, verifyBearerToken } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { publicCors } from '../web/http.js';
import type { AppContext, AppEnv } from './context.js';

/** The MCP endpoint: bearer authentication, then the stateless MCP handler. */
export function mcpRoutes() {
  const app = new Hono<AppEnv>();
  app.use('/mcp', publicCors());
  app.use('/mcp/', publicCors());

  const handle = async (c: AppContext) => {
    const s = c.get('services');
    const resourceMetadataUrl = `${s.config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
    const requiredScopes = ['mcp'];
    let authInfo: Awaited<ReturnType<typeof verifyBearerToken>>;
    try {
      authInfo = await verifyBearerToken(c.req.header('authorization'), {
        verifier: s.verifier,
        requiredScopes,
        resourceMetadataUrl,
        expectedResource: new URL(s.config.mcpUrl),
      });
    } catch (error) {
      return bearerAuthChallengeResponse(error, { requiredScopes, resourceMetadataUrl });
    }
    return s.mcp.fetch(c.req.raw, { authInfo });
  };

  app.all('/mcp', handle);
  app.all('/mcp/', handle);
  return app;
}
