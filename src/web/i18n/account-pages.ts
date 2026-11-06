/**
 * The Security and Settings pages of the dashboard: the protection checklist, per-option hints
 * and the ready-made requests to paste into the AI app.
 */
export const accountPagesEn = {
  'security.score.title': 'Your protection',
  'security.score.strong': 'Strong',
  'security.score.good': 'Good',
  'security.score.basic': 'Basic',
  'security.score.done': '{done} of {total} done',
  'security.score.lead.basic':
    'Right now your password or Google account alone opens Manyplug and every account connected to it. Two minutes of setup closes that.',
  'security.score.lead.good': 'Two-step sign-in is on. Finish the rest so you never lock yourself out.',
  'security.score.lead.strong': 'Everything we recommend is on. Look here again when you change phones.',
  'security.step.totp': 'Authenticator app',
  'security.step.totpWhy': 'A code from your phone on every new sign-in.',
  'security.step.passkey': 'Passkey',
  'security.step.passkeyWhy': 'Sign in with a fingerprint or a glance. Phishing-proof.',
  'security.step.codes': 'Recovery codes',
  'security.step.codesWhy': 'Get back in if you lose your phone or key.',
  'security.step.vaultKey': 'Vault recovery key',
  'security.step.vaultKeyWhy': 'Optional: opens your private vault if you lose every browser.',
  'security.step.todo': 'Set up',
  'security.step.done': 'Done',
  'security.step.next': 'Start here',
  'security.ask.title': 'Ask your AI',
  'security.ask.hint': 'The AI can check these settings; only you can change them, here.',
  'security.ask.1': 'Check my Manyplug security and tell me what to set up next.',
  'security.ask.2': 'Which browsers are signed in to my Manyplug account?',

  'app.settings.sub': 'Your profile, confirmations, how the AI sees your tools, and where you are signed in.',
  'app.settings.profileHint': 'Your name and the language of this site.',
  'app.settings.signinHint': 'How you get into Manyplug.',
  'app.settings.securityCta': 'Two-step sign-in and passkeys',
  'app.settings.listingHint.auto': 'All tools while there are few, a short list once there are many.',
  'app.settings.listingHint.direct': 'Every tool is listed. Best with a handful of accounts.',
  'app.settings.listingHint.discovery':
    'The AI sees a short list and looks up the rest. Best with many accounts.',
  'app.settings.exposureHint.grouped': 'The AI names the account in each request: “search my Work mail”.',
  'app.settings.exposureHint.per_account': 'Every account gets its own tools. The list gets longer.',
  'app.settings.ask.title': 'Or change it from the chat',
  'app.settings.ask.hint': 'Takes effect the next time the AI app loads its tools.',
  'app.settings.ask.1': 'In Manyplug, give each of my accounts its own set of tools.',
  'app.settings.ask.2': 'In Manyplug, go back to automatic tool listing with one set of tools per service.',
  'app.settings.recommended': 'Recommended',
  'app.settings.confirm': 'Confirmations',
  'app.settings.confirmHint': 'Before risky actions, like sending a message, Manyplug asks you first.',
  'app.settings.confirmIn': 'Where you confirm',
  'app.settings.confirmIn.link': 'On a Manyplug page',
  'app.settings.confirmInHint.link':
    'The AI gives you a link, or you tap the button in Telegram. Safest: nothing in the chat can confirm for you.',
  'app.settings.confirmIn.chat': 'Right in the AI chat',
  'app.settings.confirmInHint.chat':
    'The AI asks you in the chat and goes ahead after your “yes”. Faster, but you trust the AI app to ask honestly.',
  'app.settings.confirmFloor':
    'Deleting accounts and changes that lower your protection always ask on a Manyplug page.',
  'app.settings.confirmRules': 'Which actions ask first',
  'app.flash.confirmInSaved': 'Saved. The next action that asks first will use this.',
  'app.settings.sessionsHint': 'Sign out of any browser you do not recognise.',
} as const;

export type AccountPagesKey = keyof typeof accountPagesEn;

export const accountPagesRu: Record<AccountPagesKey, string> = {
  'security.score.title': 'Ваша защита',
  'security.score.strong': 'Надёжная',
  'security.score.good': 'Хорошая',
  'security.score.basic': 'Базовая',
  'security.score.done': 'Сделано {done} из {total}',
  'security.score.lead.basic':
    'Сейчас один пароль или аккаунт Google открывает Manyplug и все подключённые к нему аккаунты. Пара минут настройки это исправит.',
  'security.score.lead.good':
    'Двухэтапный вход включён. Доделайте остальное, чтобы никогда не потерять доступ.',
  'security.score.lead.strong':
    'Всё, что мы советуем, включено. Загляните сюда снова, когда смените телефон.',
  'security.step.totp': 'Приложение-аутентификатор',
  'security.step.totpWhy': 'Код с телефона при каждом новом входе.',
  'security.step.passkey': 'Ключ доступа (passkey)',
  'security.step.passkeyWhy': 'Вход по отпечатку пальца или лицу. Не украсть через фишинг.',
  'security.step.codes': 'Коды восстановления',
  'security.step.codesWhy': 'Вернут доступ, если потеряете телефон или ключ.',
  'security.step.vaultKey': 'Ключ восстановления сейфа',
  'security.step.vaultKeyWhy': 'По желанию: откроет личный сейф, если потеряете все браузеры.',
  'security.step.todo': 'Настроить',
  'security.step.done': 'Готово',
  'security.step.next': 'Начните здесь',
  'security.ask.title': 'Спросите свой ИИ',
  'security.ask.hint': 'ИИ может проверить эти настройки, а менять их можете только вы, здесь.',
  'security.ask.1': 'Проверь защиту моего Manyplug и подскажи, что настроить дальше.',
  'security.ask.2': 'В каких браузерах выполнен вход в мой Manyplug?',

  'app.settings.sub': 'Профиль, подтверждения, то, как ИИ видит инструменты, и где выполнен вход.',
  'app.settings.profileHint': 'Ваше имя и язык этого сайта.',
  'app.settings.signinHint': 'Как вы входите в Manyplug.',
  'app.settings.securityCta': 'Двухэтапный вход и ключи доступа',
  'app.settings.listingHint.auto': 'Все инструменты, пока их мало, и короткий список, когда их много.',
  'app.settings.listingHint.direct': 'Видны все инструменты. Лучше всего при нескольких аккаунтах.',
  'app.settings.listingHint.discovery':
    'ИИ видит короткий список и находит остальное сам. Лучше всего при большом числе аккаунтов.',
  'app.settings.exposureHint.grouped': 'ИИ называет аккаунт в каждом запросе: «найди в рабочей почте».',
  'app.settings.exposureHint.per_account': 'У каждого аккаунта свои инструменты. Список становится длиннее.',
  'app.settings.ask.title': 'Или измените это из чата',
  'app.settings.ask.hint': 'Сработает, когда ИИ-приложение снова загрузит инструменты.',
  'app.settings.ask.1': 'В Manyplug дай каждому моему аккаунту свой набор инструментов.',
  'app.settings.ask.2':
    'В Manyplug верни автоматический список инструментов и один набор инструментов на сервис.',
  'app.settings.recommended': 'Рекомендуем',
  'app.settings.confirm': 'Подтверждения',
  'app.settings.confirmHint':
    'Перед рискованными действиями, например отправкой сообщения, Manyplug спрашивает вас.',
  'app.settings.confirmIn': 'Где вы подтверждаете',
  'app.settings.confirmIn.link': 'На странице Manyplug',
  'app.settings.confirmInHint.link':
    'ИИ даёт ссылку, или вы нажимаете кнопку в Telegram. Надёжнее всего: из чата за вас ничего не подтвердить.',
  'app.settings.confirmIn.chat': 'Прямо в чате с ИИ',
  'app.settings.confirmInHint.chat':
    'ИИ спрашивает вас в чате и выполняет действие после вашего «да». Быстрее, но вы доверяете ИИ-приложению честно спросить.',
  'app.settings.confirmFloor':
    'Удаление аккаунтов и изменения, которые ослабляют защиту, всегда подтверждаются на странице Manyplug.',
  'app.settings.confirmRules': 'Какие действия спрашивают',
  'app.flash.confirmInSaved': 'Сохранено. Следующее действие с подтверждением пойдёт так.',
  'app.settings.sessionsHint': 'Выйдите из браузеров, которые вы не узнаёте.',
};
