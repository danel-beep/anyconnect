/**
 * Texts of the messenger login page (`/connect/messenger/<account>`): QR code, code from the
 * messenger, cloud password. `ru` must have exactly the keys of `en`.
 */
export const messengerLoginEn = {
  'mlogin.title': 'Log in to {service}',
  'mlogin.intro':
    'Log in once and {brand} keeps the session in the cloud, encrypted. Codes and passwords are typed only on this page, never in the AI chat.',
  'mlogin.online': 'Connected as {identity}.',
  'mlogin.onlinePlain': 'This account is connected.',
  'mlogin.status': 'Status: {status}',
  'mlogin.again': 'You can log in again, for example after ending the session on your phone.',
  'mlogin.qr': 'Log in with a QR code',
  'mlogin.qrHint': 'Recommended: nothing to type.',
  'mlogin.phone': 'Or with your phone number',
  'mlogin.phoneLabel': 'Phone number in international format',
  'mlogin.phoneSubmit': 'Send me a code',
  'mlogin.scanTitle': 'Scan the QR code',
  'mlogin.scanTelegram':
    'In Telegram on your phone open Settings → Devices → Link Desktop Device and point the camera at the code. The code refreshes by itself.',
  'mlogin.scanWait': 'Preparing the code…',
  'mlogin.qrLabel': 'QR code to log in',
  'mlogin.codeTitle': 'Enter the code',
  'mlogin.codeHint': 'Telegram sent a login code to your Telegram app (the chat "Telegram"), or by SMS.',
  'mlogin.codeLabel': 'Code',
  'mlogin.passwordTitle': 'Enter your cloud password',
  'mlogin.passwordHint': 'Your account has two-step verification. Password hint: {hint}',
  'mlogin.passwordHintNone': 'Your account has two-step verification.',
  'mlogin.passwordLabel': 'Cloud password',
  'mlogin.submit': 'Continue',
  'mlogin.cancel': 'Cancel',
  'mlogin.doneTitle': 'Logged in',
  'mlogin.done': 'Done: {identity} is connected. Chats are loading now; the AI sees them in a minute.',
  'mlogin.doneNoIdentity':
    'Done: the account is connected. Chats are loading now; the AI sees them in a minute.',
  'mlogin.devices':
    'The session shows up in Telegram under Settings → Devices as "{brand}". You can end it there at any time.',
  'mlogin.twoStep':
    'Tip: turn on Two-Step Verification in Telegram (Settings → Privacy and Security). Then a login code alone is not enough to get into your account.',
  'mlogin.toServices': 'To services',
  'mlogin.failedTitle': 'The login did not finish',
  'mlogin.retry': 'Try again',
  'mlogin.expired': 'This login has expired. Start again.',
  'mlogin.unavailable':
    'Logging in to this messenger is not available on this server yet: the messenger gateway or its API keys are not set up. The administrator turns it on (see docs/MESSENGERS.md).',
  'mlogin.unavailableTry': 'The messenger gateway is not answering right now. Try again in a minute.',
};

export const messengerLoginRu: Record<keyof typeof messengerLoginEn, string> = {
  'mlogin.title': 'Вход в {service}',
  'mlogin.intro':
    'Войдите один раз, и {brand} будет держать сессию в облаке в зашифрованном виде. Коды и пароли вводятся только на этой странице и никогда в чате с ИИ.',
  'mlogin.online': 'Подключён как {identity}.',
  'mlogin.onlinePlain': 'Аккаунт подключён.',
  'mlogin.status': 'Состояние: {status}',
  'mlogin.again': 'Можно войти заново, например после того как сессию завершили на телефоне.',
  'mlogin.qr': 'Войти по QR-коду',
  'mlogin.qrHint': 'Рекомендуем: ничего не нужно вводить.',
  'mlogin.phone': 'Или по номеру телефона',
  'mlogin.phoneLabel': 'Номер в международном формате',
  'mlogin.phoneSubmit': 'Прислать код',
  'mlogin.scanTitle': 'Отсканируйте QR-код',
  'mlogin.scanTelegram':
    'В Telegram на телефоне откройте Настройки → Устройства → Подключить устройство и наведите камеру на код. Код обновляется сам.',
  'mlogin.scanWait': 'Готовим код…',
  'mlogin.qrLabel': 'QR-код для входа',
  'mlogin.codeTitle': 'Введите код',
  'mlogin.codeHint': 'Telegram прислал код входа в приложение Telegram (чат «Telegram») или по SMS.',
  'mlogin.codeLabel': 'Код',
  'mlogin.passwordTitle': 'Введите облачный пароль',
  'mlogin.passwordHint': 'У аккаунта включена двухэтапная проверка. Подсказка: {hint}',
  'mlogin.passwordHintNone': 'У аккаунта включена двухэтапная проверка.',
  'mlogin.passwordLabel': 'Облачный пароль',
  'mlogin.submit': 'Продолжить',
  'mlogin.cancel': 'Отменить',
  'mlogin.doneTitle': 'Вход выполнен',
  'mlogin.done': 'Готово: {identity} подключён. Чаты загружаются, через минуту ИИ их увидит.',
  'mlogin.doneNoIdentity': 'Готово: аккаунт подключён. Чаты загружаются, через минуту ИИ их увидит.',
  'mlogin.devices':
    'Сессия видна в Telegram в Настройки → Устройства как «{brand}». Там её можно завершить в любой момент.',
  'mlogin.twoStep':
    'Совет: включите в Telegram двухэтапную проверку (Настройки → Конфиденциальность). Тогда одного кода для входа в аккаунт будет мало.',
  'mlogin.toServices': 'К сервисам',
  'mlogin.failedTitle': 'Вход не завершён',
  'mlogin.retry': 'Попробовать снова',
  'mlogin.expired': 'Время на вход истекло. Начните заново.',
  'mlogin.unavailable':
    'Вход в этот мессенджер на этом сервере пока недоступен: не настроен шлюз мессенджеров или его ключи API. Его включает администратор (см. docs/MESSENGERS.md).',
  'mlogin.unavailableTry': 'Шлюз мессенджеров сейчас не отвечает. Попробуйте через минуту.',
};
