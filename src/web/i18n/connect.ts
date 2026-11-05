/**
 * Texts of connecting a service: the connect form, its setup guide, the result page and the page
 * shown when a service cannot be connected here yet. `ru` must have exactly the keys of `en`.
 */
export const connectEn = {
  'connect.reconnectTitle': 'Reconnect “{label}”',
  'connect.optional': '(optional)',
  'connect.formLabelHint':
    'Shown to you and the AI, e.g. “Work” or “Personal”. Handy when you connect several accounts.',
  'connect.howTo': 'How to connect',
  'connect.seeSteps': 'Steps',
  'connect.canDo': 'What the AI will be able to do',
  'connect.canDoSummary':
    '{n} {n|action|actions}: {read} only {read|reads|read}, {write} {write|makes|make} changes. You can turn any of them off later.',
  'connect.canDoReadOnly':
    '{n} {n|action|actions}, all of them only read. You can turn any of them off later.',
  'connect.canDoRules': 'Changes can wait for your OK.',
  'connect.rulesLink': 'Set up confirmations',
  'connect.aboutService': 'More about this service',
  'connect.keepAnyway': 'Keep the account anyway (I will fix it later)',
  'connect.testRejected':
    'The check with {service} failed: {message}. Check the details and try again. Nothing was saved.',
  'connect.doneWithProblem': 'Connected, but the check failed',
  'connect.tryAsking': 'Try asking your AI',
  'connect.aiFirst': 'First connect an AI app (Claude, ChatGPT or another) so it can use this account.',
  'connect.connectAi': 'Connect an AI app',
  'connect.accountSettings': 'Account settings',
  'connect.unavailableTitle': '{service} can’t be connected here yet',
  'connect.unavailableText':
    '{service} signs you in on its own site, and this server is not registered with {service} yet. The owner of the server can turn it on.',
  'connect.unavailableAdmin':
    '{service} signs users in on its own site, and this server has no {service} sign-in app yet. Add its client ID and secret in System settings, and the Connect button starts working for everyone.',
  'connect.unavailableAltTitle': 'You can still connect it.',
  'connect.unavailableAlt':
    'Use {alternative} with an app password: the AI gets the same mail, and setup takes about three minutes.',
  'connect.unavailableAltButton': 'Connect through {alternative}',
  'connect.unavailableSetup': 'Open System settings',
  'connect.unavailableBack': 'Back to services',
  'guide.variants': 'Steps for your provider',
  'guide.detected': 'Your provider',
  'guide.minutes': 'About {minutes} min',
  'guide.needs': 'You need',
  'guide.steps': 'Steps',
  'guide.fills': 'Goes into the field',
  'guide.problems': 'If something goes wrong',
} as const;

export const connectRu: Record<keyof typeof connectEn, string> = {
  'connect.reconnectTitle': 'Переподключение «{label}»',
  'connect.optional': '(необязательно)',
  'connect.formLabelHint':
    'Его видите вы и ИИ, например «Работа» или «Личное». Удобно, когда аккаунтов несколько.',
  'connect.howTo': 'Как подключить',
  'connect.seeSteps': 'Как получить',
  'connect.canDo': 'Что сможет ИИ',
  'connect.canDoSummary':
    '{n} {n|действие|действия|действий}: {read} только {read|читает|читают|читают}, {write} {write|вносит|вносят|вносят} изменения. Любое можно отключить позже.',
  'connect.canDoReadOnly':
    '{n} {n|действие|действия|действий}, все только читают. Любое можно отключить позже.',
  'connect.canDoRules': 'Изменения могут ждать вашего «да».',
  'connect.rulesLink': 'Настроить подтверждения',
  'connect.aboutService': 'Подробнее о сервисе',
  'connect.keepAnyway': 'Всё равно сохранить аккаунт (исправлю позже)',
  'connect.testRejected':
    '{service} не принял эти данные: {message}. Проверьте их и попробуйте ещё раз. Ничего не сохранено.',
  'connect.doneWithProblem': 'Подключено, но проверка не прошла',
  'connect.tryAsking': 'Попробуйте спросить ИИ',
  'connect.aiFirst':
    'Сначала подключите ИИ-приложение (Claude, ChatGPT или другое), чтобы оно могло работать с аккаунтом.',
  'connect.connectAi': 'Подключить ИИ-приложение',
  'connect.accountSettings': 'Настройки аккаунта',
  'connect.unavailableTitle': '{service} здесь пока не подключить',
  'connect.unavailableText':
    'Вход в {service} идёт на сайте самого сервиса, а этот сервер ещё не зарегистрирован в {service}. Владелец сервера может это включить.',
  'connect.unavailableAdmin':
    'Вход в {service} идёт на сайте самого сервиса, а у этого сервера ещё нет приложения для входа в {service}. Добавьте его client ID и секрет в «Системе», и кнопка «Подключить» заработает у всех.',
  'connect.unavailableAltTitle': 'Подключить всё равно можно.',
  'connect.unavailableAlt':
    'Как «{alternative}» с паролем приложения: ИИ получит ту же почту, настройка займёт около трёх минут.',
  'connect.unavailableAltButton': 'Подключить как «{alternative}»',
  'connect.unavailableSetup': 'Открыть «Систему»',
  'connect.unavailableBack': 'К сервисам',
  'guide.variants': 'Шаги для вашего почтового сервиса',
  'guide.detected': 'Ваш сервис',
  'guide.minutes': 'Около {minutes} мин',
  'guide.needs': 'Понадобится',
  'guide.steps': 'Шаги',
  'guide.fills': 'Вставьте в поле',
  'guide.problems': 'Если что-то не получилось',
};
