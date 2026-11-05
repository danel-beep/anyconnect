/**
 * Texts of the "Plan and limits" page (`/app/billing`) that its summary and invite cards add.
 * `ru` must have exactly the keys of `en` (the type enforces it).
 */
export const planPageEn = {
  'plan.hero.label': 'Your plan',
  'plan.hero.trial': '{plan} trial · {n} {n|day|days} left',
  'plan.hero.trialText':
    'Until {date} you have everything in {plan}, free and without a card. Then you stay on Free on your own: nothing is charged.',
  'plan.hero.compare': 'Compare plans',
  'plan.hero.next': 'What happens next',
  'plan.invite.message':
    'I use Manyplug to connect my AI (ChatGPT, Claude) to my mail, calendar and other apps. Try it here: {link}',
  'plan.invite.copy': 'Copy message',
} as const;

export const planPageRu: Record<keyof typeof planPageEn, string> = {
  'plan.hero.label': 'Ваш тариф',
  'plan.hero.trial': 'Пробный «{plan}» · осталось {n} {n|день|дня|дней}',
  'plan.hero.trialText':
    'До {date} у вас всё из тарифа «{plan}» — бесплатно и без карты. Потом вы просто останетесь на бесплатном тарифе: ничего не спишется.',
  'plan.hero.compare': 'Сравнить тарифы',
  'plan.hero.next': 'Что будет дальше',
  'plan.invite.message':
    'Я подключаю свой ИИ (ChatGPT, Claude) к почте, календарю и другим приложениям через Manyplug. Попробуй: {link}',
  'plan.invite.copy': 'Скопировать сообщение',
};
