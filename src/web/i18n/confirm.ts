/**
 * Texts of the confirmations pages in the dashboard (`/confirm`, `/confirm/:id`).
 * `ru` must have exactly the keys of `en` (the type enforces it).
 */
export const confirmEn = {
  'confirm.page.sub': 'Actions the AI wants to do that wait for your OK.',
  'confirm.page.rules': 'When to ask',
  'confirm.page.noneTitle': 'Nothing is waiting for you',
  'confirm.page.noneText':
    'When the AI wants to do something your rules mark for confirmation, it stops and waits here until you allow or deny it.',
  'confirm.page.now': 'Asking now: {rule}.',
  'confirm.page.change': 'Change',
  'confirm.page.asked': 'asked by {client}',
  'confirm.page.expires': 'expires',
  'confirm.page.runs': 'runs',
  'confirm.page.details': 'What the AI passed',
  'confirm.page.allow': 'Allow',
  'confirm.page.deny': 'Deny',
  'confirm.page.cancel': 'Cancel the action',
  'confirm.page.back': 'All waiting actions',
} as const;

export const confirmRu: Record<keyof typeof confirmEn, string> = {
  'confirm.page.sub': 'Действия, которые ИИ хочет сделать и ждёт вашего согласия.',
  'confirm.page.rules': 'Когда спрашивать',
  'confirm.page.noneTitle': 'Ничего не ждёт вашего ответа',
  'confirm.page.noneText':
    'Когда ИИ хочет сделать то, что по вашим правилам требует подтверждения, он останавливается и ждёт здесь, пока вы не разрешите или не откажете.',
  'confirm.page.now': 'Сейчас спрашивает: {rule}.',
  'confirm.page.change': 'Изменить',
  'confirm.page.asked': 'запрос от {client}',
  'confirm.page.expires': 'истекает',
  'confirm.page.runs': 'выполнится',
  'confirm.page.details': 'Что передал ИИ',
  'confirm.page.allow': 'Разрешить',
  'confirm.page.deny': 'Отклонить',
  'confirm.page.cancel': 'Отменить действие',
  'confirm.page.back': 'Все ожидающие действия',
};
