# Оплата и подписки

Оплата устроена так, что платёжную систему можно поменять настройкой, не трогая остальной код.

## Как это устроено

```
кабинет /app/billing ─┐                     ┌─ PaddleProvider  (src/billing/providers/paddle.ts)
setup-инструменты ИИ ─┼─> BillingService ──>├─ StripeProvider  (…/stripe.ts)
вебхуки /billing/... ─┘   (service.ts)      └─ TestBillingProvider (…/test.ts, только разработка)
                              │
                              └─> EntitlementService.setPlan → subscriptions → лимиты, этап quota
```

- **`BillingProvider`** (`src/billing/provider.ts`) — только перевод между хабом и API провайдера:
  открыть оплату, портал, сменить цену, отменить в конце периода, проверить подпись вебхука и
  превратить его в нормализованное `SubscriptionChange`.
- **`BillingService`** (`src/billing/service.ts`) — всё остальное, одинаково для всех провайдеров:
  цена тарифа, покупка или смена тарифа (если подписка уже есть, второй checkout не создаётся,
  а меняется цена с пересчётом), портал, отмена, применение вебхуков. Каждое событие пишется один
  раз в `billing_events`: повторы и дубли ничего не меняют, событие старше текущего состояния
  (`subscriptions.provider_updated_at`) игнорируется, конец старой подписки не отменяет новую,
  особый тариф администратора (unlimited) провайдер не перезаписывает.
- Тариф в силе: `active`, `trialing`, `past_due` (провайдер ещё пытается списать). `paused` и
  `canceled` — бесплатный тариф. Отменённая подписка действует до конца оплаченного периода.
- Администратор не может вручную поменять тариф, который оплачивается через провайдера
  (иначе провайдер продолжит списывать деньги); добавки к лимитам работают как обычно.

## Управление через ИИ-ассистента

Setup-инструменты (`src/hub/billing-tools.ts`, реализация `src/billing/assistant.ts`):

| Инструмент | Что делает | Риск |
|---|---|---|
| `manyplug_plan` | Тариф, лимиты, расход за месяц, подписка (продление/отмена), тарифы с ценами | read |
| `manyplug_buy_plan` | Ссылка на `/app/billing?plan=…&interval=…`: там тариф уже выбран, пользователь подтверждает и платит | read |
| `manyplug_cancel_plan` | Отмена в конце периода (`undo: true` — вернуть) | dangerous, всегда с подтверждением |

Платёж всегда проходит на защищённой странице провайдера: ИИ получает только ссылку и не может
потратить деньги сам.

## Настройки (переменные окружения)

| Переменная | Значение |
|---|---|
| `BILLING_PROVIDER` | `none` (по умолчанию: тарифы назначает администратор по запросу), `paddle`, `stripe`, `test` |
| `<PROVIDER>_PRICE_<PLAN>_<MONTH\|YEAR>` | Цена провайдера для тарифа и периода, например `PADDLE_PRICE_PRO_YEAR=pri_01…`. Тариф без цены нельзя купить; админка → Система показывает, каких цен не хватает |
| `PADDLE_API_KEY`, `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET` | Ключи Paddle |
| `PADDLE_ENVIRONMENT` | `sandbox` (по умолчанию) или `production` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Ключи Stripe (`sk_test_…` — тестовый режим) |

`BILLING_PROVIDER=test` — встроенный тестовый провайдер: свои страницы «оплаты» и «портала»
(`/billing/test/*`), события идут тем же путём вебхуков. Можно проверить всё без ключей. На
production запрещён (сервер не стартует).

## Paddle: подключение

1. Paddle → **Catalog → Products**: продукты Personal, Pro, Business, у каждого две цены
   (месяц и год; суммы из `src/billing/plans.ts`: $5/$48, $12/$115, $29/$279). Id цен (`pri_…`)
   → `PADDLE_PRICE_PERSONAL_MONTH`, `PADDLE_PRICE_PERSONAL_YEAR` и т. д.
2. **Developer tools → Authentication**: API key (права на transactions, subscriptions, customers)
   → `PADDLE_API_KEY`; client-side token → `PADDLE_CLIENT_TOKEN`.
3. **Developer tools → Notifications**: адрес `https://<хаб>/billing/webhook/paddle`, события
   `subscription.*` → секрет → `PADDLE_WEBHOOK_SECRET`.
4. **Checkout → Checkout settings**: Default payment link `https://<хаб>/billing/paddle/checkout`
   (Paddle должен одобрить домен).
5. `BILLING_PROVIDER=paddle`, сначала `PADDLE_ENVIRONMENT=sandbox` (отдельный аккаунт
   sandbox-vendors.paddle.com со своими ключами), после проверки — ключи боевого аккаунта и
   `production`.

Оплата открывается на странице хаба `/billing/paddle/checkout`, которая запускает Paddle.js
(у неё своя CSP с доменами Paddle, остальные страницы остаются со строгой политикой).

## Stripe: подключение

1. Products → цены для каждого тарифа и периода → `STRIPE_PRICE_<PLAN>_<MONTH|YEAR>`.
2. Developers → API keys → `STRIPE_SECRET_KEY`.
3. Developers → Webhooks: `https://<хаб>/billing/webhook/stripe`, события
   `customer.subscription.created/updated/deleted/paused/resumed` → `STRIPE_WEBHOOK_SECRET`.
4. Settings → Billing → Customer portal: включить смену карты, счета и отмену.
5. `BILLING_PROVIDER=stripe`.

## Новый провайдер

Реализовать `BillingProvider` в `src/billing/providers/<id>.ts`, добавить настройки в
`src/billing/config.ts` и ветку в `createBillingProvider` (`providers/index.ts`), тесты по образцу
`test/billing-providers.test.ts`. Остальное (кабинет, ИИ, админка, лимиты) менять не нужно.
