import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

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
const manifest = defineManifestConnector({
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
      risk: 'dangerous',
      tags: ['moves_money'],
      request: { method: 'POST', path: '/refunds', bodyType: 'form' },
      response: { fields: ['id', 'amount', 'currency', 'status'] },
    },
  ],
});

/** How the service reads on the website; the AI keeps the English texts of the manifest. */
const ui: ConnectorUi = {
  locales: {
    ru: {
      setup: {
        form: {
          summary: 'Ограниченный ключ API из панели Stripe. Около двух минут.',
          steps: [
            {
              text: 'Откройте Developers → API keys в панели Stripe.',
              link: {
                label: 'Открыть ключи API Stripe',
                url: 'https://dashboard.stripe.com/apikeys',
              },
            },
            {
              text: 'Нажмите Create restricted key и назовите ключ Manyplug.',
            },
            {
              text: 'Поставьте Read для Balance, Customers, PaymentIntents, Invoices и Subscriptions. Refunds — Write, только если ИИ можно делать возвраты.',
            },
            {
              text: 'Нажмите Create key, скопируйте ключ (rk_live_…) и вставьте в форму.',
            },
          ],
          tips: [
            'Хотите сначала попробовать без риска? Возьмите ключ тестового режима (rk_test_…).',
            'Возвраты по умолчанию ждут вашего подтверждения (см. «Правила»).',
          ],
        },
      },
      prompts: [
        'Сколько мы получили на этой неделе, по валютам?',
        'Найди платежи от anna@example.com и покажи их статус.',
        'Какие подписки отменили в этом месяце?',
        'Верни половину последнего платежа от ACME. Сначала спроси меня.',
      ],
      description: 'Платежи Stripe: баланс, клиенты, платежи, счета, подписки и возвраты.',
      fields: {
        apiKey: {
          label: 'Секретный ключ API',
          hint: 'Лучше всего ограниченный ключ (rk_…) только с нужными правами. Ключи — на dashboard.stripe.com/apikeys.',
          placeholder: 'rk_live_…',
        },
      },
      actions: {
        get_balance: { title: 'Баланс', description: 'Доступный и ожидающий баланс в каждой валюте.' },
        search_customers: { title: 'Поиск клиентов', description: 'Находит клиентов.' },
        search_payments: { title: 'Поиск платежей', description: 'Находит платежи (PaymentIntents).' },
        search_invoices: { title: 'Поиск счетов', description: 'Находит счета.' },
        list_subscriptions: {
          title: 'Список подписок',
          description: 'Подписки, сначала новые. Можно выбрать клиента или статус.',
        },
        create_refund: {
          title: 'Возврат платежа',
          description: 'Возвращает платёж целиком или частично. Деньги уходят с вашего счёта.',
        },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'A restricted API key from your Stripe dashboard. Takes about two minutes.',
          steps: [
            {
              text: 'Open Developers → API keys in the Stripe dashboard.',
              link: {
                label: 'Open Stripe API keys',
                url: 'https://dashboard.stripe.com/apikeys',
              },
            },
            {
              text: 'Click Create restricted key and name it Manyplug.',
            },
            {
              text: 'Set Read for Balance, Customers, PaymentIntents, Invoices and Subscriptions. Set Refunds to Write only if the AI may refund payments.',
            },
            {
              text: 'Click Create key, copy it (rk_live_…) and paste it into the form.',
            },
          ],
          tips: [
            'Want to try it safely first? Use a test-mode key (rk_test_…).',
            'Refunds wait for your confirmation by default (see Rules).',
          ],
        },
      },
      prompts: [
        'How much did we take in this week, by currency?',
        'Find payments from anna@example.com and show their status.',
        'Which subscriptions were cancelled this month?',
        'Refund half of the last payment from ACME. Ask me before doing it.',
      ],
      fields: {
        apiKey: {
          label: 'Secret API key',
          hint: 'A restricted key (rk_…) with only the rights you need is best. Keys are at dashboard.stripe.com/apikeys.',
          placeholder: 'rk_live_…',
        },
      },
      actions: {
        get_balance: { title: 'Balance', description: 'Available and pending balance in each currency.' },
        search_customers: { title: 'Search customers', description: 'Finds customers.' },
        search_payments: { title: 'Search payments', description: 'Finds payments (PaymentIntents).' },
        search_invoices: { title: 'Search invoices', description: 'Finds invoices.' },
        list_subscriptions: {
          title: 'List subscriptions',
          description: 'Subscriptions, newest first, optionally of one customer or status.',
        },
        create_refund: {
          title: 'Refund a payment',
          description: 'Refunds a payment in full or in part. Money leaves your account.',
        },
      },
    },
  },
};

export default withUi(manifest, ui);
