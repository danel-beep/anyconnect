/**
 * Texts of sign-in, sign-up and generic pages (errors, connect result).
 * `ru` must have exactly the keys of `en` (the type enforces it).
 */
export const authEn = {
  'login.google': 'Continue with Google',
  'login.withEmail': 'Sign in with email and password',
  'login.noAccount': 'New to AnyConnect?',
  'login.signupLink': 'Create an account',
  'login.fromApp': 'An AI app wants to connect to your AnyConnect. Sign in or create an account to continue.',
  'login.suspended': 'This account is suspended. If you think it is a mistake, write to support.',
  'login.refused.suspended': 'This account is suspended. If you think it is a mistake, write to support.',
  'login.refused.signups_closed':
    'There is no account for this Google address, and sign-up is closed on this hub.',
  'login.refused.email_unverified':
    'Google has not confirmed this email address. Try another Google account.',
  'login.externalFailed': 'Google sign-in did not complete. Try again.',
  'login.expired': 'The sign-in took too long or was opened in another browser. Try again.',
  'signup.title': 'Create an AnyConnect account',
  'signup.subtitle': 'Free plan, no card. It takes a minute.',
  'signup.termsA': 'By continuing you accept the',
  'signup.termsLink': 'terms of service',
  'signup.and': 'and the',
  'signup.privacyLink': 'privacy policy',
  'signup.closed': 'Sign-up is closed on this hub. Ask its owner for access.',
  'signup.noGoogle': 'Sign-up with Google is not configured on this hub yet.',
  'signup.haveAccount': 'Already have an account?',
  'signup.signInLink': 'Sign in',
  'connect.continue': 'Continue',
  'connect.addMore': 'Connect another',
  'error.notFound': 'Page not found',
  'error.notFoundText': 'The link may be outdated or mistyped.',
  'error.internal': 'Something went wrong on our side. Try again in a minute.',
  'error.forbidden': 'You do not have access to this page.',
  'admin.gate.title': 'Admin panel',
  'admin.gate.need2fa': 'Turn on two-step verification to use the admin panel.',
  'admin.gate.setup': 'Turn it on',
  'admin.gate.ip': 'The admin panel is not available from this network.',
} as const;

export type AuthKey = keyof typeof authEn;

export const authRu: Record<AuthKey, string> = {
  'login.google': 'Продолжить с Google',
  'login.withEmail': 'Войти по почте и паролю',
  'login.noAccount': 'Впервые в AnyConnect?',
  'login.signupLink': 'Создать аккаунт',
  'login.fromApp':
    'ИИ-приложение хочет подключиться к вашему AnyConnect. Войдите или создайте аккаунт, чтобы продолжить.',
  'login.suspended': 'Этот аккаунт заблокирован. Если это ошибка, напишите в поддержку.',
  'login.refused.suspended': 'Этот аккаунт заблокирован. Если это ошибка, напишите в поддержку.',
  'login.refused.signups_closed': 'Аккаунта с этим адресом Google нет, а регистрация на этом хабе закрыта.',
  'login.refused.email_unverified':
    'Google не подтвердил этот адрес почты. Попробуйте другой аккаунт Google.',
  'login.externalFailed': 'Вход через Google не завершился. Попробуйте ещё раз.',
  'login.expired': 'Вход занял слишком много времени или был открыт в другом браузере. Попробуйте ещё раз.',
  'signup.title': 'Создайте аккаунт AnyConnect',
  'signup.subtitle': 'Бесплатный тариф, без карты. Это займёт минуту.',
  'signup.termsA': 'Продолжая, вы принимаете',
  'signup.termsLink': 'условия использования',
  'signup.and': 'и',
  'signup.privacyLink': 'политику конфиденциальности',
  'signup.closed': 'Регистрация на этом хабе закрыта. Попросите доступ у владельца.',
  'signup.noGoogle': 'Регистрация через Google на этом хабе пока не настроена.',
  'signup.haveAccount': 'Уже есть аккаунт?',
  'signup.signInLink': 'Войти',
  'connect.continue': 'Продолжить',
  'connect.addMore': 'Подключить ещё',
  'error.notFound': 'Страница не найдена',
  'error.notFoundText': 'Возможно, ссылка устарела или в ней опечатка.',
  'error.internal': 'У нас что-то сломалось. Попробуйте через минуту.',
  'error.forbidden': 'У вас нет доступа к этой странице.',
  'admin.gate.title': 'Админ-панель',
  'admin.gate.need2fa': 'Чтобы пользоваться админ-панелью, включите двухэтапную проверку.',
  'admin.gate.setup': 'Включить',
  'admin.gate.ip': 'Админ-панель недоступна из этой сети.',
};
