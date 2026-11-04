/**
 * Texts of one account's page in the dashboard (`/app/accounts/:id`).
 * `ru` must have exactly the keys of `en` (the type enforces it).
 */
export const accountEn = {
  'app.account.reauthTitle': 'The service asks you to sign in again.',
  'app.account.errorTitle': 'The last check failed.',
  'app.account.pausedNote': 'This account is paused: the AI does not see it until you resume it.',
  'app.account.tools': 'What the AI can do',
  'app.account.toolsSub': '{on} of {n} actions are on. Turn off what this account should never do.',
  'app.account.toolsSave': 'Save',
  'app.account.toolsHint': 'The AI stops seeing a turned-off action on its next request.',
  'app.account.rules': 'Access and confirmations',
  'app.account.rulesSub': 'For this account only. Leave “Default” to follow your general rules.',
  'app.account.allRules': 'All rules',
  'app.account.askHint': 'Name the account (“{label}”) when you have several of this service.',
  'app.account.details': 'Name and details',
  'app.account.aiName': 'The AI knows it as',
  'app.account.added': 'Connected',
  'app.account.calls': 'Recent activity',
  'app.account.allCalls': 'All activity of this account',
  'app.account.noCalls': 'The AI has not used this account yet.',
  'app.flash.toolsSaved': 'Saved: actions of “{label}” are updated.',
} as const;

export const accountRu: Record<keyof typeof accountEn, string> = {
  'app.account.reauthTitle': 'Сервис просит войти заново.',
  'app.account.errorTitle': 'Последняя проверка не прошла.',
  'app.account.pausedNote': 'Аккаунт на паузе: ИИ не видит его, пока вы его не включите.',
  'app.account.tools': 'Что может ИИ',
  'app.account.toolsSub': 'Включено {on} из {n}. Отключите то, что этот аккаунт делать не должен.',
  'app.account.toolsSave': 'Сохранить',
  'app.account.toolsHint': 'Отключённое действие пропадёт у ИИ при следующем запросе.',
  'app.account.rules': 'Доступ и подтверждения',
  'app.account.rulesSub': 'Только для этого аккаунта. «По умолчанию» — значит как в общих правилах.',
  'app.account.allRules': 'Все правила',
  'app.account.askHint': 'Если аккаунтов этого сервиса несколько, назовите нужный («{label}»).',
  'app.account.details': 'Название и данные',
  'app.account.aiName': 'Для ИИ называется',
  'app.account.added': 'Подключён',
  'app.account.calls': 'Последние действия',
  'app.account.allCalls': 'Вся активность аккаунта',
  'app.account.noCalls': 'ИИ ещё не обращался к этому аккаунту.',
  'app.flash.toolsSaved': 'Сохранено: действия «{label}» обновлены.',
};
