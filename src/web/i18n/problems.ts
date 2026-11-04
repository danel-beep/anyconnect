/**
 * Plain-language reasons for a failed connection check or call (see `web/problems.ts`), used on
 * account rows, account pages, the activity log and the connect form.
 * `ru` must have exactly the keys of `en` (the type enforces it).
 */
export const problemsEn = {
  'problem.unreachable': 'Could not reach {host}. Check the server address, or try again in a few minutes.',
  'problem.unreachableHost': 'the service',
  'problem.signin': 'The service no longer accepts the saved sign-in: it expired or was revoked.',
  'problem.denied': 'The service refused access. Check the permissions of the account or the key.',
  'problem.busy': 'The service asked to slow down. Try again in a minute.',
  'problem.service': 'The service had a problem on its side. Try again later.',
  'problem.unfinished': 'Connecting was not finished.',
  'problem.other': 'The last check failed.',
  'problem.otherSaid': 'The last check failed: {message}.',
  'problem.details': 'Details',
  'problem.call.denied': 'Your rules do not allow this action.',
  'problem.call.declined': 'Not allowed: declined, cancelled or expired before anyone said yes.',
  'problem.call.quota': 'The plan limit for this month is reached.',
  'problem.call.timeout': 'The service did not answer in time.',
  'problem.call.invalid_input': 'The service did not accept what the AI sent: {message}.',
  'problem.call.invalid_inputBare': 'The service did not accept what the AI sent.',
  'problem.call.not_found': 'Not found on the service: {message}.',
  'problem.call.not_foundBare': 'Not found on the service.',
  'problem.checkAgain': 'Check again',
  'problem.form.unreachable':
    'Could not reach {host}. Check the server address and port, then try again. Nothing was saved.',
  'problem.form.signin':
    '{service} did not accept these details ({message}). Check them and try again. Nothing was saved.',
  'problem.form.denied':
    '{service} accepted the key but refused access ({message}). Give the key the permissions listed in the steps, then try again. Nothing was saved.',
  'problem.form.busy': '{service} asked to slow down. Wait a minute and try again. Nothing was saved.',
  'problem.form.service':
    '{service} had a problem on its side ({message}). Try again later. Nothing was saved.',
};

export const problemsRu: Record<keyof typeof problemsEn, string> = {
  'problem.unreachable':
    'Не удалось связаться с {host}. Проверьте адрес сервера или попробуйте через несколько минут.',
  'problem.unreachableHost': 'сервисом',
  'problem.signin': 'Сервис больше не принимает сохранённый вход: срок истёк или доступ отозван.',
  'problem.denied': 'Сервис отказал в доступе. Проверьте права аккаунта или ключа.',
  'problem.busy': 'Сервис просит не спешить. Попробуйте через минуту.',
  'problem.service': 'У сервиса сбой на его стороне. Попробуйте позже.',
  'problem.unfinished': 'Подключение не было завершено.',
  'problem.other': 'Последняя проверка не прошла.',
  'problem.otherSaid': 'Последняя проверка не прошла: {message}.',
  'problem.details': 'Подробности',
  'problem.call.denied': 'Ваши правила не разрешают это действие.',
  'problem.call.declined': 'Не разрешено: отклонили, отменили или время вышло.',
  'problem.call.quota': 'Лимит тарифа на этот месяц исчерпан.',
  'problem.call.timeout': 'Сервис не ответил вовремя.',
  'problem.call.invalid_input': 'Сервис не принял то, что прислал ИИ: {message}.',
  'problem.call.invalid_inputBare': 'Сервис не принял то, что прислал ИИ.',
  'problem.call.not_found': 'Не найдено в сервисе: {message}.',
  'problem.call.not_foundBare': 'Не найдено в сервисе.',
  'problem.checkAgain': 'Проверить снова',
  'problem.form.unreachable':
    'Не удалось связаться с {host}. Проверьте адрес и порт сервера и попробуйте ещё раз. Ничего не сохранено.',
  'problem.form.signin':
    '{service} не принял эти данные ({message}). Проверьте их и попробуйте ещё раз. Ничего не сохранено.',
  'problem.form.denied':
    '{service} принял ключ, но отказал в доступе ({message}). Дайте ключу права из инструкции и попробуйте ещё раз. Ничего не сохранено.',
  'problem.form.busy':
    '{service} просит не спешить. Подождите минуту и попробуйте ещё раз. Ничего не сохранено.',
  'problem.form.service':
    'У {service} сбой на его стороне ({message}). Попробуйте позже. Ничего не сохранено.',
};
