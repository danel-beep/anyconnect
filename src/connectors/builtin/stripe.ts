import { defineManifestConnector } from '../manifest/compile.js';

const searchInput = (example: string) => ({
  type: 'object' as const,
  properties: {
    query: { type: 'string', minLength: 1, description: `Stripe search query, e.g. ${example}` },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
  required: ['query'],
});

/**
 * Stripe API. A restricted key with read access (plus "Refunds: write" if refunds are wanted) is
 * the recommended credential: the AI then cannot do more than the key allows.
 */
export default defineManifestConnector({
  id: 'stripe',
  name: 'Stripe',
  description: 'Stripe payments: balance, customers, payments, invoices, subscriptions, refunds.',
  version: '1.0.0',
  homepage: 'https://docs.stripe.com/api',
  instructions:
    'Amounts are in the smallest currency unit (cents/kopecks); "created" is a Unix timestamp. Search syntax: field:\'value\' joined with AND/OR, e.g. "status:\'succeeded\' AND created>1767225600".',
  baseUrl: 'https://api.stripe.com/v1',
  auth: { type: 'bearer', token: '{{credentials.apiKey}}' },
  credentials: {
    type: 'object',
    properties: {
      apiKey: {
        type: 'string',
        pattern: '^(sk|rk)_(live|test)_',
        description: 'Secret or restricted key (rk_… recommended): https://dashboard.stripe.com/apikeys',
      },
    },
    required: ['apiKey'],
  },
  rateLimit: { requests: 50, perSeconds: 1 },
  errorMessagePaths: ['error.message'],
  pagination: { type: 'cursor', param: 'page', nextPath: 'next_page' },
  test: { request: { method: 'GET', path: '/balance' } },
  actions: [
    {
      name: 'get_balance',
      title: 'Balance',
      description: 'Available and pending balance per currency.',
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/balance' },
      response: { fields: ['available', 'pending', 'livemode'] },
    },
    {
      name: 'search_customers',
      title: 'Search customers',
      description: 'Finds customers.',
      input: searchInput(`"email:'ann@example.com'" or "name~'Ann'"`),
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/customers/search' },
      response: {
        root: 'data',
        fields: ['id', 'email', 'name', 'created', 'balance', 'currency', 'delinquent'],
      },
      pagination: true,
    },
    {
      name: 'search_payments',
      title: 'Search payments',
      description: 'Finds payments (PaymentIntents).',
      input: searchInput(`"status:'succeeded' AND amount>10000" or "customer:'cus_123'"`),
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/payment_intents/search' },
      response: {
        root: 'data',
        fields: [
          'id',
          'amount',
          'amount_received',
          'currency',
          'status',
          'created',
          'customer',
          'description',
        ],
      },
      pagination: true,
    },
    {
      name: 'search_invoices',
      title: 'Search invoices',
      description: 'Finds invoices.',
      input: searchInput(`"status:'open'" or "customer:'cus_123'"`),
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/invoices/search' },
      response: {
        root: 'data',
        fields: [
          'id',
          'number',
          'customer',
          'customer_email',
          'status',
          'amount_due',
          'amount_paid',
          'currency',
          'created',
          'due_date',
          'hosted_invoice_url',
        ],
      },
      pagination: true,
    },
    {
      name: 'list_subscriptions',
      title: 'List subscriptions',
      description: 'Lists subscriptions, newest first, optionally of one customer or status.',
      input: {
        type: 'object',
        properties: {
          customer: { type: 'string', description: 'Customer id (cus_…)' },
          status: {
            type: 'string',
            enum: ['active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'trialing', 'paused', 'all'],
          },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/subscriptions' },
      response: {
        root: 'data',
        fields: ['id', 'customer', 'status', 'created', 'cancel_at_period_end', 'canceled_at', 'currency'],
      },
    },
    {
      name: 'create_refund',
      title: 'Refund a payment',
      description: 'Refunds a payment fully, or partially when amount is given. Money leaves the account.',
      input: {
        type: 'object',
        properties: {
          payment_intent: { type: 'string', minLength: 1, description: 'PaymentIntent id (pi_…)' },
          amount: {
            type: 'integer',
            minimum: 1,
            description: 'Smallest currency unit; omit for a full refund',
          },
          reason: { type: 'string', enum: ['duplicate', 'fraudulent', 'requested_by_customer'] },
        },
        required: ['payment_intent'],
      },
      hints: { readOnly: false, destructive: true },
      request: { method: 'POST', path: '/refunds', bodyType: 'form' },
      response: { fields: ['id', 'amount', 'currency', 'status'] },
    },
  ],
});
