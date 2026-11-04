import type { BillingConfig } from '../config.js';
import type { BillingProvider } from '../provider.js';
import { PaddleProvider } from './paddle.js';
import { StripeProvider } from './stripe.js';
import { TestBillingProvider } from './test.js';

/** The configured payment provider, or undefined when payments are off. */
export function createBillingProvider(
  config: BillingConfig,
  opts: { publicUrl: string; fetch?: typeof fetch },
): BillingProvider | undefined {
  switch (config.provider) {
    case 'paddle':
      return new PaddleProvider({
        ...config.paddle!,
        publicUrl: opts.publicUrl,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
    case 'stripe':
      return new StripeProvider({ ...config.stripe!, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    case 'test':
      return new TestBillingProvider({ publicUrl: opts.publicUrl });
    default:
      return undefined;
  }
}

export { PaddleProvider, StripeProvider, TestBillingProvider };
