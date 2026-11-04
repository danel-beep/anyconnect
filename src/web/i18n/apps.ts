/**
 * Texts of an AI app's own page (`/app/apps/:id`).
 * `ru` must have exactly the keys of `en` (the type enforces it).
 */
export const appsEn = {
  'aiapp.kind.oauth': 'Signs in with your account',
  'aiapp.kind.api_token': 'Personal token',
  'aiapp.firstSeen': 'first connected {date}',
  'aiapp.neverUsed': 'not used yet',
  'aiapp.connections': 'Connections',
  'aiapp.connectionsSub': 'Each sign-in or token this app uses now.',
  'aiapp.notConnected':
    'Not connected now. It gets access again when you add the hub’s address in the app and sign in.',
  'aiapp.signIn': 'Sign-in',
  'aiapp.noSignIns': 'No app has signed in yet. Apps with a personal token are under Personal tokens.',
  'aiapp.token': 'Token',
  'aiapp.main': 'Main address',
  'aiapp.rules': 'What it may do',
  'aiapp.rulesSub': 'For this app on every account. A rule for an account is stricter or looser on top.',
  'aiapp.allRules': 'All rules',
  'aiapp.name': 'Name',
  'aiapp.nameHint': 'Only for you, and for rules and the activity log.',
  'aiapp.rename': 'Rename',
  'aiapp.calls': 'Recent actions',
  'aiapp.noCalls': 'This app has not done anything yet.',
  'aiapp.disconnect': 'Disconnect',
  'aiapp.disconnectText':
    'Ends every sign-in and token of this app. Its rules stay, in case you connect it again.',
  'aiapp.disconnectConfirm': 'Disconnect {name}? It loses access until it connects again.',
  'aiapp.forget': 'Remove this app',
  'aiapp.forgetText': 'It is not connected. Removing it also removes its rules.',
  'aiapp.forgetConfirm': 'Remove {name} and its rules?',
  'aiapp.chat': 'You can also ask your AI: “Which apps use my hub?” or “Disconnect the old Cursor”.',
  'aiapp.open': 'Open',
  'aiapp.flash.renamed': 'Renamed.',
  'aiapp.flash.disconnected': '{name} is disconnected.',
  'aiapp.flash.removed': 'App removed.',
} as const;

export type AppsKey = keyof typeof appsEn;

export const appsRu: Record<AppsKey, string> = {
  'aiapp.kind.oauth': 'Входит под вашей учётной записью',
  'aiapp.kind.api_token': 'Личный токен',
  'aiapp.firstSeen': 'подключено впервые {date}',
  'aiapp.neverUsed': 'ещё не использовалось',
  'aiapp.connections': 'Подключения',
  'aiapp.connectionsSub': 'Каждый вход или токен, которым приложение пользуется сейчас.',
  'aiapp.notConnected':
    'Сейчас не подключено. Доступ вернётся, когда вы добавите адрес хаба в приложении и войдёте.',
  'aiapp.signIn': 'Вход',
  'aiapp.noSignIns':
    'Ни одно приложение ещё не вошло. Приложения с личным токеном — в разделе «Личные токены».',
  'aiapp.token': 'Токен',
  'aiapp.main': 'Основной адрес',
  'aiapp.rules': 'Что ему можно',
  'aiapp.rulesSub': 'Для этого приложения на всех аккаунтах. Правило для аккаунта может его уточнить.',
  'aiapp.allRules': 'Все правила',
  'aiapp.name': 'Название',
  'aiapp.nameHint': 'Только для вас, правил и журнала действий.',
  'aiapp.rename': 'Переименовать',
  'aiapp.calls': 'Последние действия',
  'aiapp.noCalls': 'Это приложение пока ничего не делало.',
  'aiapp.disconnect': 'Отключить',
  'aiapp.disconnectText':
    'Завершает все входы и токены этого приложения. Правила останутся на случай, если вы подключите его снова.',
  'aiapp.disconnectConfirm': 'Отключить {name}? Оно потеряет доступ, пока не подключится снова.',
  'aiapp.forget': 'Удалить приложение',
  'aiapp.forgetText': 'Оно не подключено. Вместе с ним удалятся и его правила.',
  'aiapp.forgetConfirm': 'Удалить {name} и его правила?',
  'aiapp.chat':
    'Можно и спросить свой ИИ: «Какие приложения подключены к хабу?» или «Отключи старый Cursor».',
  'aiapp.open': 'Открыть',
  'aiapp.flash.renamed': 'Название сохранено.',
  'aiapp.flash.disconnected': '{name} отключено.',
  'aiapp.flash.removed': 'Приложение удалено.',
};
