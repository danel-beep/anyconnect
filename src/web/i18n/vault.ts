/**
 * The personal vault (`docs/VAULTS.md`): its card on /security, the banners in the dashboard and
 * the one-time recovery key page.
 */
export const vaultEn = {
  'vault.title': 'Private vault',
  'vault.hint':
    'Passwords and tokens of your personal accounts are locked with a key that only your browsers and AI apps hold. Manyplug staff, the admin panel and a copy of the database cannot open them.',
  'vault.open': 'Open in this browser',
  'vault.locked': 'Locked in this browser',
  'vault.lockedHint':
    'This browser was signed in after your vault was created. To use protected accounts here, open Security in a browser where you already use Manyplug and press Allow next to this code:',
  'vault.lockedExpired':
    'This browser’s request has expired. Ask again, then press Allow in a browser where you already use Manyplug.',
  'vault.askAgain': 'Ask again',
  'vault.lockedOr': 'Lost every other browser? Use your recovery key instead.',
  'vault.lockedNoRecovery':
    'If you no longer have any other browser, your AI apps still work. To manage protected accounts here, reconnect them; your data at each service is not affected.',
  'vault.requests': 'Browsers asking for access',
  'vault.requestsHint':
    'Allow only a browser you just signed in to yourself, and only if it shows the same code.',
  'vault.requested': 'asked {when}',
  'vault.allow': 'Allow',
  'vault.deny': 'Deny',
  'vault.devices': 'Browsers that can open it: {n}',
  'vault.recovery': 'Recovery key',
  'vault.optional': 'optional',
  'vault.recoveryHint':
    'Opens the vault if you lose every browser and AI app. Keep it in a password manager: Manyplug cannot show it again or restore it.',
  'vault.recoveryCreate': 'Create a recovery key',
  'vault.recoveryReplace': 'Create a new key',
  'vault.recoveryReplaceHint': 'The old key stops working.',
  'vault.recoveryNeedsOpen': 'Available in a browser where the vault is open.',
  'vault.recoveryInput': 'Recovery key',
  'vault.recoveryUse': 'Open with the recovery key',
  'vault.keyTitle': 'Save your recovery key',
  'vault.keyHint':
    'It is shown only once. Together with your sign-in it opens your protected accounts, so keep it private.',
  'vault.keyDone': 'I have saved it',
  'vault.flash.allowed': 'Browser allowed: it can now open your protected accounts.',
  'vault.flash.denied': 'Request declined.',
  'vault.flash.gone': 'That request is no longer waiting.',
  'vault.flash.unlocked': 'The vault is open in this browser now.',
  'vault.flash.wrongKey': 'This recovery key does not open your vault.',
  'vault.flash.asked': 'Request sent. Press Allow in a browser where you already use Manyplug.',
  'vault.flash.locked': 'Open the vault in this browser first.',
  'vault.banner.locked':
    'Protected accounts are locked in this browser. Allow it from a browser where you already use Manyplug.',
  'vault.banner.request': 'A browser asks to open your protected accounts.',
  'vault.banner.review': 'Review',
} as const;

export type VaultKey = keyof typeof vaultEn;

export const vaultRu: Record<VaultKey, string> = {
  'vault.title': 'Личный сейф',
  'vault.hint':
    'Пароли и токены ваших личных аккаунтов заперты ключом, который есть только у ваших браузеров и ИИ-приложений. Ни сотрудники Manyplug, ни админ-панель, ни копия базы данных открыть их не могут.',
  'vault.open': 'Открыт в этом браузере',
  'vault.locked': 'Закрыт в этом браузере',
  'vault.lockedHint':
    'В этом браузере вы вошли уже после создания сейфа. Чтобы пользоваться защищёнными аккаунтами здесь, откройте «Безопасность» в браузере, где вы уже работаете с Manyplug, и нажмите «Разрешить» рядом с этим кодом:',
  'vault.lockedExpired':
    'Запрос этого браузера устарел. Отправьте его ещё раз и нажмите «Разрешить» в браузере, где вы уже работаете с Manyplug.',
  'vault.askAgain': 'Запросить ещё раз',
  'vault.lockedOr': 'Других браузеров не осталось? Откройте сейф ключом восстановления.',
  'vault.lockedNoRecovery':
    'Если других браузеров не осталось, ИИ-приложения всё равно работают. Чтобы управлять защищёнными аккаунтами здесь, подключите их заново; данные в самих сервисах не пострадают.',
  'vault.requests': 'Браузеры просят доступ',
  'vault.requestsHint':
    'Разрешайте только браузер, в который вы сами только что вошли, и только если код совпадает.',
  'vault.requested': 'запрос {when}',
  'vault.allow': 'Разрешить',
  'vault.deny': 'Отклонить',
  'vault.devices': 'Браузеров с доступом: {n}',
  'vault.recovery': 'Ключ восстановления',
  'vault.optional': 'по желанию',
  'vault.recoveryHint':
    'Откроет сейф, если вы потеряете все браузеры и ИИ-приложения. Храните его в менеджере паролей: Manyplug не сможет показать его снова или восстановить.',
  'vault.recoveryCreate': 'Создать ключ восстановления',
  'vault.recoveryReplace': 'Создать новый ключ',
  'vault.recoveryReplaceHint': 'Старый ключ перестанет работать.',
  'vault.recoveryNeedsOpen': 'Доступно в браузере, где сейф открыт.',
  'vault.recoveryInput': 'Ключ восстановления',
  'vault.recoveryUse': 'Открыть ключом восстановления',
  'vault.keyTitle': 'Сохраните ключ восстановления',
  'vault.keyHint':
    'Он показывается только один раз. Вместе с вашим входом он открывает защищённые аккаунты, поэтому никому его не показывайте.',
  'vault.keyDone': 'Я сохранил ключ',
  'vault.flash.allowed': 'Браузер разрешён: теперь он открывает защищённые аккаунты.',
  'vault.flash.denied': 'Запрос отклонён.',
  'vault.flash.gone': 'Этот запрос больше не ждёт ответа.',
  'vault.flash.unlocked': 'Сейф открыт в этом браузере.',
  'vault.flash.wrongKey': 'Этот ключ не открывает ваш сейф.',
  'vault.flash.asked': 'Запрос отправлен. Нажмите «Разрешить» в браузере, где вы уже работаете с Manyplug.',
  'vault.flash.locked': 'Сначала откройте сейф в этом браузере.',
  'vault.banner.locked':
    'Защищённые аккаунты закрыты в этом браузере. Разрешите его из браузера, где вы уже работаете с Manyplug.',
  'vault.banner.request': 'Браузер просит открыть ваши защищённые аккаунты.',
  'vault.banner.review': 'Посмотреть',
};
