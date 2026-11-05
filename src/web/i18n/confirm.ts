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
  'confirm.page.expires': 'expires',
  'confirm.page.runs': 'runs',
  'confirm.page.details': 'Request details',
  'confirm.page.allow': 'Allow',
  'confirm.page.deny': 'Deny',
  'confirm.page.cancel': 'Cancel the action',
  'confirm.page.back': 'All waiting actions',
  'confirm.page.wants': '{client} wants to',
  'confirm.page.askedAt': 'asked',
  'confirm.page.waiting': '{n} {n|action waits|actions wait} for your answer',
  'confirm.page.afterAllow': 'Allow, and the AI carries on by itself. Deny, and it is told you said no.',
  'confirm.how.title': 'How confirmations work',
  'confirm.how.ask': 'The AI asks first',
  'confirm.how.askText': 'Before a risky step, like sending an email, it stops and waits.',
  'confirm.how.see': 'You see the request here',
  'confirm.how.seeText': 'What exactly the AI wants to do, in which account and with what text.',
  'confirm.how.decide': 'You allow or deny',
  'confirm.how.decideText': 'One tap. Requests you do not answer expire on their own.',
  'confirm.try.title': 'Change when the AI asks you, right from the chat',
  'confirm.try.text':
    'Copy a request into your AI chat. Asking more often works at once; asking less often waits for your OK here.',
  'confirm.try.rules': 'Use Manyplug: what can you do without asking me first?',
  'confirm.try.stricter': 'Use Manyplug: ask me before any change in my accounts.',
  'confirm.tg.why': 'Answer requests from your phone, without opening this page.',
} as const;

export const confirmRu: Record<keyof typeof confirmEn, string> = {
  'confirm.page.sub': 'Действия, которые ИИ хочет сделать и ждёт вашего согласия.',
  'confirm.page.rules': 'Когда спрашивать',
  'confirm.page.noneTitle': 'Ничего не ждёт вашего ответа',
  'confirm.page.noneText':
    'Когда ИИ хочет сделать то, что по вашим правилам требует подтверждения, он останавливается и ждёт здесь, пока вы не разрешите или не откажете.',
  'confirm.page.now': 'Сейчас спрашивает: {rule}.',
  'confirm.page.change': 'Изменить',
  'confirm.page.expires': 'истекает',
  'confirm.page.runs': 'выполнится',
  'confirm.page.details': 'Подробности запроса',
  'confirm.page.allow': 'Разрешить',
  'confirm.page.deny': 'Отклонить',
  'confirm.page.cancel': 'Отменить действие',
  'confirm.page.back': 'Все ожидающие действия',
  'confirm.page.wants': '{client} хочет',
  'confirm.page.askedAt': 'запрос',
  'confirm.page.waiting': '{n} {n|действие ждёт|действия ждут|действий ждут} вашего ответа',
  'confirm.page.afterAllow':
    'После «Разрешить» ИИ продолжит сам. Если отклоните, ИИ узнает, что вы отказали.',
  'confirm.how.title': 'Как работают подтверждения',
  'confirm.how.ask': 'ИИ сначала спрашивает',
  'confirm.how.askText': 'Перед рискованным шагом, например отправкой письма, он останавливается и ждёт.',
  'confirm.how.see': 'Вы видите запрос здесь',
  'confirm.how.seeText': 'Что именно ИИ хочет сделать, в каком аккаунте и с каким текстом.',
  'confirm.how.decide': 'Вы разрешаете или отклоняете',
  'confirm.how.decideText': 'Одним нажатием. Запросы без ответа сами истекают.',
  'confirm.try.title': 'Настройте это прямо в чате с ИИ',
  'confirm.try.text':
    'Скопируйте запрос в чат с ИИ. Если ИИ должен спрашивать чаще, это включится сразу. Если реже — сначала подтвердите здесь.',
  'confirm.try.rules': 'Используй Manyplug: что ты можешь делать, не спрашивая меня?',
  'confirm.try.stricter': 'Используй Manyplug: спрашивай меня перед любым изменением в моих аккаунтах.',
  'confirm.tg.why': 'Отвечайте на запросы с телефона, не открывая эту страницу.',
};
