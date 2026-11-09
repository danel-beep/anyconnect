/**
 * Words of other languages for tool search. Tools are described in English, but people (and
 * their AI) often search in their own language: "непрочитанные письма" should find `gmail_search`.
 *
 * Each language is a list of word beginnings with the English words they mean; a query word takes
 * the longest beginning that matches, so word forms ("письмо", "письма", "письмами") need one entry.
 * A new language is one more entry in `LEXICONS`, with its filler words in `stop`.
 */

interface Lexicon {
  /** Which words this lexicon handles. */
  script: RegExp;
  /** Filler words, dropped like English ones. */
  stop: ReadonlySet<string>;
  /** [word beginning, English words], any order; matched longest first. */
  words: ReadonlyArray<readonly [prefix: string, english: string]>;
}

const RUSSIAN: Lexicon = {
  script: /[а-яё]/,
  stop: new Set(
    (
      'и в во на с со к ко о об у из за по для от до про а но или же бы ли ну там тут ' +
      'я ты вы мы он она они мне мой моя мои мое моё мою моих меня мной тебе твой ваш наш ' +
      'что какие какой какая какое есть это этот эта эту эти все всё весь вся всех ' +
      'пожалуйста можно нужно надо последнее последний последние ещё еще один одна одну другой другую'
    ).split(' '),
  ),
  words: [
    // mail
    ['письм', 'email'],
    ['почт', 'mail'],
    ['имейл', 'email'],
    ['джимейл', 'gmail'],
    ['гмейл', 'gmail'],
    ['ящик', 'inbox'],
    ['входящ', 'inbox'],
    ['непрочит', 'unread'],
    ['прочит', 'read'],
    ['прочти', 'read'],
    ['читать', 'read'],
    ['черновик', 'draft'],
    ['перешли', 'forward'],
    ['пересла', 'forward'],
    ['вложени', 'attachment'],
    ['скача', 'download'],
    ['скачать', 'download'],
    ['спам', 'spam'],
    ['корзин', 'trash'],
    ['архив', 'archive'],
    ['рассылк', 'newsletter'],
    ['метк', 'label'],
    ['ярлык', 'label'],
    // messages
    ['сообщ', 'message'],
    ['смс', 'message'],
    ['чат', 'chat'],
    ['переписк', 'chat'],
    ['диалог', 'chat'],
    ['написал', 'wrote'],
    ['пишет', 'wrote'],
    ['напиш', 'send'],
    ['написать', 'send'],
    ['отправ', 'send'],
    ['пошли', 'send'],
    ['послать', 'send'],
    ['ответ', 'reply'],
    ['ответил', 'answer'],
    ['телеграм', 'telegram'],
    ['ватсап', 'whatsapp'],
    ['вотсап', 'whatsapp'],
    ['слак', 'slack'],
    // calendar
    ['встреч', 'meeting'],
    ['календар', 'calendar'],
    ['событи', 'event'],
    ['мероприят', 'event'],
    ['созвон', 'call'],
    ['звонок', 'call'],
    ['звонк', 'call'],
    ['расписани', 'schedule'],
    ['запис', 'appointment'],
    ['перенес', 'reschedule'],
    ['перенос', 'reschedule'],
    ['отмен', 'cancel'],
    ['свобод', 'free'],
    ['занят', 'busy'],
    ['сегодня', 'today'],
    ['завтра', 'tomorrow'],
    ['недел', 'week'],
    // tasks, files, contacts
    ['задач', 'task'],
    ['напомин', 'reminder'],
    ['напомни', 'remind'],
    ['заметк', 'note'],
    ['страниц', 'page'],
    ['файл', 'file'],
    ['документ', 'document'],
    ['папк', 'folder'],
    ['диск', 'drive'],
    ['таблиц', 'spreadsheet'],
    ['строк', 'row'],
    ['контакт', 'contact'],
    ['человек', 'person'],
    ['ноушн', 'notion'],
    // money, work tools
    ['платеж', 'payment'],
    ['платёж', 'payment'],
    ['оплат', 'payment'],
    ['заплатил', 'paid'],
    ['счет', 'invoice'],
    ['счёт', 'invoice'],
    ['деньг', 'money'],
    ['баланс', 'balance'],
    ['возврат', 'refund'],
    ['клиент', 'customer'],
    ['сделк', 'deal'],
    ['лид', 'lead'],
    ['тикет', 'ticket'],
    ['обращени', 'ticket'],
    ['ошибк', 'error'],
    ['деплой', 'deploy'],
    ['пулреквест', 'pull request'],
    // verbs
    ['найд', 'find'],
    ['найти', 'find'],
    ['поиск', 'search'],
    ['ищи', 'search'],
    ['искать', 'search'],
    ['покаж', 'show'],
    ['показ', 'show'],
    ['список', 'list'],
    ['созда', 'create'],
    ['добав', 'add'],
    ['измен', 'change'],
    ['обнов', 'update'],
    ['удал', 'delete'],
    ['пометь', 'mark'],
    ['отмет', 'mark'],
    ['нов', 'new'],
    // hub setup
    ['подключ', 'connect account'],
    ['аккаунт', 'account'],
    ['учетн', 'account'],
    ['учётн', 'account'],
    ['триггер', 'trigger'],
    ['автоматиз', 'automation'],
    ['когда', 'when'],
    ['придет', 'arrives'],
    ['придёт', 'arrives'],
    ['приход', 'arrives'],
    ['пришл', 'arrives'],
    ['поступ', 'arrives'],
    ['уведом', 'notify'],
    ['оповест', 'notify'],
    ['правил', 'rule'],
    ['доступ', 'permission'],
    ['разреш', 'allow'],
    ['спрашива', 'ask'],
    ['подтвержд', 'confirm'],
    ['тариф', 'plan'],
    ['подписк', 'plan'],
    ['ключ', 'key'],
  ],
};

const LEXICONS: readonly Lexicon[] = [RUSSIAN].map((lexicon) => ({
  ...lexicon,
  words: [...lexicon.words].sort((a, b) => b[0].length - a[0].length),
}));

/**
 * English words for a query word in another language: `[]` for a filler word, `undefined` when no
 * lexicon knows the word (the caller keeps it as is).
 */
export function translateWord(word: string): string[] | undefined {
  const normalized = word.replace(/ё/g, 'е');
  for (const lexicon of LEXICONS) {
    if (!lexicon.script.test(word)) continue;
    if (lexicon.stop.has(word) || lexicon.stop.has(normalized)) return [];
    const hit = lexicon.words.find(
      ([prefix]) => word.startsWith(prefix) || normalized.startsWith(prefix.replace(/ё/g, 'е')),
    );
    return hit ? hit[1].split(' ') : undefined;
  }
  return undefined;
}
