/**
 * Texts of the hub's own emails (billing notices, referrals). `ru` must have exactly the keys of
 * `en` (the type enforces it). Plain sentences: they are rendered as text and as simple HTML.
 */
export const emailEn = {
  'email.footer': 'You get this email because you have a {brand} account. Manage your plan: {url}',
  'email.hello': 'Hi{name},',
  'email.signoff': '— The {brand} team',

  'email.trialEnding.subject': 'Your {brand} Pro trial ends in {n} {n|day|days}',
  'email.trialEnding.body':
    'Your free Pro trial ends on {date}. After that your plan stays free and nothing is charged: you keep {actions} actions a month for the first weeks, then {after} a month, and up to {accounts} connected accounts.',
  'email.trialEnding.keep':
    'To keep Pro limits (and all your connected accounts), pick a plan before the trial ends.',
  'email.trialEnding.cta': 'See plans',

  'email.limitReached.subject': 'You have used all {limit} {brand} actions this month',
  'email.limitReached.body':
    'Your AI assistant reached the {limit} actions included in your {plan} plan this month. Calls to your services are paused until {date}; managing the hub from the chat still works.',
  'email.limitReached.upgrade': 'To continue right away, move to a bigger plan.',
  'email.limitReached.cta': 'Raise my limit',

  'email.paymentFailed.subject': 'Your {brand} payment did not go through',
  'email.paymentFailed.body':
    'We could not charge your card for the {plan} plan. Your plan keeps working for now; the payment provider will retry over the next days.',
  'email.paymentFailed.fix': 'Please check or update your payment method to keep the plan.',
  'email.paymentFailed.cta': 'Update payment method',

  'email.referral.subject': 'You got a month of {brand} Pro',
  'email.referral.body':
    'Someone you invited just started a paid plan. Thank you! Your workspace gets Pro until {date}.',
  'email.referral.bodyLimits':
    'Someone you invited just started a paid plan. Thank you! Your workspace gets Pro limits until {date}.',
  'email.referral.cta': 'Open my plan',
} as const;

export type EmailKey = keyof typeof emailEn;

export const emailRu: Record<EmailKey, string> = {
  'email.footer': 'Это письмо пришло, потому что у вас есть аккаунт {brand}. Управлять тарифом: {url}',
  'email.hello': 'Здравствуйте{name}!',
  'email.signoff': '— Команда {brand}',

  'email.trialEnding.subject': 'Пробный период Pro в {brand} закончится через {n} {n|день|дня|дней}',
  'email.trialEnding.body':
    'Бесплатный пробный период Pro закончится {date}. Дальше тариф остаётся бесплатным, ничего не списывается: первые недели у вас будет {actions} действий в месяц, затем {after} в месяц и до {accounts} подключённых аккаунтов.',
  'email.trialEnding.keep':
    'Чтобы сохранить лимиты Pro (и все подключённые аккаунты), выберите тариф до конца пробного периода.',
  'email.trialEnding.cta': 'Посмотреть тарифы',

  'email.limitReached.subject': 'В этом месяце использованы все {limit} действий {brand}',
  'email.limitReached.body':
    'AI-ассистент израсходовал {limit} действий, которые входят в тариф «{plan}» в этом месяце. Обращения к сервисам приостановлены до {date}; управлять хабом из чата по-прежнему можно.',
  'email.limitReached.upgrade': 'Чтобы продолжить сразу, перейдите на тариф побольше.',
  'email.limitReached.cta': 'Увеличить лимит',

  'email.paymentFailed.subject': 'Оплата {brand} не прошла',
  'email.paymentFailed.body':
    'Не получилось списать оплату за тариф «{plan}». Пока тариф работает; платёжный сервис повторит попытку в ближайшие дни.',
  'email.paymentFailed.fix': 'Проверьте или обновите способ оплаты, чтобы сохранить тариф.',
  'email.paymentFailed.cta': 'Обновить способ оплаты',

  'email.referral.subject': 'Вам месяц {brand} Pro',
  'email.referral.body':
    'Человек, которого вы пригласили, оформил платный тариф. Спасибо! Ваше пространство получает Pro до {date}.',
  'email.referral.bodyLimits':
    'Человек, которого вы пригласили, оформил платный тариф. Спасибо! Ваше пространство получает лимиты Pro до {date}.',
  'email.referral.cta': 'Открыть тариф',
};
