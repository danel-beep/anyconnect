import { Hono } from 'hono';
import { z } from 'zod';
import { PaddleProvider } from '../billing/providers/paddle.js';
import { TestBillingProvider } from '../billing/providers/test.js';
import { PaddleCheckoutPage, TestCheckoutPage, TestPortalPage } from '../web/billing-pages.js';
import { PADDLE_CHECKOUT_JS } from '../web/client-scripts.js';
import { checkoutCsp, csrfToken } from '../web/http.js';
import { type AppContext, type AppEnv, bodyParams } from './context.js';
import { cookieOpts, csrfFailedPage, csrfOk } from './page-helpers.js';

/** Paddle.js and its checkout frames. */
const PADDLE_CSP = checkoutCsp({
  script: ['https://cdn.paddle.com'],
  frame: ['https://*.paddle.com'],
  connect: ['https://*.paddle.com'],
});

/**
 * Payment routes outside the dashboard: provider webhooks (`/billing/webhook/:provider`, verified
 * by the provider's signature), the page that hosts Paddle's checkout, and the pages of the test
 * provider. Buying, the portal and cancelling are dashboard actions (`/app/billing/*`) and setup
 * tools (`manyplug_plan`, `manyplug_change_plan`).
 */
export function billingRoutes() {
  const app = new Hono<AppEnv>();

  app.post('/billing/webhook/:provider', async (c) => {
    const body = await c.req.text();
    const status = await c
      .get('services')
      .billing.handleWebhook(c.req.param('provider'), body, c.req.raw.headers);
    return c.body(null, status as 200);
  });

  app.get('/assets/paddle-checkout.js', (c) =>
    c.body(PADDLE_CHECKOUT_JS, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    }),
  );

  /**
   * Paddle's "default payment link": opens the overlay for a transaction. No sign-in needed, as
   * Paddle also sends customers here (`?_ptxn=`) to update a card; the transaction is the key.
   */
  app.get('/billing/paddle/checkout', (c) => {
    const s = c.get('services');
    const provider = s.billing.provider;
    if (!(provider instanceof PaddleProvider)) return c.notFound();
    const q = z
      .object({
        txn: z
          .string()
          .regex(/^txn_[a-z0-9]+$/)
          .optional(),
        email: z.email().optional(),
      })
      .safeParse({ txn: c.req.query('txn'), email: c.req.query('email') || undefined });
    const ptxn = c.req.query('_ptxn');
    if (!q.success || (!q.data.txn && !ptxn)) return c.redirect('/app/billing', 302);
    c.header('Content-Security-Policy', PADDLE_CSP);
    const page = provider.checkoutPage;
    return c.html(
      <PaddleCheckoutPage
        t={c.get('t')}
        lang={c.get('locale')}
        view={{
          clientToken: page.clientToken,
          sandbox: page.sandbox,
          transactionId: q.data.txn ?? '',
          email: q.data.email ?? null,
          success: `${s.config.publicUrl}/app/billing?paid=1`,
          back: `${s.config.publicUrl}/app/billing`,
        }}
      />,
    );
  });

  // --- Test provider (BILLING_PROVIDER=test, development only) ---------------------

  const testProvider = (c: AppContext) => {
    const provider = c.get('services').billing.provider;
    return provider instanceof TestBillingProvider ? provider : undefined;
  };

  app.get('/billing/test/checkout', (c) => {
    const provider = testProvider(c);
    if (!provider) return c.notFound();
    const token = c.req.query('t') ?? '';
    const input = provider.readCheckout(token);
    return c.html(
      <TestCheckoutPage
        t={c.get('t')}
        lang={c.get('locale')}
        csrf={csrfToken(c, cookieOpts(c))}
        view={
          input
            ? {
                token,
                planName: c.get('t')(`plan.${input.planId}.name` as 'plan.free.name'),
                interval: input.interval,
                cancelUrl: input.cancelUrl,
              }
            : undefined
        }
      />,
    );
  });

  app.post('/billing/test/checkout', async (c) => {
    const provider = testProvider(c);
    if (!provider) return c.notFound();
    const form = await bodyParams(c);
    if (!csrfOk(c, form)) return csrfFailedPage(c);
    const done = await provider.completeCheckout(form.t ?? '');
    return c.redirect(done ? done.successUrl : '/app/billing', 303);
  });

  app.get('/billing/test/portal', (c) => {
    const provider = testProvider(c);
    if (!provider) return c.notFound();
    const token = c.req.query('t') ?? '';
    const found = provider.readPortal(token);
    return c.html(
      <TestPortalPage
        t={c.get('t')}
        lang={c.get('locale')}
        csrf={csrfToken(c, cookieOpts(c))}
        view={
          found
            ? {
                token,
                status: found.sub.status,
                periodEnd: found.sub.periodEnd,
                cancelAtPeriodEnd: found.sub.cancelAtPeriodEnd,
                back: found.back,
              }
            : undefined
        }
      />,
    );
  });

  app.post('/billing/test/portal', async (c) => {
    const provider = testProvider(c);
    if (!provider) return c.notFound();
    const form = await bodyParams(c);
    if (!csrfOk(c, form)) return csrfFailedPage(c);
    const found = provider.readPortal(form.t ?? '');
    const what = z.enum(['cancel', 'resume', 'renew', 'fail', 'end']).safeParse(form.what);
    if (found && what.success) await provider.simulate(found.sub.id, what.data);
    return c.redirect(`/billing/test/portal?t=${encodeURIComponent(form.t ?? '')}`, 303);
  });

  return app;
}
