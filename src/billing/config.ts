import { z } from 'zod';
import { PLANS } from './plans.js';
import type { BillingInterval } from './provider.js';

/**
 * Payment settings from environment variables. One provider is active at a time
 * (`BILLING_PROVIDER`); each has its keys and a price for every paid plan and interval:
 * `<PROVIDER>_PRICE_<PLAN>_<MONTH|YEAR>`, e.g. `PADDLE_PRICE_PRO_YEAR=pri_01h...`.
 */
export type BillingProviderId = 'paddle' | 'stripe' | 'test';

export interface BillingConfig {
  /** Undefined = payments off (plans are changed by admins; users send plan requests). */
  provider: BillingProviderId | undefined;
  /** `plan:interval` → the active provider's price id. */
  prices: Map<string, string>;
  paddle?: {
    apiKey: string;
    /** Client-side token for Paddle.js on the hub's checkout page. */
    clientToken: string;
    webhookSecret: string;
    sandbox: boolean;
  };
  stripe?: { secretKey: string; webhookSecret: string };
}

export const priceKey = (planId: string, interval: BillingInterval) => `${planId}:${interval}`;

/** Paid plans anyone can buy: each needs a price per interval at the active provider. */
export const PAID_PLANS = PLANS.filter((p) => p.public && p.priceMonthly > 0);

const Provider = z.enum(['none', 'paddle', 'stripe', 'test']).default('none');

export class BillingConfigError extends Error {}

export function readBillingConfig(source: NodeJS.ProcessEnv, opts: { isProduction: boolean }): BillingConfig {
  const get = (name: string) => source[name]?.trim() || undefined;
  const parsed = Provider.safeParse(get('BILLING_PROVIDER')?.toLowerCase());
  if (!parsed.success) {
    throw new BillingConfigError('BILLING_PROVIDER must be one of none, paddle, stripe, test');
  }
  const provider = parsed.data === 'none' ? undefined : parsed.data;
  const prices = new Map<string, string>();
  if (!provider) return { provider, prices };

  if (provider === 'test') {
    // The test provider upgrades anyone for free: never on the live site.
    if (opts.isProduction) {
      throw new BillingConfigError(
        'BILLING_PROVIDER=test is for development only; use the Paddle sandbox or Stripe test keys on a server',
      );
    }
    for (const plan of PAID_PLANS) {
      for (const interval of ['month', 'year'] as const) {
        prices.set(priceKey(plan.id, interval), `test_${plan.id}_${interval}`);
      }
    }
    return { provider, prices };
  }

  const require = (name: string) => {
    const value = get(name);
    if (!value) throw new BillingConfigError(`BILLING_PROVIDER=${provider} needs ${name}`);
    return value;
  };
  const prefix = provider.toUpperCase();
  for (const plan of PAID_PLANS) {
    for (const interval of ['month', 'year'] as const) {
      const value = get(`${prefix}_PRICE_${plan.id.toUpperCase()}_${interval.toUpperCase()}`);
      if (value) prices.set(priceKey(plan.id, interval), value);
    }
  }
  if (provider === 'paddle') {
    const env = (get('PADDLE_ENVIRONMENT') ?? 'sandbox').toLowerCase();
    if (env !== 'sandbox' && env !== 'production') {
      throw new BillingConfigError('PADDLE_ENVIRONMENT must be sandbox or production');
    }
    return {
      provider,
      prices,
      paddle: {
        apiKey: require('PADDLE_API_KEY'),
        clientToken: require('PADDLE_CLIENT_TOKEN'),
        webhookSecret: require('PADDLE_WEBHOOK_SECRET'),
        sandbox: env === 'sandbox',
      },
    };
  }
  return {
    provider,
    prices,
    stripe: { secretKey: require('STRIPE_SECRET_KEY'), webhookSecret: require('STRIPE_WEBHOOK_SECRET') },
  };
}

/** Paid plans and intervals without a price at the active provider (shown in the admin panel). */
export function missingPrices(config: BillingConfig): string[] {
  if (!config.provider) return [];
  const missing: string[] = [];
  for (const plan of PAID_PLANS) {
    for (const interval of ['month', 'year'] as const) {
      if (!config.prices.has(priceKey(plan.id, interval))) missing.push(priceKey(plan.id, interval));
    }
  }
  return missing;
}
