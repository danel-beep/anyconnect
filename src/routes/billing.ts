import { Hono } from 'hono';
import type { AppEnv } from './context.js';

/**
 * Payment provider webhooks. Nothing is connected yet: until a `BillingProvider` with
 * `handleWebhook` is wired in `createServices`, this answers 404. The provider verifies the
 * signature itself and records the result with `EntitlementService.setPlan`.
 */
export function billingRoutes() {
  const app = new Hono<AppEnv>();
  app.post('/billing/webhook/:provider', async (c) => {
    const billing = c.get('services').billing;
    if (!billing?.handleWebhook || billing.id !== c.req.param('provider')) return c.notFound();
    return billing.handleWebhook(c.req.raw);
  });
  return app;
}
